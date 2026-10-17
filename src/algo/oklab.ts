/**
 * Oklab（Björn Ottosson 2020）：感知均匀的颜色空间，L 为明度，a/b 为对立色。
 * 矩阵按行主序导出，着色器中的实现（src/engine/fusion.ts）使用同一组系数。
 */
import type { Vec3 } from './sh'

/** 线性 sRGB → LMS */
export const OKLAB_M1 = [0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566, 0.0883024619, 0.2817188376, 0.6299787005]
/** LMS^(1/3) → Lab */
export const OKLAB_M2 = [0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099, 0.0259040371, 0.7827717662, -0.808675766]
/** Lab → LMS^(1/3) */
export const OKLAB_M2_INV = [1, 0.3963377774, 0.2158037573, 1, -0.1055613458, -0.0638541728, 1, -0.0894841775, -1.291485548]
/** LMS → 线性 sRGB */
export const OKLAB_M1_INV = [4.0767416621, -3.3077115913, 0.2309699292, -1.2684380046, 2.6097574011, -0.3413193965, -0.0041960863, -0.7034186147, 1.707614701]

function mul(m: readonly number[], x: number, y: number, z: number): Vec3 {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
}

export function linearToOklab(r: number, g: number, b: number): Vec3 {
  const [l, m, s] = mul(OKLAB_M1, r, g, b)
  return mul(OKLAB_M2, Math.cbrt(l), Math.cbrt(m), Math.cbrt(s))
}

export function oklabToLinear(L: number, a: number, b: number): Vec3 {
  const [l, m, s] = mul(OKLAB_M2_INV, L, a, b)
  return mul(OKLAB_M1_INV, l * l * l, m * m * m, s * s * s)
}

/** 线性 RGB 交错数组 → Oklab 交错数组 */
export function oklabImage(linear: Float32Array): Float32Array {
  const out = new Float32Array(linear.length)
  for (let i = 0; i < linear.length; i += 3) {
    const lab = linearToOklab(linear[i], linear[i + 1], linear[i + 2])
    out[i] = lab[0]
    out[i + 1] = lab[1]
    out[i + 2] = lab[2]
  }
  return out
}
