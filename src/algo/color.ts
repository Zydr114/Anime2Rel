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

/** HSV 颜色（sRGB 空间）：h ∈ [0, 360)，s、v ∈ [0, 1]。 */
export interface Hsv {
  h: number
  s: number
  v: number
}

/** 解析 #rgb、#rrggbb（可省略 #），返回小写的 #rrggbb；格式不对时返回 null。 */
export function parseHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!m) return null
  const d = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return `#${d.toLowerCase()}`
}

/** #rrggbb → HSV；灰色的色相为 0。格式不对时返回 null。 */
export function hexToHsv(hex: string): Hsv | null {
  const p = parseHex(hex)
  if (!p) return null
  const n = parseInt(p.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  return { h: h * 60, s: max > 0 ? d / max : 0, v: max }
}

/** HSV → #rrggbb。 */
export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1))
  }
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
}
