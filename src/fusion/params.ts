/**
 * 由融合参数与统计量换算出的着色器参数（docs/Plan.md §3.3）。纯函数，GPU 实现见 src/engine/fusion.ts。
 * 颜色匹配：白平衡适配 → Oklab 影调曲线 → 饱和度收敛 → 环境色调；
 * 重光照：C · lerp(1, S(N) / S_ref, strength) + 轮廓光 + 高光，S_ref 是正面半球上的平均光照。
 */
import { adaptationMatrix, luminance, type Mat3 } from '@/algo/cat'
import { normalize, sceneDepth, unproject, type DepthScale } from '@/algo/camera'
import { clamp, type Point, type Size } from '@/algo/geometry'
import { focalLength } from '@/algo/normals'
import { evalSh, type ShRgb, type Vec3 } from '@/algo/sh'
import { pointAttenuation, wrapDiffuse } from '@/algo/shading'
import { monotoneCurve, type MonotoneCurve } from '@/algo/curve'
import type { LightingDoc } from '@/lighting/model'
import { RELIGHT_STYLES, type FusionDoc, type RelightStyle } from './model'
import type { BackgroundInfo, FusionStats } from './protocol'
import type { LabStats } from './stats'

/** 与 src/engine/passes.ts 的 PREVIEW_LIGHTS 一致 */
export const FUSION_LIGHTS = 8

/** 影调曲线每段斜率（对比度）的范围，防止背景过平或过陡时立绘被压扁或拉爆 */
const TONE_SLOPE = [0.4, 2.5] as const
/** 饱和度收敛的色度缩放范围 */
const SATURATION_SCALE = [0.4, 1.15] as const
/** 直射光可见度的范围：立绘周围比整张背景暗（如站在阴影里）时减弱直射光 */
const VISIBILITY = [0.4, 1.3] as const
/** 肤色保护时色调与饱和度调整保留的比例 */
export const SKIN_KEEP = 0.3

/** 白平衡适配矩阵：立绘按 D65 绘制，适配到按强度插值的背景白点。 */
export function whiteAdaptation(colorMatch: FusionDoc['colorMatch'], background: Vec3): Mat3 {
  const k = colorMatch.whiteBalance
  return adaptationMatrix([1, 1, 1], background.map((c) => 1 + (c - 1) * k))
}

/**
 * 影调曲线：立绘明度的 P1（黑位）与 P50（中间调）按强度映射到背景对应分位；P99 跟随中间调的曝光变化，
 * 而不是匹配背景的 P99——立绘周围的背景里往往没有白色物体，其最亮处并不代表光照的强弱。
 * 以中位数为支点限制两段的斜率，分位点重合等退化情况返回恒等曲线。
 */
export function toneCurve(character: LabStats, local: LabStats, strength: number): MonotoneCurve {
  const xs = character.quantiles
  const identity = monotoneCurve([0, 0.5, 1], [0, 0.5, 1])
  if (!(xs[1] - xs[0] > 1e-3 && xs[2] - xs[1] > 1e-3)) return identity
  const mid = xs[1] + (local.quantiles[1] - xs[1]) * strength
  const target = [xs[0] + (local.quantiles[0] - xs[0]) * strength, mid, (xs[2] * mid) / xs[1]]
  const lo = clamp((target[1] - target[0]) / (xs[1] - xs[0]), ...TONE_SLOPE)
  const hi = clamp((target[2] - target[1]) / (xs[2] - xs[1]), ...TONE_SLOPE)
  const ys = [target[1] - lo * (xs[1] - xs[0]), target[1], target[1] + hi * (xs[2] - xs[1])]
  return monotoneCurve(xs, ys)
}

/** 漫反射风格，与着色器一致 */
export function styleDiffuse(style: RelightStyle, cos: number, softness: number, cel: { threshold: number; softness: number }): number {
  if (style === 'soft') return ((cos + 1) / 2) ** 2
  if (style === 'cel') {
    const w = Math.max(cel.softness, 1e-3)
    const t = clamp((cos - cel.threshold + w) / (2 * w), 0, 1)
    return t * t * (3 - 2 * t)
  }
  return wrapDiffuse(cos, softness)
}

export interface FusionLight {
  /** 0 方向光，1 点光源 */
  type: 0 | 1
  /** 方向光：指向光源的单位向量；点光源：相机空间位置 */
  vector: Vec3
  /** 线性 RGB，已乘以强度和直射光可见度 */
  color: Vec3
  softness: number
}

export interface FusionParams {
  // 颜色匹配
  cat: Mat3
  tone: MonotoneCurve
  /** 色度缩放（饱和度收敛） */
  chromaScale: number
  /** 环境色调：叠加到 a/b 上的偏移，明度低于 tintL 时按比例减弱 */
  tint: [number, number]
  tintL: number
  /** 肤色保护：1 开启 */
  skinProtect: number

  // 重光照
  relight: number
  style: number
  cel: { threshold: number; softness: number }
  /** 1 / S_ref（逐通道） */
  inverseReference: Vec3
  /** 已乘以环境光倍率 */
  ambient: ShRgb
  lights: FusionLight[]
  /** 立绘平面的相机参数：像素 → 相机空间位置 P = ((x − W/2)·k, (H/2 − y)·k, −depth) */
  plane: { k: number; depth: number }
  /** 点光源衰减的参考距离（相机到立绘中心） */
  referenceDistance: number
  /** 轮廓光与高光的系数（已除以 S_ref 的亮度）以及立绘中间调的线性亮度 */
  rim: number
  specular: number
  mid: number
  /** 主光源在 lights 中的下标（-1 为没有），自身投影只乘在它的直射光上 */
  mainLight: number
  /** 自身投影：1 时按阴影纹理的 alpha 减弱主光源的直射光 */
  selfShadow: number

  // 边缘与质感（文档像素）
  lightWrap: number
  wrapRadius: number
  feather: number
  /** 文档分辨率下的噪声标准差（sRGB 编码值，已乘以强度） */
  noise: Vec3
  decontaminate: boolean
  shrink: number
}

/** 余弦加权的正面半球采样（Fibonacci 螺旋），用于 S_ref */
const HEMISPHERE_SAMPLES = 128
const HEMISPHERE: Vec3[] = Array.from({ length: HEMISPHERE_SAMPLES }, (_, i) => {
  const u = (i + 0.5) / HEMISPHERE_SAMPLES
  const r = Math.sqrt(u)
  const phi = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)]
})

export interface FusionInputs {
  fusion: FusionDoc
  lighting: LightingDoc
  /** 相机视场角（长边，度） */
  fovDeg: number
  size: Size
  background: BackgroundInfo | null
  stats: FusionStats | null
  /** 分析得到的环境光；未分析时为 undefined */
  ambient: ArrayLike<number> | undefined
  /** 立绘中心（文档像素）与所在的归一化逆深度 */
  center: Point
  depth: number
  /** 逆深度到距离的换算（深度校准） */
  depthScale: DepthScale
  /** 主光源在启用光源中的下标（与站立阴影用的是同一个），未给出时为 -1 */
  mainLight?: number
}

export function fusionParams(input: FusionInputs): FusionParams {
  const { fusion, lighting, size, background, stats, fovDeg } = input
  const { colorMatch: cm, relight: rl, edge } = fusion
  const character = stats?.character ?? null
  const local = stats?.local ?? null
  const hasStats = !!character && !!local && local.weight > 0

  // 颜色匹配
  const cat = whiteAdaptation(cm, background?.whitePoint ?? [1, 1, 1])
  const tone = hasStats ? toneCurve(character, local, cm.tone) : monotoneCurve([0, 0.5, 1], [0, 0.5, 1])
  // 影调变化时色度随明度等比缩放，这里按中位数的变化预估缩放后的立绘色度
  const lRatio = hasStats ? tone.ys[1] / Math.max(tone.xs[1], 1e-3) : 1
  const chromaRatio = hasStats && character.chromaP90 > 1e-3 ? local.chromaP90 / (character.chromaP90 * lRatio) : 1
  const chromaScale = clamp(1 + (chromaRatio - 1) * cm.saturation, ...SATURATION_SCALE)
  const tint: [number, number] = hasStats ? [local.mean[0] * cm.chroma, local.mean[1] * cm.chroma] : [0, 0]

  // 光源：相机空间中立绘中心的位置
  const scale = input.depthScale
  const at = unproject(input.center, input.depth, size, fovDeg, scale)
  const referenceDistance = Math.hypot(...at)
  const visibility =
    stats && background ? clamp(Math.sqrt(luminance(stats.localColor) / Math.max(luminance(background.meanColor), 1e-4)), ...VISIBILITY) : 1
  const enabled = lighting.lights.filter((l) => l.enabled).slice(0, FUSION_LIGHTS)
  const lights: FusionLight[] = enabled.map((l) => {
    const color = l.color.map((c) => c * l.intensity * visibility) as Vec3
    if (l.type === 'directional') return { type: 0, vector: l.direction, color, softness: l.softness }
    return { type: 1, vector: unproject(l.position, l.position.depth, size, fovDeg, scale), color, softness: l.softness }
  })
  const ambient = Float64Array.from(input.ambient ?? new Array<number>(27).fill(0), (v) => v * lighting.ambient)

  // S_ref：立绘中心处的光照在正面半球上的平均
  const cel = { threshold: rl.celThreshold, softness: rl.celSoftness }
  const atCenter = lights.map((l) => {
    if (l.type === 0) return { direction: l.vector, color: l.color }
    const v: Vec3 = [l.vector[0] - at[0], l.vector[1] - at[1], l.vector[2] - at[2]]
    const k = pointAttenuation(Math.hypot(...v), referenceDistance)
    return { direction: normalize(v), color: l.color.map((c) => c * k) as Vec3 }
  })
  const reference: Vec3 = [0, 0, 0]
  for (const n of HEMISPHERE) {
    const s = evalSh(ambient, n).map((v) => Math.max(0, v))
    atCenter.forEach((l, i) => {
      const d = styleDiffuse(rl.style, n[0] * l.direction[0] + n[1] * l.direction[1] + n[2] * l.direction[2], lights[i].softness, cel)
      for (let c = 0; c < 3; c++) s[c] += l.color[c] * d
    })
    for (let c = 0; c < 3; c++) reference[c] += s[c] / HEMISPHERE.length
  }
  const refLuma = luminance(reference)
  // 某个通道几乎没有光时不放大该通道的比值
  const floor = Math.max(...reference) * 0.05
  const inverseReference = reference.map((v) => 1 / Math.max(v, floor, 1e-6)) as Vec3
  const lit = refLuma > 1e-4

  const D = sceneDepth(input.depth, scale)
  return {
    cat,
    tone,
    chromaScale,
    tint,
    tintL: hasStats ? Math.max(local.quantiles[1], 0.2) : 0.5,
    skinProtect: cm.skinProtect ? 1 : 0,

    relight: lit ? rl.strength : 0,
    style: RELIGHT_STYLES.indexOf(rl.style),
    cel,
    inverseReference,
    ambient,
    lights,
    plane: { k: D / focalLength(size.width, size.height, fovDeg), depth: D },
    referenceDistance,
    rim: lit ? rl.rim / refLuma : 0,
    specular: lit ? rl.specular / refLuma : 0,
    mid: tone.ys[1] ** 3,
    mainLight: input.mainLight !== undefined && input.mainLight < lights.length ? input.mainLight : -1,
    selfShadow: fusion.shadow.self > 0 ? 1 : 0,

    lightWrap: edge.lightWrap,
    wrapRadius: edge.wrapRadius * Math.min(size.width, size.height),
    feather: edge.feather,
    noise: (background?.noise ?? [0, 0, 0]).map((v) => v * edge.noise) as Vec3,
    decontaminate: edge.decontaminate,
    shrink: edge.shrink,
  }
}
