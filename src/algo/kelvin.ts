/** 色温换算：普朗克轨迹色度（Kim et al. 2002 三次近似，1667–25000 K）→ 线性 sRGB。 */
import type { Vec3 } from './sh'

export const MIN_KELVIN = 1667
export const MAX_KELVIN = 25000

/** 色温（K）→ CIE 1931 xy。 */
export function kelvinToXy(kelvin: number): [number, number] {
  const t = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, kelvin))
  const t2 = t * t
  const t3 = t2 * t
  const x = t <= 4000 ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039
  const x2 = x * x
  const x3 = x2 * x
  let y: number
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

/** CIE xy（Y = 1）→ 线性 sRGB（D65）。 */
export function xyToLinearSrgb(x: number, y: number): Vec3 {
  const X = x / y
  const Z = (1 - x - y) / y
  return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z]
}

/** 把颜色裁剪为非负并按最大分量归一化到 1；全零时返回白色。 */
export function normalizeColor(c: readonly number[]): Vec3 {
  const r = Math.max(0, c[0])
  const g = Math.max(0, c[1])
  const b = Math.max(0, c[2])
  const m = Math.max(r, g, b)
  return m > 1e-9 ? [r / m, g / m, b / m] : [1, 1, 1]
}

/** 色温 → 线性 sRGB 光色（最大分量为 1）。 */
export function kelvinToRgb(kelvin: number): Vec3 {
  const [x, y] = kelvinToXy(kelvin)
  return normalizeColor(xyToLinearSrgb(x, y))
}
