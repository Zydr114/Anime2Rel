/**
 * 立绘法线（docs/Plan.md §3.3 (2)）：N = normalize(w₁·N_depth + w₂·N_inflate + w₃·N_detail)。
 *
 * - N_depth：深度模型给出的法线（按置信度加权）。
 * - N_inflate：alpha 的欧氏距离变换按枕形剖面 h = √(d·(2R − d)) 膨胀成高度场，轮廓处法线贴近像平面。
 * - N_detail：边缘保持平滑后的亮度当作小幅凹凸；线稿处不参与，避免线条被浮雕化。
 *
 * 坐标与背景法线一致：x 向右、y 向上、z 指向相机。
 */
import { distanceTransform } from '@/algo/edt'
import { guidedFilter } from '@/algo/guidedFilter'
import { boxMean, gaussianBlur, maskedGaussianBlur, resizeBilinear } from '@/algo/raster'

export interface NormalWeights {
  depth: number
  inflate: number
  detail: number
}

export const DEFAULT_NORMAL_WEIGHTS: NormalWeights = { depth: 0.5, inflate: 0.4, detail: 0.1 }
/** 膨胀半径相对立绘长边的默认比例 */
export const DEFAULT_INFLATE_RADIUS = 0.05
/** 距离场的平滑尺度（像素） */
const INFLATE_SMOOTH = 1.2

export interface CharacterPixels {
  width: number
  height: number
  /** sRGB 编码的 RGB 交错 [0,1]（直通 alpha） */
  rgb: Float32Array
  alpha: Float32Array
}

/** 由高度场（像素单位，图像 y 向下）求法线。 */
function heightToNormals(height: Float32Array, w: number, h: number, scale: number, out: Float32Array): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const dx = (height[y * w + Math.min(w - 1, x + 1)] - height[y * w + Math.max(0, x - 1)]) / 2
      const dy = (height[Math.min(h - 1, y + 1) * w + x] - height[Math.max(0, y - 1) * w + x]) / 2
      const nx = -dx * scale
      // 图像 y 向下，法线 y 向上
      const ny = dy * scale
      const len = Math.hypot(nx, ny, 1)
      out[i * 3] = nx / len
      out[i * 3 + 1] = ny / len
      out[i * 3 + 2] = 1 / len
    }
}

/** 枕形膨胀的高度场：到透明区域的距离 d，h = √(d·(2R − d))（d ≥ R 时为 R）。 */
export function inflateHeight(alpha: Float32Array, w: number, h: number, radius: number): Float32Array {
  const raw = distanceTransform(Uint8Array.from(alpha, (a) => (a > 0.5 ? 1 : 0)), w, h)
  const r = Math.max(1, radius)
  // 二值化后的斜边是台阶状的，距离有半像素的起伏，经过陡峭的剖面会变成条纹，先轻微平滑
  const dist = gaussianBlur(Float32Array.from(raw, (d) => Math.min(d, 2 * r)), w, h, INFLATE_SMOOTH)
  return Float32Array.from(dist, (d, i) => {
    if (raw[i] === 0) return 0
    // 像素中心到边界约有半个像素
    const t = Math.min(r, Math.max(0, d - 0.5))
    return Math.sqrt(t * (2 * r - t))
  })
}

export function inflateNormals(alpha: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(w * h * 3)
  heightToNormals(inflateHeight(alpha, w, h, radius), w, h, 1, out)
  return out
}

/** 线稿遮罩：明显暗于周围且本身较暗的细线（1 表示线稿）。 */
export function lineArtMask(luma: Float32Array, alpha: Float32Array, w: number, h: number): Float32Array {
  // 周围的亮度只统计不透明像素，否则透明区域会拉低外描边处的均值，外描边大多检测不到
  const r = Math.max(2, Math.round(Math.max(w, h) / 256))
  const opaque = Float32Array.from(alpha, (a) => (a > 0.5 ? 1 : 0))
  const sum = boxMean(Float32Array.from(luma, (v, i) => v * opaque[i]), w, h, r)
  const count = boxMean(opaque, w, h, r)
  const raw = Float32Array.from(luma, (v, i) => (opaque[i] && v < 0.35 && v < sum[i] / count[i] - 0.08 ? 1 : 0))
  // 膨胀 1 像素，覆盖线条的抗锯齿边
  return Float32Array.from(boxMean(raw, w, h, 1), (v) => (v > 0 ? 1 : 0))
}

/** 细节凹凸：边缘保持平滑后的亮度，线稿处用周围的值填充。 */
export function detailNormals(px: CharacterPixels, line: Float32Array, strength: number): Float32Array {
  const { width: w, height: h, rgb } = px
  const luma = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) luma[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]
  const smooth = guidedFilter(rgb, luma, w, h, { radius: 2, eps: 4e-3 })
  const keep = Float32Array.from(line, (v, i) => (1 - v) * (px.alpha[i] > 0.5 ? 1 : 0))
  const filled = maskedGaussianBlur(smooth, keep, w, h, 2)
  const height = Float32Array.from(smooth, (v, i) => (keep[i] ? v : filled[i]))
  const out = new Float32Array(w * h * 3)
  // 亮度差 1 对应约 strength 像素的高度
  heightToNormals(height, w, h, strength, out)
  return out
}

export interface NormalMapInput extends CharacterPixels {
  /** 深度模型的法线 RGBA8（rgb = n·0.5 + 0.5，a = 置信度），尺寸与像素一致；没有深度结果时为 null */
  depthNormal: Uint8Array | null
  weights: NormalWeights
  /** 膨胀半径（像素） */
  inflateRadius: number
}

/**
 * 混合三路法线，输出 RGBA8：rgb = n·0.5 + 0.5，a = 1 − 线稿遮罩（着色器用它避免给线稿加轮廓光）。
 */
export function characterNormals(input: NormalMapInput): Uint8Array {
  const { width: w, height: h, alpha, weights } = input
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * input.rgb[i * 3] + 0.7152 * input.rgb[i * 3 + 1] + 0.0722 * input.rgb[i * 3 + 2]
  const line = lineArtMask(luma, alpha, w, h)
  const inflate = weights.inflate > 0 ? inflateNormals(alpha, w, h, input.inflateRadius) : null
  const detail = weights.detail > 0 ? detailNormals(input, line, Math.max(w, h) / 64) : null
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    let x = 0
    let y = 0
    let z = 1e-3
    if (input.depthNormal && weights.depth > 0) {
      const k = weights.depth * (input.depthNormal[i * 4 + 3] / 255)
      x += k * (input.depthNormal[i * 4] / 127.5 - 1)
      y += k * (input.depthNormal[i * 4 + 1] / 127.5 - 1)
      z += k * (input.depthNormal[i * 4 + 2] / 127.5 - 1)
    }
    if (inflate) {
      x += weights.inflate * inflate[i * 3]
      y += weights.inflate * inflate[i * 3 + 1]
      z += weights.inflate * inflate[i * 3 + 2]
    }
    if (detail) {
      x += weights.detail * detail[i * 3]
      y += weights.detail * detail[i * 3 + 1]
      z += weights.detail * detail[i * 3 + 2]
    }
    const len = Math.hypot(x, y, z)
    out[i * 4] = Math.round((x / len) * 127.5 + 127.5)
    out[i * 4 + 1] = Math.round((y / len) * 127.5 + 127.5)
    out[i * 4 + 2] = Math.round((z / len) * 127.5 + 127.5)
    out[i * 4 + 3] = Math.round((1 - line[i]) * 255)
  }
  return out
}

/** 轮廓光边缘带的最大宽度，相对立绘长边 */
export const RIM_WIDTH = 0.02
/** 边缘带宽度相对局部半宽的比例：发丝、手臂这类细的部位，边缘带相应变窄，不会整条被照亮 */
export const RIM_THICKNESS_RATIO = 0.2
/** 外描边粗细的上限，相对立绘长边 */
const OUTLINE_WIDTH = 0.006
/** 求局部半宽的网格长边上限，半宽变化平缓，不需要全分辨率 */
const HALF_WIDTH_EDGE = 512

/**
 * 局部半宽：包含该像素、且完全落在剪影内的最大圆的半径（像素），只区分 [minRadius, maxRadius] 之间的值。
 * 半径按 √2 倍分级：圆心取到边界距离不小于半径的像素，再按半径向外扩张。
 */
export function localHalfWidth(dist: Float32Array, w: number, h: number, minRadius: number, maxRadius: number): Float32Array {
  const out = Float32Array.from(dist, (d) => Math.min(d, minRadius))
  for (let r = minRadius; r < maxRadius * Math.SQRT2; r *= Math.SQRT2) {
    const level = Math.min(r, maxRadius)
    const far = distanceTransform(Uint8Array.from(dist, (d) => (d >= level ? 0 : 1)), w, h)
    let covered = false
    for (let i = 0; i < out.length; i++)
      if (dist[i] > 0 && far[i] <= level) {
        out[i] = level
        covered = true
      }
    if (!covered) break
  }
  return out
}

/**
 * 轮廓光的边缘带（RGBA8）：r = 到剪影边缘的距离 / 边缘带宽度，g = (1 − 线稿)·alpha，b = alpha，
 * a = 到剪影边缘的距离 / (RIM_WIDTH·长边)。
 * 距离从外描边的内侧算起，边缘带宽度取 min(RIM_WIDTH·长边, RIM_THICKNESS_RATIO·局部半宽)。
 * 着色器按 mipmap 采样，g / b 是采样范围内不透明部分中非线稿的比例：立绘缩得很小时，描边也不会被轮廓光照亮。
 */
export function rimMap(px: CharacterPixels): Uint8Array {
  const { width: w, height: h, alpha } = px
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * px.rgb[i * 3] + 0.7152 * px.rgb[i * 3 + 1] + 0.0722 * px.rgb[i * 3 + 2]
  const line = lineArtMask(luma, alpha, w, h)
  const inside = Float32Array.from(alpha, (a) => (a > 0.5 ? 1 : 0))
  const dist = distanceTransform(inside, w, h)
  const maxWidth = Math.max(1, RIM_WIDTH * Math.max(w, h))
  // 边缘带从外描边的内侧算起：描边粗细不同，亮边都紧贴在描边里面
  const outline = Math.max(2, OUTLINE_WIDTH * Math.max(w, h))
  const inner = distanceTransform(Uint8Array.from(inside, (v, i) => (v && !(line[i] > 0 && dist[i] <= outline) ? 1 : 0)), w, h)

  const k = Math.max(1, Math.max(w, h) / HALF_WIDTH_EDGE)
  const sw = Math.max(1, Math.round(w / k))
  const sh = Math.max(1, Math.round(h / k))
  const smallInside = Float32Array.from(resizeBilinear(inside, w, h, sw, sh), (v) => (v > 0.5 ? 1 : 0))
  const smallHalf = localHalfWidth(distanceTransform(smallInside, sw, sh), sw, sh, 1 / RIM_THICKNESS_RATIO / k, maxWidth / RIM_THICKNESS_RATIO / k)
  // 分级的半宽是阶梯状的，平滑后边缘带宽度连续变化
  const half = resizeBilinear(maskedGaussianBlur(smallHalf, smallInside, sw, sh, 1), sw, sh, w, h)

  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const width = Math.max(1, Math.min(maxWidth, RIM_THICKNESS_RATIO * k * half[i]))
    // 像素中心到边界约有半个像素
    const t = inner[i] > 0 ? Math.min(1, Math.max(0, inner[i] - 0.5) / width) : 0
    out[i * 4] = Math.round(t * 255)
    out[i * 4 + 1] = Math.round((1 - line[i]) * alpha[i] * 255)
    out[i * 4 + 2] = Math.round(alpha[i] * 255)
    out[i * 4 + 3] = Math.round(Math.min(1, dist[i] / maxWidth) * 255)
  }
  return out
}
