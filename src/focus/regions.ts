/**
 * 遮挡区域的栅格化与边缘吸附（docs/Plan.md §3.4 M4 遮挡扩展）。
 *
 * 笔画按文档坐标记录，在不超过 1024 px 的背景缩小图上画出每个区域的覆盖度。
 * 边缘吸附：笔画边缘两侧一定宽度内视为不确定，其中每个像素按颜色更接近附近笔画内侧还是外侧的平均颜色归属，
 * 笔画画出界或没画到边的部分都会贴到背景的边缘上；最后用小半径的彩色引导滤波（He 等，Guided Image Filtering）
 * 去除噪点并保留边缘的过渡。
 */
import type { Size } from '@/algo/geometry'
import { MAX_REGIONS, type BrushStroke, type OcclusionRegion } from './model'

/** 引导图：RGBA8（sRGB），首行在上 */
export interface Guide {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 区域遮罩：RGBA8，首行在上，第 i 个通道是第 i 个区域的覆盖度 */
export interface RegionMask {
  width: number
  height: number
  data: Uint8Array
  /** 各区域的覆盖度 [0,1] */
  masks: Float32Array[]
}

/** 引导滤波的正则项：引导图（[0,1]）局部标准差明显大于 √EPS ≈ 0.03 的边缘会被跟随 */
const EPS = 1e-3

/** 盒式均值滤波，窗口 (2r+1)²，边缘按窗口内实际的像素数归一。 */
export function boxFilter(src: ArrayLike<number>, width: number, height: number, r: number): Float32Array {
  const W = width + 1
  const sum = new Float64Array(W * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += src[y * width + x]
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width, x + r + 1)
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]
      out[y * width + x] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

/** 引导图在半径 r 下的局部统计量，多个区域共用 */
export interface GuideStats {
  width: number
  height: number
  r: number
  /** 三个通道 [0,1] */
  I: Float32Array[]
  mean: Float32Array[]
  /** 协方差 rr, rg, rb, gg, gb, bb */
  cov: Float32Array[]
}

export function guideStats(guide: Guide, r: number): GuideStats {
  const { width, height, data } = guide
  const n = width * height
  const I = [0, 1, 2].map((c) => {
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) ch[i] = data[i * 4 + c] / 255
    return ch
  })
  const mean = I.map((ch) => boxFilter(ch, width, height, r))
  const pairs = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 1],
    [1, 2],
    [2, 2],
  ]
  const cov = pairs.map(([a, b]) => {
    const prod = new Float32Array(n)
    for (let i = 0; i < n; i++) prod[i] = I[a][i] * I[b][i]
    const m = boxFilter(prod, width, height, r)
    for (let i = 0; i < n; i++) m[i] -= mean[a][i] * mean[b][i]
    return m
  })
  return { width, height, r, I, mean, cov }
}

/** 彩色引导滤波：输出在引导图的边缘处跟随边缘，平坦处为输入的局部均值。 */
export function guidedFilter(stats: GuideStats, p: Float32Array, eps = EPS): Float32Array {
  const { width, height, r, I, mean, cov } = stats
  const n = width * height
  const meanP = boxFilter(p, width, height, r)
  const meanIp = I.map((ch) => {
    const prod = new Float32Array(n)
    for (let i = 0; i < n; i++) prod[i] = ch[i] * p[i]
    return boxFilter(prod, width, height, r)
  })
  const a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const cr = meanIp[0][i] - mean[0][i] * meanP[i]
    const cg = meanIp[1][i] - mean[1][i] * meanP[i]
    const cb = meanIp[2][i] - mean[2][i] * meanP[i]
    // (Σ + εE)⁻¹ · cov(I, p)，Σ 对称，按余子式求逆
    const rr = cov[0][i] + eps
    const rg = cov[1][i]
    const rb = cov[2][i]
    const gg = cov[3][i] + eps
    const gb = cov[4][i]
    const bb = cov[5][i] + eps
    const m00 = gg * bb - gb * gb
    const m01 = rb * gb - rg * bb
    const m02 = rg * gb - rb * gg
    const m11 = rr * bb - rb * rb
    const m12 = rb * rg - rr * gb
    const m22 = rr * gg - rg * rg
    const det = rr * m00 + rg * m01 + rb * m02
    const ar = (m00 * cr + m01 * cg + m02 * cb) / det
    const ag = (m01 * cr + m11 * cg + m12 * cb) / det
    const ab = (m02 * cr + m12 * cg + m22 * cb) / det
    a[0][i] = ar
    a[1][i] = ag
    a[2][i] = ab
    b[i] = meanP[i] - ar * mean[0][i] - ag * mean[1][i] - ab * mean[2][i]
  }
  const meanA = a.map((ch) => boxFilter(ch, width, height, r))
  const meanB = boxFilter(b, width, height, r)
  const q = new Float32Array(n)
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, meanA[0][i] * I[0][i] + meanA[1][i] * I[1][i] + meanA[2][i] * I[2][i] + meanB[i]))
  return q
}

/** 区域遮罩的尺寸：与引导图相同；没有引导图时按文档等比缩小到长边不超过 1024 */
export function maskSize(doc: Size, guide: Guide | null): Size {
  if (guide) return { width: guide.width, height: guide.height }
  const k = Math.min(1, 1024 / Math.max(doc.width, doc.height))
  return { width: Math.max(1, Math.round(doc.width * k)), height: Math.max(1, Math.round(doc.height * k)) }
}

/** 把笔画画到 size 大小的覆盖度图上（2D 画布，圆头粗线；橡皮擦除）。 */
export function rasterizeStrokes(strokes: readonly BrushStroke[], doc: Size, size: Size): Float32Array {
  const canvas = new OffscreenCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out = new Float32Array(size.width * size.height)
  if (!ctx) return out
  ctx.scale(size.width / doc.width, size.height / doc.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.fillStyle = ctx.strokeStyle = 'white'
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    const pts = s.points
    if (pts.length < 2) continue
    ctx.beginPath()
    if (pts.length === 2) {
      ctx.arc(pts[0], pts[1], s.radius, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.lineWidth = s.radius * 2
    ctx.moveTo(pts[0], pts[1])
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
    ctx.stroke()
  }
  const img = ctx.getImageData(0, 0, size.width, size.height).data
  for (let i = 0; i < out.length; i++) out[i] = img[i * 4 + 3] / 255
  return out
}

/** 吸附后平滑用的引导滤波半径（遮罩像素） */
export const SMOOTH_RADIUS = 2
/** 笔画内外平均颜色之差（三通道平方和）低于此值时视为附近没有可吸附的边缘 */
const MIN_CONTRAST = 0.003

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 把覆盖度的边缘吸附到引导图的边缘上。
 * @param stats 引导图在 SMOOTH_RADIUS 下的统计量
 * @param band 不确定带的半宽（遮罩像素）：笔画边缘偏离背景边缘不超过这个距离时可以吸附过去
 */
export function snapToEdges(stats: GuideStats, raw: Float32Array, band: number): Float32Array {
  const { width, height, I } = stats
  const n = width * height
  const hard = new Float32Array(n)
  for (let i = 0; i < n; i++) hard[i] = raw[i] >= 0.5 ? 1 : 0
  const near = boxFilter(hard, width, height, band)
  const inside = new Float32Array(n)
  const outside = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    inside[i] = near[i] > 0.999 ? 1 : 0
    outside[i] = near[i] < 0.001 ? 1 : 0
  }
  // 不确定带附近内侧、外侧的平均颜色
  const R = 2 * band
  const wIn = boxFilter(inside, width, height, R)
  const wOut = boxFilter(outside, width, height, R)
  const meanIn = I.map((ch) => boxFilter(ch.map((v, i) => v * inside[i]), width, height, R))
  const meanOut = I.map((ch) => boxFilter(ch.map((v, i) => v * outside[i]), width, height, R))
  const alpha = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (inside[i] || outside[i]) {
      alpha[i] = inside[i]
      continue
    }
    if (wIn[i] < 1e-3 || wOut[i] < 1e-3) {
      alpha[i] = raw[i]
      continue
    }
    let dIn = 0
    let dOut = 0
    let contrast = 0
    for (let c = 0; c < 3; c++) {
      const mIn = meanIn[c][i] / wIn[i]
      const mOut = meanOut[c][i] / wOut[i]
      dIn += (I[c][i] - mIn) ** 2
      dOut += (I[c][i] - mOut) ** 2
      contrast += (mIn - mOut) ** 2
    }
    // 颜色介于两者之间的像素（边缘上的过渡）取中间值，其余明确归到一侧；内外颜色相近（附近没有边缘）时保持笔画原样
    const byColor = smoothstep(0.3, 0.7, dOut / (dIn + dOut + 1e-6))
    alpha[i] = raw[i] + (byColor - raw[i]) * smoothstep(MIN_CONTRAST, 4 * MIN_CONTRAST, contrast)
  }
  return guidedFilter(stats, alpha)
}

/** 吸附范围：笔画半径中位数的一半（遮罩像素），2–16 */
export function snapRadius(strokes: readonly BrushStroke[], doc: Size, size: Size): number {
  const radii = strokes.filter((s) => !s.erase).map((s) => s.radius)
  if (radii.length === 0) return 2
  radii.sort((a, b) => a - b)
  const r = (radii[radii.length >> 1] * size.width) / doc.width / 2
  return Math.min(16, Math.max(2, Math.round(r)))
}

/** 把各区域的覆盖度打包成 RGBA8 */
export function packMasks(masks: readonly Float32Array[], size: Size): RegionMask {
  const data = new Uint8Array(size.width * size.height * 4)
  masks.slice(0, MAX_REGIONS).forEach((m, c) => {
    for (let i = 0; i < m.length; i++) data[i * 4 + c] = Math.round(m[i] * 255)
  })
  return { ...size, data, masks: [...masks] }
}

/** 一组笔画的覆盖度：栅格化笔画，有引导图（SMOOTH_RADIUS 下的统计量）时吸附边缘。局部调整的画笔蒙版也使用它 */
export function strokeCoverage(strokes: readonly BrushStroke[], doc: Size, size: Size, stats: GuideStats | null): Float32Array {
  if (strokes.length === 0) return new Float32Array(size.width * size.height)
  const raw = rasterizeStrokes(strokes, doc, size)
  return stats ? snapToEdges(stats, raw, snapRadius(strokes, doc, size)) : raw
}

/** 区域的覆盖度 */
export const regionCoverage = (region: OcclusionRegion, doc: Size, size: Size, stats: GuideStats | null): Float32Array => strokeCoverage(region.strokes, doc, size, stats)
