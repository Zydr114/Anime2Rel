/**
 * 立绘融合的统计量（docs/Plan.md §3.3 (1)(4)）：背景白点、局部影调与色度、立绘自身的统计、背景噪声。
 * 都在低分辨率数据上计算，供颜色匹配求参数。
 */
import { nearestKelvin, kelvinToRgb } from '@/algo/kelvin'
import { normalizeColor } from '@/algo/color'
import { boxMean } from '@/algo/raster'
import type { Vec3 } from '@/algo/sh'

/** Oklab 统计：明度分位点、a/b 均值与协方差、色度 P90 */
export interface LabStats {
  /** L 的 P1 / P50 / P99 */
  quantiles: [number, number, number]
  /** a、b 均值 */
  mean: [number, number]
  /** a/b 协方差：aa、ab、bb */
  cov: [number, number, number]
  chromaP90: number
  /** 参与统计的总权重 */
  weight: number
}

const BINS = 1024
const L_MAX = 1.2
const C_MAX = 0.5

function histQuantile(hist: Float64Array, total: number, q: number, max: number): number {
  const target = q * total
  let acc = 0
  for (let i = 0; i < hist.length; i++) {
    const next = acc + hist[i]
    if (next >= target && hist[i] > 0) return ((i + (target - acc) / hist[i]) / hist.length) * max
    acc = next
  }
  return max
}

/** 加权统计；lab 为 Oklab 交错数组。总权重过小时返回 null。 */
export function labStats(lab: Float32Array, weights: ArrayLike<number>): LabStats | null {
  const n = lab.length / 3
  const hl = new Float64Array(BINS)
  const hc = new Float64Array(BINS)
  let sw = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    const L = lab[i * 3]
    const a = lab[i * 3 + 1]
    const b = lab[i * 3 + 2]
    hl[Math.min(BINS - 1, Math.max(0, Math.floor((L / L_MAX) * BINS)))] += w
    hc[Math.min(BINS - 1, Math.floor((Math.hypot(a, b) / C_MAX) * BINS))] += w
    sw += w
    sa += w * a
    sb += w * b
  }
  if (sw < 1e-6) return null
  const ma = sa / sw
  const mb = sb / sw
  let caa = 0
  let cab = 0
  let cbb = 0
  for (let i = 0; i < n; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    const da = lab[i * 3 + 1] - ma
    const db = lab[i * 3 + 2] - mb
    caa += w * da * da
    cab += w * da * db
    cbb += w * db * db
  }
  return {
    quantiles: [histQuantile(hl, sw, 0.01, L_MAX), histQuantile(hl, sw, 0.5, L_MAX), histQuantile(hl, sw, 0.99, L_MAX)],
    mean: [ma, mb],
    cov: [caa / sw, cab / sw, cbb / sw],
    chromaP90: histQuantile(hc, sw, 0.9, C_MAX),
    weight: sw,
  }
}

/**
 * 背景白点：Shades-of-Gray（Finlayson & Trezzi 2004，p 范数），排除过曝和天空。
 * 草地、墙面等大面积有色区域会把估计拉向它们的颜色，所以再向普朗克轨迹上最近的色温收拢 70%。
 * 返回线性 sRGB（最大分量为 1）。
 */
export function whitePoint(linear: Float32Array, mask: ArrayLike<number>, p = 6): Vec3 {
  const sum = [0, 0, 0]
  let count = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    for (let c = 0; c < 3; c++) sum[c] += linear[i * 3 + c] ** p
    count++
  }
  if (count === 0) return [1, 1, 1]
  const sog = normalizeColor(sum.map((s) => (s / count) ** (1 / p)))
  const locus = kelvinToRgb(nearestKelvin(sog, 2000, 12000))
  return normalizeColor(locus.map((v, c) => 0.7 * v + 0.3 * sog[c]))
}

/**
 * 噪声标准差（Immerkær 1996 的拉普拉斯差分核，取中位数绝对值以抵抗边缘），按通道返回，
 * 单位为 sRGB 编码值 [0,1]。只统计梯度较小的一半像素（平坦区域）。
 */
export function noiseSigma(rgb: Float32Array, w: number, h: number): Vec3 {
  const result: number[] = []
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) ch[i] = rgb[i * 3 + c]
    // 平坦程度在平滑后的图上判断，避免与像素级噪声本身相关而低估
    const smooth = boxMean(ch, w, h, 2)
    const resp: number[] = []
    const grad: number[] = []
    for (let y = 2; y < h - 2; y++)
      for (let x = 2; x < w - 2; x++) {
        const v = (dx: number, dy: number) => ch[(y + dy) * w + x + dx]
        const lap = v(-1, -1) - 2 * v(0, -1) + v(1, -1) - 2 * v(-1, 0) + 4 * v(0, 0) - 2 * v(1, 0) + v(-1, 1) - 2 * v(0, 1) + v(1, 1)
        const s = (dx: number, dy: number) => smooth[(y + dy) * w + x + dx]
        resp.push(Math.abs(lap))
        grad.push(Math.abs(s(2, 0) - s(-2, 0)) + Math.abs(s(0, 2) - s(0, -2)))
      }
    if (resp.length === 0) {
      result.push(0)
      continue
    }
    const order = grad.map((g, i) => [g, i]).sort((a, b) => a[0] - b[0])
    const flat = order.slice(0, Math.max(1, order.length >> 1)).map(([, i]) => resp[i])
    flat.sort((a, b) => a - b)
    // 白噪声经过该核后标准差放大 6 倍；|N(0,σ)| 的中位数为 0.6745σ
    result.push(flat[flat.length >> 1] / 0.6745 / 6)
  }
  return result as Vec3
}

/** 地面取色至少需要的像素数：太少说明接地点不在地面上（水中、空中、被挡住） */
const GROUND_MIN_PIXELS = 40

export interface GroundSampleInput {
  /** 统计分辨率下的线性 RGB */
  linear: Float32Array
  /** 同一网格上的归一化逆深度与天空遮罩 */
  depth: Float32Array | null
  sky: Float32Array | null
  width: number
  height: number
  /** 背景位图的尺寸（像素），接地点、半径与焦距都按它给出 */
  size: { width: number; height: number }
  point: { x: number; y: number }
  plane: Vec3
  up: Vec3
  radius: number
  tolerance: number
  depthScale: { a: number; b: number; far: number }
  focal: number
}

/**
 * 接地点周围地面的平均颜色（线性）：只取三维位置离地面平面不超过 tolerance、不是天空、
 * 深度有效的像素。取样区域是接地点周围 radius 的椭圆（与统计网格的宽高比一致）。
 * 像素太少时返回 null，交给调用方当作没有地面。
 */
export function sampleGroundColor(input: GroundSampleInput): Vec3 | null {
  const { width, height, size, linear, depth, sky } = input
  if (!depth) return null
  const kx = width / size.width
  const ky = height / size.height
  const cx = input.point.x * kx
  const cy = input.point.y * ky
  const rx = Math.max(0.5, input.radius * kx)
  const ry = Math.max(0.5, input.radius * ky)
  const halfW = size.width / 2
  const halfH = size.height / 2
  const { a, b, far } = input.depthScale
  const color = [0, 0, 0]
  let count = 0
  const y0 = Math.max(0, Math.floor(cy - ry))
  const y1 = Math.min(height - 1, Math.ceil(cy + ry))
  const x0 = Math.max(0, Math.floor(cx - rx))
  const x1 = Math.min(width - 1, Math.ceil(cx + rx))
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx
      if (dx * dx + dy * dy > 1) continue
      const i = y * width + x
      if (sky && sky[i] > 0.5) continue
      const inv = a * depth[i] + b
      const z = 1 / inv
      if (!(inv > 0) || z > far) continue
      // 统计网格的像素中心换算回背景位图的像素，再按针孔相机重建三维位置
      const px = (x + 0.5) / kx
      const py = (y + 0.5) / ky
      const X = ((px - halfW) / input.focal) * z
      const Y = ((halfH - py) / input.focal) * z
      const h = (X - input.plane[0]) * input.up[0] + (Y - input.plane[1]) * input.up[1] + (-z - input.plane[2]) * input.up[2]
      if (Math.abs(h) > input.tolerance) continue
      for (let c = 0; c < 3; c++) color[c] += linear[i * 3 + c]
      count++
    }
  }
  return count >= GROUND_MIN_PIXELS ? ((color.map((v) => v / count)) as Vec3) : null
}
