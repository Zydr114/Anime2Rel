/** 文档中的光源（可撤销）：类型、默认值，以及由分析候选、画面位置创建光源。 */
import { fromAngles, pixelToRay } from '@/algo/camera'
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import type { Estimator, LightCandidate } from '@/analysis/protocol'

export type LightType = 'directional' | 'point'

export interface Light {
  id: string
  type: LightType
  enabled: boolean
  /** 方向光：指向光源的单位向量（相机空间：x 右、y 上、z 指向相机） */
  direction: Vec3
  /** 点光源：文档像素坐标与该处的归一化逆深度（1 为照片中最近的景物；在 3D 视图中可以放得更近，大于 1） */
  position: { x: number; y: number; depth: number }
  /** 线性 RGB，最大分量为 1 */
  color: Vec3
  /** 通过色温设置颜色时记录色温，其他方式改色后为 null */
  kelvin: number | null
  /** 与背景像素同一量纲的强度 */
  intensity: number
  /** 软硬度 [0,1] */
  softness: number
  /** 来自自动分析的候选：参与的估计器与置信度 */
  origin: { sources: Estimator[]; confidence: number } | null
}

export interface LightingDoc {
  lights: Light[]
  /** 环境光强度倍率 */
  ambient: number
  /** 光源列表来自哪张背景的分析结果；与当前背景不一致时，分析完成后自动替换 */
  analyzedFor: string | null
}

export const DEFAULT_LIGHTING: LightingDoc = { lights: [], ambient: 1, analyzedFor: null }
export const MAX_LIGHTS = 8
/** 点光源归一化逆深度的上限：3D 视图中的灯可以比照片中最近的景物还近，实际由离原相机的最近距离限制（见 src/scene3d/layout.ts） */
export const MAX_LIGHT_DEPTH = 1e4
export const DEFAULT_INTENSITY = 0.5
/** 置信度达到该值的点光源候选默认启用；方向光只默认启用排名最高的一个，避免同一个太阳被叠加两次 */
const POINT_ENABLE_CONFIDENCE = 0.4

let counter = 0
export function newLightId(): string {
  return `light-${++counter}`
}

function base(type: LightType): Light {
  return {
    id: newLightId(),
    type,
    enabled: true,
    direction: fromAngles((-35 * Math.PI) / 180, (40 * Math.PI) / 180),
    position: { x: 0, y: 0, depth: 0.5 },
    color: [1, 1, 1],
    kelvin: null,
    intensity: DEFAULT_INTENSITY,
    softness: 0.2,
    origin: null,
  }
}

export function lightsFromCandidates(candidates: readonly LightCandidate[], doc: Size): Light[] {
  const firstDirectional = candidates.findIndex((c) => c.type === 'directional')
  return candidates.map((c, i) => ({
    ...base(c.type),
    enabled: c.type === 'directional' ? i === firstDirectional : c.confidence >= POINT_ENABLE_CONFIDENCE,
    direction: c.direction,
    position: c.position ? { x: c.position.u * doc.width, y: c.position.v * doc.height, depth: c.position.depth } : { x: doc.width / 2, y: doc.height / 2, depth: 0.5 },
    color: c.color,
    intensity: c.intensity,
    softness: c.softness,
    origin: { sources: c.sources, confidence: c.confidence },
  }))
}

/** 新的方向光：默认从左前上方照来。 */
export function newDirectionalLight(intensity = DEFAULT_INTENSITY): Light {
  return { ...base('directional'), intensity }
}

/** 在画面上的点 p 处添加光源：落在天空里是方向光（穿过该像素的射线），否则是位于该处深度的点光源。 */
export function newLightAt(p: Point, doc: Size, fovDeg: number, sample: { depth: number; sky: number }, intensity = DEFAULT_INTENSITY): Light {
  if (sample.sky > 0.5) return { ...base('directional'), direction: pixelToRay(p, doc, fovDeg), softness: 0.1, intensity }
  return { ...base('point'), position: { x: p.x, y: p.y, depth: sample.depth }, softness: 0.4, intensity }
}
