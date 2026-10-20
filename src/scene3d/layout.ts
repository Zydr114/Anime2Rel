/**
 * 3D 视图中各物体的位置（世界坐标，见 space.ts），由文档和背景深度算出；渲染和交互共用。
 * 立绘与灯的位置与重光照一致：都按深度校准换算（src/camera/depthScale.ts）。
 */
import { inverseDepth, unproject } from '@/algo/camera'
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { depthScaleFor, type CalibratedDepth } from '@/camera/depthScale'
import { cameraFocal, projectPoint } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import { add, mul, unit } from '@/camera/vec'
import type { DepthResult } from '@/depth/protocol'
import { characterBox, characterDepth } from '@/fusion/placement'
import type { CharacterInfo } from '@/fusion/protocol'
import { MAX_LIGHT_DEPTH, type Light } from '@/lighting/model'
import { ballPlacement } from '@/lighting/preview'
import type { DocState } from '@/state/store'
import { cameraFromWorld, directionToWorld, worldFromCamera } from './space'

export interface CharacterLayout {
  /** 立绘中心（世界坐标）与它到原相机的距离（沿光轴） */
  center: Vec3
  depth: number
  /** 立绘平面的归一化逆深度（见 characterDepth） */
  plane: number
  /** 不透明区域的四角：文档像素（见 characterBox）与立绘平面上的世界坐标 */
  box: Point[]
  corners: Vec3[]
  /** 不透明区域的高度（米） */
  height: number
}

export interface LightLayout {
  id: string
  type: Light['type']
  enabled: boolean
  /** 灯：所在位置；太阳 / 天光：画在以 target 为中心的球面上的位置 */
  position: Vec3
  /** 太阳 / 天光：指向光源的方向（世界坐标） */
  direction: Vec3
  color: Vec3
}

export interface SceneLayout {
  scale: CalibratedDepth
  character: CharacterLayout | null
  /** 环绕的中心：立绘中心，没有立绘时为画面中心的景物 */
  target: Vec3
  /** 到原相机的距离：灯的衰减以它为参考，灯在这个距离上亮度减半 */
  reference: number
  /** 太阳 / 天光所在球面的半径 */
  sunRadius: number
  /** 灰球：在立绘右侧、与立绘中心等高，大小与二维视图中的灰球相同；没有立绘时在环绕中心 */
  ball: { center: Vec3; radius: number }
  lights: LightLayout[]
}

/** 文档像素 + 相机空间的距离 → 世界坐标 */
export function docToWorld(camera: CameraDoc, size: Size, p: Point, z: number): Vec3 {
  const f = cameraFocal(camera, size)
  return worldFromCamera(camera, [((p.x - size.width / 2) * z) / f, ((size.height / 2 - p.y) * z) / f, -z])
}

/** 灯的世界坐标 → 文档中保存的位置（画面坐标 + 归一化逆深度）；在原相机后方或太近时为 null */
export function lampFromWorld(camera: CameraDoc, size: Size, scale: CalibratedDepth, w: Vec3): Light['position'] | null {
  const x = cameraFromWorld(camera, w)
  if (-x[2] < LAMP_NEAR * camera.height) return null
  const p = projectPoint(x, size, cameraFocal(camera, size))!
  return { x: p.x, y: p.y, depth: Math.min(MAX_LIGHT_DEPTH, Math.max(0, inverseDepth(-x[2], scale))) }
}

/** 灯离原相机最近的距离（沿光轴，相机高度的倍数） */
export const LAMP_NEAR = 0.05

export function sceneLayout(doc: DocState, depth: DepthResult | undefined, bbox: CharacterInfo['bbox'] | undefined): SceneLayout | null {
  const bg = doc.background
  if (!bg) return null
  const { camera } = doc
  const scale = depthScaleFor(camera, bg, depth)
  const at = (p: Point, d: number) => worldFromCamera(camera, unproject(p, d, bg, camera.fovDeg, scale))

  let character: CharacterLayout | null = null
  if (doc.character) {
    const box = characterBox(doc, bbox)
    const d = characterDepth(doc, depth, bbox)
    const z = 1 / Math.max(scale.a * d + scale.b, 1 / scale.far)
    const corners = box.map((p) => docToWorld(camera, bg, p, z))
    const center = mul(corners.reduce((s, c) => add(s, c), [0, 0, 0] as Vec3), 1 / 4)
    character = { center, depth: z, plane: d, box, corners, height: (Math.hypot(...add(corners[3], corners[0], -1)) + Math.hypot(...add(corners[2], corners[1], -1))) / 2 }
  }
  // 没有立绘时环绕画面中心的景物，距离取画面中心的深度
  const target = character?.center ?? at({ x: bg.width / 2, y: bg.height / 2 }, centerDepth(depth))
  const reference = Math.hypot(...add(target, [0, camera.height, 0], -1))
  const sunRadius = Math.max(reference * 0.6, (character?.height ?? 0) * 1.5)

  const metres = (character?.depth ?? reference) / cameraFocal(camera, bg)
  const radius = ballPlacement(doc, bg).radius * metres
  let ball = { center: target, radius }
  if (character) {
    const side = directionToWorld(camera, [1, 0, 0])
    const width = Math.hypot(...add(character.corners[1], character.corners[0], -1))
    ball = { center: add(character.center, unit([side[0], 0, side[2]]), width / 2 + 2 * radius), radius }
  }

  const lights = doc.lighting.lights.map((l): LightLayout => {
    const color = l.color
    if (l.type === 'point') return { id: l.id, type: l.type, enabled: l.enabled, position: at(l.position, l.position.depth), direction: [0, 1, 0], color }
    const direction = directionToWorld(camera, l.direction)
    return { id: l.id, type: l.type, enabled: l.enabled, position: add(target, direction, sunRadius), direction, color }
  })
  return { scale, character, target, reference, sunRadius, ball, lights }
}

function centerDepth(depth: DepthResult | undefined): number {
  if (!depth) return 0.5
  const { width, height } = depth.guideSize
  return depth.depth[Math.floor(height / 2) * width + Math.floor(width / 2)]
}
