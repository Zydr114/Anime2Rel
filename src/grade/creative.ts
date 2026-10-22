/**
 * 全局调色（色彩风格）的参数换算，着色器见 src/engine/finish.ts。
 *
 * 色轮在 sRGB 编码值上逐通道计算：e' = (gain · (e + lift · (1 − e)))^(1/gamma)，
 * 每个色轮的亮度给出三个通道相同的分量，偏色给出亮度为 0 的分量。
 * 分离色调在 Oklab 中按亮度给暗部、亮部加上不同的 (a, b) 偏移，不改变亮度。
 * 混色层按 W3C 混合模式在编码值上叠加；颜色来自一张查找表，每层一行（纯色为常数行，渐变映射按底图亮度取色）。
 */
import { linearToOklab, oklabToLinear } from '@/algo/oklab'
import type { Vec3 } from '@/algo/sh'
import { LUMA } from './color'
import { BLEND_MODES, isNeutralCreative, MAX_BLEND_LAYERS, type BlendLayer, type ColorWheel, type CreativeGrade, type Tint } from './model'

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
/** 混色层颜色查找表的长度 */
export const RAMP_SIZE = 256
/** 亮度蒙版边缘的柔化半宽 */
export const MASK_FEATHER = 0.1
/** W3C 混合模式中非分离模式使用的亮度系数 */
export const BLEND_LUMA: Vec3 = [0.3, 0.59, 0.11]

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
  /** 使用的 LUT（登记表 id）与强度；没有 LUT 或强度为 0 时为 null */
  lut: { id: string; intensity: number } | null
  /** 各混色层：混合模式序号、不透明度、蒙版下限、上限；不足 MAX_BLEND_LAYERS 时其余层不透明度为 0 */
  layers: [number, number, number, number][]
  /** RAMP_SIZE × MAX_BLEND_LAYERS × RGBA 的编码值，每层一行 */
  ramp: Float32Array
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
    lut: c.lut && c.lutIntensity > 0 ? { id: c.lut.id, intensity: c.lutIntensity } : null,
    layers: Array.from({ length: MAX_BLEND_LAYERS }, (_, i) => {
      const l = c.layers[i]
      return l ? [BLEND_MODES.indexOf(l.mode), l.opacity, l.maskLow, l.maskHigh] : [0, 0, 0, 1]
    }),
    ramp: blendRamp(c.layers),
  }
  cache.set(c, params)
  return params
}

/** sRGB 十六进制颜色 → 编码值 */
export const hexToEncoded = (hex: string): Vec3 => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const v = m ? parseInt(m[1], 16) : 0
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** 一层的颜色：纯色为常数；渐变映射的颜色在编码值上线性插值（与 CSS linear-gradient 的预览一致） */
export function layerColor(layer: BlendLayer, x: number): Vec3 {
  if (layer.kind === 'color') return hexToEncoded(layer.color)
  const stops = layer.gradient.map(hexToEncoded)
  const p = Math.min(1, Math.max(0, x)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(p))
  const t = p - i
  return stops[i].map((v, c) => v * (1 - t) + stops[i + 1][c] * t) as Vec3
}

function blendRamp(layers: readonly BlendLayer[]): Float32Array {
  const data = new Float32Array(RAMP_SIZE * MAX_BLEND_LAYERS * 4)
  layers.slice(0, MAX_BLEND_LAYERS).forEach((layer, row) => {
    for (let i = 0; i < RAMP_SIZE; i++) data.set([...layerColor(layer, i / (RAMP_SIZE - 1)), 1], (row * RAMP_SIZE + i) * 4)
  })
  return data
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
