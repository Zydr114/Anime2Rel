/** 颜色换算：sRGB 编码与线性值、十六进制颜色、按最大分量归一化。 */
import type { Vec3 } from './sh'

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

/** 把颜色裁剪为非负并按最大分量归一化到 1；全零时返回白色。 */
export function normalizeColor(c: readonly number[]): Vec3 {
  const r = Math.max(0, c[0])
  const g = Math.max(0, c[1])
  const b = Math.max(0, c[2])
  const m = Math.max(r, g, b)
  return m > 1e-9 ? [r / m, g / m, b / m] : [1, 1, 1]
}

/** 线性 RGB → #rrggbb（sRGB）。 */
export function linearToHex(c: Vec3): string {
  return `#${c.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('')}`
}

/** #rrggbb（sRGB）→ 线性 RGB；格式不对时返回 null。 */
export function hexToLinear(hex: string): Vec3 | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)) as Vec3
}
