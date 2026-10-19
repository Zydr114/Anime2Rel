/**
 * 后期效果（可撤销的文档参数，docs/Plan.md §3.6）与着色器参数的换算，着色器见 src/engine/post.ts 和 src/engine/finish.ts。
 * 所有参数默认中性。长度、尺寸都按图像长边的比例定义，预览与导出的观感一致。
 */
import { rayToPixel } from '@/algo/camera'
import { hexToLinear, srgbToLinear } from '@/algo/color'
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import type { Light, LightingDoc } from '@/lighting/model'

export type ToneMapping = 'none' | 'agx' | 'neutral'
export const TONE_MAPPINGS: readonly ToneMapping[] = ['none', 'agx', 'neutral']

export interface PostDoc {
  /** 阈值为 sRGB 编码的亮度 [0,1]，其他参数为 [0,1] */
  bloom: { intensity: number; threshold: number; radius: number }
  /** 胶片红晕：color 为 #rrggbb */
  halation: { intensity: number; threshold: number; radius: number; color: string }
  /** 丁达尔光束：light 为光源 id，null 为自动选择；skyOnly 为只让天空发光（有深度时） */
  rays: { intensity: number; threshold: number; length: number; light: string | null; skyOnly: boolean }
  /** 色差 [0,1]；暗角 [-1,1]，负值压暗；中点、羽化 [0,1] */
  lens: { aberration: number; vignette: number; midpoint: number; feather: number }
  /** 颗粒强度、尺寸、彩色程度 [0,1] */
  grain: { amount: number; size: number; color: number }
  toneMapping: ToneMapping
}

export type PostSection = Exclude<keyof PostDoc, 'toneMapping'>

export const DEFAULT_POST: PostDoc = {
  bloom: { intensity: 0, threshold: 0.75, radius: 0.5 },
  halation: { intensity: 0, threshold: 0.85, radius: 0.3, color: '#ff5a1f' },
  rays: { intensity: 0, threshold: 0.8, length: 0.5, light: null, skyOnly: true },
  lens: { aberration: 0, vignette: 0, midpoint: 0.5, feather: 0.5 },
  grain: { amount: 0, size: 0.3, color: 0.3 },
  toneMapping: 'none',
}

export function isNeutralPost(p: PostDoc): boolean {
  return (
    p.bloom.intensity === 0 &&
    p.halation.intensity === 0 &&
    p.rays.intensity === 0 &&
    p.lens.aberration === 0 &&
    p.lens.vignette === 0 &&
    p.grain.amount === 0 &&
    p.toneMapping === 'none'
  )
}

/** 散射（上采样时粗一级所占的比例）的范围，由半径换算 */
const SCATTER_MIN = 0.4
const SCATTER_MAX = 0.95
/** 色差满格时，画面边缘处红、蓝通道相对放大的比例 */
export const ABERRATION_SCALE = 0.015
/** 暗角满格时画面角落的曝光变化（EV） */
export const VIGNETTE_STOPS = 2
/** 颗粒尺寸的范围（相对长边） */
const GRAIN_CELL_MIN = 1 / 3000
const GRAIN_CELL_MAX = 1 / 500

export interface PostParams {
  active: boolean
  /** 以下强度为 0 时不计算对应效果 */
  bloom: number
  /** 线性亮度 */
  bloomThreshold: number
  bloomScatter: number
  halation: number
  halationThreshold: number
  halationScatter: number
  halationColor: Vec3
  rays: number
  raysThreshold: number
  /** 光束长度（相对长边） */
  raysLength: number
  /** 光源在画面上的位置（文档 UV，可在画面外）；没有可用光源时为 null，此时 rays 为 0 */
  raysLight: Point | null
  skyOnly: boolean
  aberration: number
  /** 角落处的曝光变化（EV） */
  vignette: number
  /** 暗角从 inner 开始、到 outer 达到满格；半径以画面角落为 1 */
  vignetteInner: number
  vignetteOuter: number
  grain: number
  /** 颗粒尺寸（相对长边） */
  grainCell: number
  grainColor: number
  toneMapping: 0 | 1 | 2
}

/** 按画面中的位置选择光束的光源：手动指定的光源，或自动选择最强的光源（优先方向光）。光源在相机后方时返回 null */
export function raysLight(lighting: LightingDoc, id: string | null, size: Size): { light: Light; uv: Point } | null {
  const project = (l: Light): Point | null => {
    if (l.type === 'point') return { x: l.position.x / size.width, y: l.position.y / size.height }
    const p = rayToPixel(l.direction, size, lighting.fovDeg)
    return p && { x: p.x / size.width, y: p.y / size.height }
  }
  if (id !== null) {
    const light = lighting.lights.find((l) => l.id === id)
    const uv = light && project(light)
    return light && uv ? { light, uv } : null
  }
  const candidates = lighting.lights
    .filter((l) => l.enabled)
    .sort((a, b) => Number(a.type !== 'directional') - Number(b.type !== 'directional') || b.intensity - a.intensity)
  for (const light of candidates) {
    const uv = project(light)
    if (uv) return { light, uv }
  }
  return null
}

export function postParams(p: PostDoc, lighting: LightingDoc, size: Size | null): PostParams {
  const scatter = (radius: number) => SCATTER_MIN + (SCATTER_MAX - SCATTER_MIN) * radius
  const light = size && p.rays.intensity > 0 ? raysLight(lighting, p.rays.light, size) : null
  const mid = 0.3 + 0.6 * p.lens.midpoint
  const width = 0.05 + 0.9 * p.lens.feather
  return {
    active: !isNeutralPost(p),
    bloom: p.bloom.intensity,
    bloomThreshold: srgbToLinear(p.bloom.threshold),
    bloomScatter: scatter(p.bloom.radius),
    halation: p.halation.intensity,
    halationThreshold: srgbToLinear(p.halation.threshold),
    halationScatter: scatter(p.halation.radius),
    halationColor: hexToLinear(p.halation.color) ?? [1, 0.1, 0.01],
    rays: light ? p.rays.intensity : 0,
    raysThreshold: srgbToLinear(p.rays.threshold),
    raysLength: p.rays.length,
    raysLight: light?.uv ?? null,
    skyOnly: p.rays.skyOnly,
    aberration: p.lens.aberration * ABERRATION_SCALE,
    vignette: p.lens.vignette * VIGNETTE_STOPS,
    vignetteInner: mid - width / 2,
    vignetteOuter: mid + width / 2,
    grain: p.grain.amount,
    grainCell: GRAIN_CELL_MIN * (GRAIN_CELL_MAX / GRAIN_CELL_MIN) ** p.grain.size,
    grainColor: p.grain.color,
    toneMapping: p.toneMapping === 'agx' ? 1 : p.toneMapping === 'neutral' ? 2 : 0,
  }
}
