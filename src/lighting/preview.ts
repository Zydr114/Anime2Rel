/**
 * 灰球预览（docs/Plan.md §3.2）：在立绘位置放一个灰色漫反射球，用环境光加所有启用的光源照明。
 * 点光源按球心的 2.5D 位置求方向和衰减。画布上的灰球与面板里的光照方向球共用这里的结果。
 */
import { normalize, unproject, type DepthScale } from '@/algo/camera'
import type { Point, Size } from '@/algo/geometry'
import { pointAttenuation, type ShadeLight } from '@/algo/shading'
import type { ShRgb, Vec3 } from '@/algo/sh'
import type { AnalysisResult } from '@/analysis/protocol'
import { depthScaleFor } from '@/camera/depthScale'
import type { DepthResult } from '@/depth/protocol'
import { characterDepth } from '@/fusion/placement'
import type { CharacterInfo } from '@/fusion/protocol'
import type { DocState } from '@/state/store'
import type { Light } from './model'

export interface BallPreview {
  /** 文档像素 */
  center: Point
  radius: number
  /** 已乘以环境光倍率 */
  ambient: ShRgb
  /** 在球心处等效的光源（点光源已换算为方向与衰减） */
  lights: ShadeLight[]
  /** 与 lights 一一对应的光源 id */
  ids: string[]
}

/** 灰球的位置和大小：有立绘时放在立绘中心，否则放在画面中央。 */
export function ballPlacement(doc: DocState, size: Size): { center: Point; radius: number } {
  const short = Math.min(size.width, size.height)
  const ch = doc.character
  if (!ch) return { center: { x: size.width / 2, y: size.height / 2 }, radius: 0.08 * short }
  const t = doc.charTransform
  const w = ch.width * t.scale
  const h = ch.height * t.scale
  const radius = Math.max(0.03 * short, Math.min(0.12 * h, 0.35 * w))
  return { center: { x: t.x, y: t.y }, radius }
}

/** 某个光源在位置 at（相机空间，单位与 scale 一致）处的等效方向光。 */
export function effectiveLight(light: Light, at: Vec3, size: Size, fovDeg: number, scale: DepthScale): ShadeLight {
  const color = light.color.map((c) => c * light.intensity) as Vec3
  if (light.type === 'directional') return { direction: light.direction, color, softness: light.softness }
  const p = unproject(light.position, light.position.depth, size, fovDeg, scale)
  const v: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]]
  const dist = Math.hypot(v[0], v[1], v[2])
  // 参考距离取相机到球心的距离，使衰减与场景尺度无关
  const k = pointAttenuation(dist, Math.hypot(at[0], at[1], at[2]))
  return { direction: normalize(v), color: color.map((c) => c * k) as Vec3, softness: light.softness }
}

/** 灰球深度与立绘相同（见 characterDepth）。 */
export function computeBallPreview(
  doc: DocState,
  analysis: AnalysisResult | undefined,
  depth: DepthResult | undefined,
  bbox?: CharacterInfo['bbox'],
): BallPreview | null {
  const bg = doc.background
  if (!bg) return null
  const { center, radius } = ballPlacement(doc, bg)
  const { ambient: k, lights } = doc.lighting
  const { fovDeg } = doc.camera
  const scale = depthScaleFor(doc.camera, bg, depth)
  const at = unproject(center, characterDepth(doc, depth, bbox), bg, fovDeg, scale)
  const enabled = lights.filter((l) => l.enabled)
  return {
    center,
    radius,
    ambient: Float64Array.from(analysis?.ambient ?? new Array(27).fill(0), (v) => v * k),
    lights: enabled.map((l) => effectiveLight(l, at, bg, fovDeg, scale)),
    ids: enabled.map((l) => l.id),
  }
}
