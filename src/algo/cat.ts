/**
 * 色适应（von Kries）：在 CAT16 锥响应空间按白点比例缩放，用于把立绘的白点适配到背景的白点。
 * 所有矩阵按行主序存储。
 */
import type { Vec3 } from './sh'

export type Mat3 = number[]

const SRGB_TO_XYZ: Mat3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041]
const XYZ_TO_SRGB: Mat3 = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252]
/** CAT16（Li et al. 2017） */
const CAT16: Mat3 = [0.401288, 0.650173, -0.051461, -0.250268, 1.204414, 0.045854, -0.002079, 0.048952, 0.953127]

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return out
}

export function mat3Vec(m: Mat3, v: readonly number[]): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

export function mat3Inverse(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const k = 1 / det
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]
}

const CAT16_INV = mat3Inverse(CAT16)

/** 颜色的相对亮度（线性 sRGB） */
export function luminance(c: readonly number[]): number {
  return 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2]
}

/**
 * 线性 sRGB 空间中的适配矩阵：把在白点 src 下拍摄/绘制的颜色变换为白点 dst 下的颜色。
 * 白点用线性 sRGB 颜色表示（D65 为 (1,1,1)），只取色度，亮度不变。
 */
export function adaptationMatrix(src: readonly number[], dst: readonly number[]): Mat3 {
  const lms = (w: readonly number[]) => {
    const y = Math.max(1e-6, luminance(w))
    return mat3Vec(CAT16, mat3Vec(SRGB_TO_XYZ, [w[0] / y, w[1] / y, w[2] / y]))
  }
  const s = lms(src)
  const d = lms(dst)
  const scale: Mat3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]]
  return mat3Mul(XYZ_TO_SRGB, mat3Mul(CAT16_INV, mat3Mul(scale, mat3Mul(CAT16, SRGB_TO_XYZ))))
}
