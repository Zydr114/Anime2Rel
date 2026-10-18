/**
 * 全局调色（色彩风格）的参数换算，着色器见 src/engine/finish.ts。
 *
 * 色轮在 sRGB 编码值上逐通道计算：e' = (gain · (e + lift · (1 − e)))^(1/gamma)，
 * 每个色轮的亮度给出三个通道相同的分量，偏色给出亮度为 0 的分量。
 * 分离色调在 Oklab 中按亮度给暗部、亮部加上不同的 (a, b) 偏移，不改变亮度。
 */
import { linearToOklab, oklabToLinear } from '@/algo/oklab'
import type { Vec3 } from '@/algo/sh'
import { LUMA } from './color'
import { isNeutralCreative, type ColorWheel, type CreativeGrade, type Tint } from './model'

/** 各色轮的亮度、偏色满格时的作用量：lift 为编码值的偏移，gamma、gain 为 log2 */
export const LIFT_LUMA = 0.15
export const LIFT_CHROMA = 0.1
export const GAMMA_LUMA = 0.5
export const GAMMA_CHROMA = 0.3
export const GAIN_LUMA = 0.5
export const GAIN_CHROMA = 0.3
/** 分离色调满格时的 Oklab 色度偏移 */
export const SPLIT_CHROMA = 0.06
/** 暗部到亮部的过渡半宽（Oklab L），以及平衡满格时过渡中心的移动量 */
export const SPLIT_WIDTH = 0.3
export const SPLIT_BALANCE = 0.25
/** Oklab L 低于此值时暗部色调逐渐减弱，纯黑保持中性 */
export const SPLIT_BLACK = 0.15

const DEG = Math.PI / 180

const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

/** 色相 → 编码值空间中亮度为 0 的偏色方向，最大分量的绝对值为 1 */
export function hueDirection(hue: number): Vec3 {
  const lin = oklabToLinear(0.7, 0.1 * Math.cos(hue * DEG), 0.1 * Math.sin(hue * DEG))
  const e = lin.map((v) => encode(Math.max(0, v)))
  const y = LUMA[0] * e[0] + LUMA[1] * e[1] + LUMA[2] * e[2]
  const d = e.map((v) => v - y)
  const m = Math.max(...d.map(Math.abs))
  return d.map((v) => v / m) as Vec3
}

const wheelVector = (w: ColorWheel, luma: number, chroma: number): Vec3 => {
  const d = hueDirection(w.hue)
  return d.map((v) => w.luma * luma + w.amount * chroma * v) as Vec3
}

const tintVector = (t: Tint): [number, number] => [t.amount * SPLIT_CHROMA * Math.cos(t.hue * DEG), t.amount * SPLIT_CHROMA * Math.sin(t.hue * DEG)]

export interface CreativeParams {
  active: boolean
  lift: Vec3
  invGamma: Vec3
  gain: Vec3
  /** 暗部、亮部的 Oklab (a, b) 偏移 */
  shadowTint: [number, number]
  highlightTint: [number, number]
  /** 暗部到亮部过渡的中心（Oklab L） */
  pivot: number
}

const cache = new WeakMap<CreativeGrade, CreativeParams>()

export function creativeParams(c: CreativeGrade): CreativeParams {
  const cached = cache.get(c)
  if (cached) return cached
  const params: CreativeParams = {
    active: !isNeutralCreative(c),
    lift: wheelVector(c.wheels.lift, LIFT_LUMA, LIFT_CHROMA),
    invGamma: wheelVector(c.wheels.gamma, GAMMA_LUMA, GAMMA_CHROMA).map((v) => 2 ** -v) as Vec3,
    gain: wheelVector(c.wheels.gain, GAIN_LUMA, GAIN_CHROMA).map((v) => 2 ** v) as Vec3,
    shadowTint: tintVector(c.split.shadow),
    highlightTint: tintVector(c.split.highlight),
    pivot: 0.5 - c.split.balance * SPLIT_BALANCE,
  }
  cache.set(c, params)
  return params
}

/** 色轮（编码值），与着色器一致 */
export function applyWheels(e: Vec3, p: CreativeParams): Vec3 {
  return e.map((v, i) => Math.max(0, p.gain[i] * (v + p.lift[i] * Math.max(0, 1 - v))) ** p.invGamma[i]) as Vec3
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 分离色调（线性 sRGB），与着色器一致 */
export function applySplitToning(c: Vec3, p: CreativeParams): Vec3 {
  const [L, a, b] = linearToOklab(c[0], c[1], c[2])
  const wh = smoothstep(p.pivot - SPLIT_WIDTH, p.pivot + SPLIT_WIDTH, L)
  const ws = (1 - wh) * smoothstep(0, SPLIT_BLACK, L)
  return oklabToLinear(L, a + ws * p.shadowTint[0] + wh * p.highlightTint[0], b + ws * p.shadowTint[1] + wh * p.highlightTint[1]).map((v) => Math.max(0, v)) as Vec3
}

/** 用于界面色块：Oklch 色相的 sRGB 颜色 */
export function hueSwatch(hue: number): string {
  const lin = oklabToLinear(0.72, 0.12 * Math.cos(hue * DEG), 0.12 * Math.sin(hue * DEG))
  return `#${lin.map((v) => Math.round(Math.min(1, encode(Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('')}`
}
