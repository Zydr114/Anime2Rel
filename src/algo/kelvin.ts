/** 色温换算：普朗克轨迹色度（Kim et al. 2002 三次近似，1667–25000 K）→ 线性 sRGB。 */
import { normalizeColor } from './color'
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

/** 色温 → 线性 sRGB 光色（最大分量为 1）。 */
export function kelvinToRgb(kelvin: number): Vec3 {
  const [x, y] = kelvinToXy(kelvin)
  return normalizeColor(xyToLinearSrgb(x, y))
}

function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3
  return [(4 * x) / d, (6 * y) / d]
}

/**
 * 线性 sRGB 颜色在普朗克轨迹上最近的色温（CIE 1960 uv 距离），结果限制在 [min, max]。
 * 用于把估计出的光色约束为“自然光”颜色：保留冷暖，去掉偏绿/偏品红的成分。
 */
export function nearestKelvin(rgb: readonly number[], min = MIN_KELVIN, max = MAX_KELVIN): number {
  const [r, g, b] = rgb.map((v) => Math.max(0, v))
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b
  const sum = X + Y + Z
  if (sum <= 1e-9) return 6500
  const [u, v] = xyToUv(X / sum, Y / sum)
  const dist = (t: number) => {
    const [tu, tv] = xyToUv(...kelvinToXy(t))
    return (tu - u) ** 2 + (tv - v) ** 2
  }
  // 倒数色温（mired）上均匀粗搜，再在相邻格内细化
  const lo = 1e6 / max
  const hi = 1e6 / min
  const steps = 64
  let best = 0
  let bestD = Infinity
  for (let i = 0; i <= steps; i++) {
    const d = dist(1e6 / (lo + ((hi - lo) * i) / steps))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  let a = lo + ((hi - lo) * Math.max(0, best - 1)) / steps
  let c = lo + ((hi - lo) * Math.min(steps, best + 1)) / steps
  for (let k = 0; k < 30; k++) {
    const m1 = a + (c - a) / 3
    const m2 = c - (c - a) / 3
    if (dist(1e6 / m1) < dist(1e6 / m2)) c = m2
    else a = m1
  }
  return 1e6 / ((a + c) / 2)
}
