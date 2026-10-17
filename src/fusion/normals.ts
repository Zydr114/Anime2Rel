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
import { boxMean, gaussianBlur, maskedGaussianBlur } from '@/algo/raster'

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
  const local = boxMean(luma, w, h, Math.max(2, Math.round(Math.max(w, h) / 256)))
  const raw = Float32Array.from(luma, (v, i) => (alpha[i] > 0.5 && v < 0.35 && v < local[i] - 0.08 ? 1 : 0))
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
