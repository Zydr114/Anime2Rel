/**
 * 基础调整的颜色运算（docs/Plan.md §3.5）。着色器实现见 src/engine/grade.ts，两边使用同一组公式和常数。
 * 这里的逐像素版本用于测试，并生成着色器的统一量（白平衡矩阵、曲线查找表）。
 *
 * 逐像素部分的顺序：白平衡与曝光 →（局部：高光、阴影、清晰度）→ 对比度 → 白色、黑色 → HSL → 自然饱和度 → 饱和度 → 曲线 →（局部：锐化）。
 */
import { IDENTITY3, mat3Inverse, mat3Mul, mat3Vec, SRGB_TO_XYZ, XYZ_TO_SRGB, type Mat3 } from '@/algo/cat'
import { srgbToLinear } from '@/algo/color'
import { evalCurve, monotoneCurve } from '@/algo/curve'
import { kelvinToXy } from '@/algo/kelvin'
import { linearToOklab, oklabToLinear } from '@/algo/oklab'
import type { Vec3 } from '@/algo/sh'
import { CURVE_CHANNELS, type CurveChannel, type CurvePoints } from './model'

// ── 白平衡：Bradford 色适应 ──

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]
const BRADFORD_INV = mat3Inverse(BRADFORD)
/** 色温为 0 时的参考白点：普朗克轨迹上 6504 K（与 D65 相近），色温、色调都为 0 时矩阵是单位阵 */
const REFERENCE_KELVIN = 6504
/** 色温满格时的倒数色温偏移（mired）：+1 约为 3940 K，−1 约为 18600 K */
export const TEMPERATURE_MIRED = 100
/** 色调满格时垂直于普朗克轨迹的偏移（CIE 1960 uv） */
export const TINT_UV = 0.02

const xyToUv = (x: number, y: number): [number, number] => {
  const d = -2 * x + 12 * y + 3
  return [(4 * x) / d, (6 * y) / d]
}
const uvToXy = (u: number, v: number): [number, number] => {
  const d = 2 * u - 8 * v + 4
  return [(3 * u) / d, (2 * v) / d]
}
const xyToXyz = (x: number, y: number): Vec3 => [x / y, 1, (1 - x - y) / y]

/** 色温、色调 → 适配的目标白点（xy）。正的色温偏暖（白点移向低色温），正的色调偏品红（白点移到轨迹下方）。 */
export function adjustedWhite(temperature: number, tint: number): [number, number] {
  const mired = 1e6 / REFERENCE_KELVIN + temperature * TEMPERATURE_MIRED
  const [u, v] = xyToUv(...kelvinToXy(1e6 / mired))
  // 轨迹的切线取数值导数，法线朝向轨迹上方（偏绿）
  const [u0, v0] = xyToUv(...kelvinToXy(1e6 / (mired - 1)))
  const [u1, v1] = xyToUv(...kelvinToXy(1e6 / (mired + 1)))
  const len = Math.hypot(u1 - u0, v1 - v0)
  let nu = -(v1 - v0) / len
  let nv = (u1 - u0) / len
  if (nv < 0) {
    nu = -nu
    nv = -nv
  }
  return uvToXy(u - tint * TINT_UV * nu, v - tint * TINT_UV * nv)
}

/** 白平衡矩阵（线性 sRGB，行主序）：从参考白点适配到目标白点，白色的亮度不变 */
export function whiteBalanceMatrix(temperature: number, tint: number): Mat3 {
  if (temperature === 0 && tint === 0) return IDENTITY3
  const src = mat3Vec(BRADFORD, xyToXyz(...kelvinToXy(REFERENCE_KELVIN)))
  const dst = mat3Vec(BRADFORD, xyToXyz(...adjustedWhite(temperature, tint)))
  const scale: Mat3 = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]]
  return mat3Mul(XYZ_TO_SRGB, mat3Mul(BRADFORD_INV, mat3Mul(scale, mat3Mul(BRADFORD, SRGB_TO_XYZ))))
}

// ── 对比度：以 18% 中灰为支点，在 log2 空间做端点固定的 S 形 ──

export const MID_GRAY = 0.18
/** 白点、黑点相对中灰的档数：白点为线性 1.0，黑点约为 0.0007 */
export const WHITE_STOPS = Math.log2(1 / MID_GRAY)
export const BLACK_STOPS = 8
/** 对比度 [-1,1] → 三次 S 形的系数；|k| ≤ 0.5 时曲线单调 */
export const CONTRAST_STRENGTH = 0.5

/**
 * y = log2(c / 中灰)。端点之内为 y + k·y·(1 − (y/端点)²)，端点处不动；
 * 白点以上按端点处的斜率 1 − 2k 延伸，黑点以下不变。
 */
export function contrastCurve(y: number, k: number): number {
  const end = y >= 0 ? WHITE_STOPS : BLACK_STOPS
  const t = y / end
  if (t > 1) return WHITE_STOPS + (1 - 2 * k) * (y - WHITE_STOPS)
  if (t < -1) return y
  return y + k * y * (1 - t * t)
}

export function applyContrast(c: number, contrast: number): number {
  const k = contrast * CONTRAST_STRENGTH
  if (k === 0) return c
  return MID_GRAY * 2 ** contrastCurve(Math.log2(Math.max(c, 1e-6) / MID_GRAY), k)
}

// ── 白色、黑色：显示空间中对亮部、暗部的平移 ──

export const WHITES_RANGE = 0.2
export const BLACKS_RANGE = 0.1

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** e 为 sRGB 编码值；斜率最小为 1 − 3 × 范围，保持单调 */
export function applyWhitesBlacks(e: number, whites: number, blacks: number): number {
  return e + whites * WHITES_RANGE * smoothstep(0.5, 1, e) + blacks * BLACKS_RANGE * (1 - smoothstep(0, 0.5, e))
}

// ── HSL 与饱和度：Oklch ──

/** 各色相段中心色的 sRGB 编码值：红、橙、黄、绿、青、蓝、紫、品红 */
const BAND_COLORS: readonly Vec3[] = [
  [1, 0, 0],
  [1, 0.5, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
  [0.5, 0, 1],
  [1, 0, 1],
]

const DEG = Math.PI / 180

/** Oklch 色相（度，[0,360)） */
export function oklchHue(lab: readonly number[]): number {
  const h = Math.atan2(lab[2], lab[1]) / DEG
  return h < 0 ? h + 360 : h
}

/** 各色相段中心（Oklch 色相，度，递增） */
export const HSL_CENTERS: readonly number[] = BAND_COLORS.map((c) => oklchHue(linearToOklab(...(c.map(srgbToLinear) as Vec3))))
/** 各色相段到前一段、后一段中心的色相差（度） */
export const HSL_SPANS: readonly [number, number][] = HSL_CENTERS.map((c, i) => {
  const n = HSL_CENTERS.length
  const prev = HSL_CENTERS[(i + n - 1) % n]
  const next = HSL_CENTERS[(i + 1) % n]
  return [(c - prev + 360) % 360, (next - c + 360) % 360]
})

/** 色相差 a − b，折算到 (−180, 180] */
export function hueDelta(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180
  return d === -180 ? 180 : d
}

/** 色相 h 在各色相段上的权重：相邻两段之间平滑过渡，权重之和为 1 */
export function hslWeights(h: number): number[] {
  return HSL_CENTERS.map((c, i) => {
    const d = hueDelta(h, c)
    const [before, after] = HSL_SPANS[i]
    const t = d < 0 ? -d / before : d / after
    return 1 - smoothstep(0, 1, t)
  })
}

/** HSL 满格时的色相偏移（度）与明度缩放 */
export const HSL_HUE_RANGE = 30
export const HSL_LUMINANCE_RANGE = 0.3
/** 色度低于此范围的颜色（接近灰色）不调整明度 */
export const HSL_CHROMA_EDGE: [number, number] = [0.01, 0.06]
/** 自然饱和度：色度高于此值的颜色基本不再增加；肤色色相（Oklch）与保护范围 */
export const VIBRANCE_CHROMA = 0.2
export const SKIN_HUE = 55
export const SKIN_RANGE: [number, number] = [15, 35]
export const SKIN_PROTECT = 0.7

export interface HslAdjust {
  hue: readonly number[]
  saturation: readonly number[]
  luminance: readonly number[]
}

/** Oklab 中的 HSL、自然饱和度与饱和度调整 */
export function applyColorAdjust(lab: Vec3, hsl: HslAdjust, vibrance: number, saturation: number): Vec3 {
  const [L, a, b] = lab
  const C = Math.hypot(a, b)
  const h = oklchHue(lab)
  const w = hslWeights(h)
  const sum = (values: readonly number[]) => w.reduce((acc, wi, i) => acc + wi * values[i], 0)
  const chromaWeight = smoothstep(HSL_CHROMA_EDGE[0], HSL_CHROMA_EDGE[1], C)
  const h2 = h + sum(hsl.hue) * HSL_HUE_RANGE
  let C2 = C * Math.max(0, 1 + sum(hsl.saturation))
  const L2 = L * (1 + sum(hsl.luminance) * HSL_LUMINANCE_RANGE * chromaWeight)
  const skin = 1 - smoothstep(SKIN_RANGE[0], SKIN_RANGE[1], Math.abs(hueDelta(h2, SKIN_HUE)))
  const vib = vibrance > 0 ? vibrance * (1 - smoothstep(0, VIBRANCE_CHROMA, C2)) * (1 - SKIN_PROTECT * skin) : vibrance
  C2 *= Math.max(0, 1 + vib) * Math.max(0, 1 + saturation)
  return [L2, C2 * Math.cos(h2 * DEG), C2 * Math.sin(h2 * DEG)]
}

// ── 曲线：单调三次样条烘焙成查找表 ──

/** 曲线查找表的长度 */
export const CURVE_SIZE = 256

export interface CurveLut {
  /** CURVE_SIZE × RGBA，rgb 为各通道“主曲线 → 单通道曲线”的结果 */
  data: Float32Array
  /** 查找表末端的斜率，超出 1 的值按它线性延伸 */
  slope: Vec3
}

function spline(points: CurvePoints) {
  return monotoneCurve(
    points.map((p) => p[0]),
    points.map((p) => p[1]),
  )
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function curveLut(curves: Record<CurveChannel, CurvePoints>): CurveLut {
  const [master, r, g, b] = CURVE_CHANNELS.map((c) => spline(curves[c]))
  const data = new Float32Array(CURVE_SIZE * 4)
  for (let i = 0; i < CURVE_SIZE; i++) {
    const m = clamp01(evalCurve(master, i / (CURVE_SIZE - 1)))
    data[i * 4] = clamp01(evalCurve(r, m))
    data[i * 4 + 1] = clamp01(evalCurve(g, m))
    data[i * 4 + 2] = clamp01(evalCurve(b, m))
    data[i * 4 + 3] = 1
  }
  const end = (c: number) => (data[(CURVE_SIZE - 1) * 4 + c] - data[(CURVE_SIZE - 2) * 4 + c]) * (CURVE_SIZE - 1)
  return { data, slope: [end(0), end(1), end(2)] }
}

/** 按查找表映射一个编码值（线性插值，与 GPU 的纹理过滤一致） */
export function sampleCurve(lut: CurveLut, e: number, channel: number): number {
  if (e > 1) return lut.data[(CURVE_SIZE - 1) * 4 + channel] + (e - 1) * lut.slope[channel]
  const x = Math.max(0, e) * (CURVE_SIZE - 1)
  const i = Math.min(CURVE_SIZE - 2, Math.floor(x))
  const t = x - i
  return lut.data[i * 4 + channel] * (1 - t) + lut.data[(i + 1) * 4 + channel] * t
}

// ── 逐像素参考实现（不含局部调整）──

export interface PointAdjust {
  /** 白平衡矩阵乘以曝光增益 */
  wb: Mat3
  contrast: number
  whites: number
  blacks: number
  hsl: HslAdjust
  vibrance: number
  saturation: number
  curve: CurveLut | null
}

/** sRGB 编码，不裁剪超过 1 的值（与着色器中的 srgbEncode 一致） */
const encode = (v: number) => {
  const c = Math.max(0, v)
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

/** 线性 sRGB 颜色 → 调整后的线性 sRGB 颜色 */
export function adjustPixel(rgb: Vec3, p: PointAdjust): Vec3 {
  let c = mat3Vec(p.wb, rgb).map((v) => Math.max(0, v))
  c = c.map((v) => applyContrast(v, p.contrast))
  c = c.map((v) => srgbToLinear(Math.max(0, applyWhitesBlacks(encode(v), p.whites, p.blacks))))
  c = oklabToLinear(...applyColorAdjust(linearToOklab(c[0], c[1], c[2]), p.hsl, p.vibrance, p.saturation)).map((v) => Math.max(0, v))
  const curve = p.curve
  if (curve) c = c.map((v, i) => srgbToLinear(sampleCurve(curve, encode(v), i)))
  return c as Vec3
}

