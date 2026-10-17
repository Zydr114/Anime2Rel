/** 分析分辨率下的场景数据：线性颜色、亮度、过曝、深度、天空和法线。各估计器共用。 */
import { DEFAULT_NORMAL_OPTIONS, depthToNormals } from '@/algo/normals'
import { boxMean, quantiles } from '@/algo/raster'
import { LUMA } from '@/algo/sh'

/** 分析分辨率的长边 */
export const ANALYSIS_MAX_EDGE = 512
/** 任一通道达到该 sRGB 8 位值即视为过曝 */
const CLIP_LEVEL = 250

export interface Scene {
  width: number
  height: number
  fovDeg: number
  /** 线性 RGB（交错） */
  linear: Float32Array
  /** 线性亮度 */
  luma: Float32Array
  /** 过曝像素 */
  clipped: Uint8Array
  /** 归一化逆深度 [0,1]，1 为最近 */
  depth: Float32Array
  /** 天空遮罩 [0,1] */
  sky: Float32Array
  /** 远离边界（3 px 内全是天空）且未过曝的天空像素 */
  skyCore: Uint8Array
  /** 相机空间法线（xyz 交错）与置信度 */
  normal: Float32Array
  confidence: Float32Array
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})

/**
 * @param rgba 分析分辨率的 sRGB 像素
 * @param depth、sky 已缩放到分析分辨率
 */
export function prepareScene(rgba: Uint8ClampedArray, width: number, height: number, depth: Float32Array, sky: Float32Array | null, fovDeg: number): Scene {
  const n = width * height
  const linear = new Float32Array(n * 3)
  const luma = new Float32Array(n)
  const clipped = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = SRGB_TO_LINEAR[rgba[i * 4]]
    const g = SRGB_TO_LINEAR[rgba[i * 4 + 1]]
    const b = SRGB_TO_LINEAR[rgba[i * 4 + 2]]
    linear[i * 3] = r
    linear[i * 3 + 1] = g
    linear[i * 3 + 2] = b
    luma[i] = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
    clipped[i] = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) >= CLIP_LEVEL ? 1 : 0
  }
  const skyMask = sky ?? new Float32Array(n)
  // 法线平滑尺度按长边 1024 设定，这里按分辨率等比缩小
  const k = Math.max(width, height) / 1024
  const options = { ...DEFAULT_NORMAL_OPTIONS, fovDeg, sigmas: DEFAULT_NORMAL_OPTIONS.sigmas.map((s) => Math.max(1, s * k)) }
  const { normal, confidence } = depthToNormals(depth, width, height, options, undefined, skyMask)
  const hard = Float32Array.from(skyMask, (s) => (s > 0.8 ? 1 : 0))
  const skyCore = Uint8Array.from(boxMean(hard, width, height, 3), (v, i) => (v > 0.999 && !clipped[i] ? 1 : 0))
  return { width, height, fovDeg, linear, luma, clipped, depth, sky: skyMask, skyCore, normal, confidence }
}

/** 双线性采样单通道栅格（像素中心坐标）。 */
export function sample(src: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), w - 1)
  const fy = Math.min(Math.max(y - 0.5, 0), h - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const tx = fx - x0
  const ty = fy - y0
  const top = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * tx
  const bottom = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * tx
  return top + (bottom - top) * ty
}

/** 非天空区域亮度 P99 / P50，衡量明暗反差。 */
export function lumaContrast(scene: Scene): number {
  const mask = Uint8Array.from(scene.sky, (s) => (s < 0.5 ? 1 : 0))
  const q = quantiles(scene.luma, [0.5, 0.99], mask) ?? quantiles(scene.luma, [0.5, 0.99])!
  return q[1] / Math.max(q[0], 1e-4)
}
