/**
 * 3D 视图中点击、拖动场景（docs/Plan.md §3.7）：
 * 融合步骤中添加光源、吸管取色、按住 Ctrl 把选中的灯放到所点的表面附近（M8.6a）；
 * 摆放步骤中沿地面移动人物、用深度画笔在人物上画（M8.6b）。
 */
import { inverseDepth } from '@/algo/camera'
import type { LayerTransform, Point } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { notify } from '@/app/notify'
import { cameraFocal, groundPoint, projectPoint, standingScale } from '@/camera/geometry'
import { add, dot } from '@/camera/vec'
import { characterGround, characterHeight, characterUV } from '@/fusion/placement'
import { t } from '@/i18n'
import { MAX_LIGHTS, newLightAt } from '@/lighting/model'
import { pickColor } from '@/lighting/sampling'
import { planeHit } from '@/scene3d/drag'
import { LAMP_NEAR, lampFromWorld, type SceneLayout } from '@/scene3d/layout'
import { pickSurface, skyPixel, type SurfaceHit } from '@/scene3d/pick'
import { cameraFromWorld, directionToCamera, screenRay, worldFromCamera, type Projection } from '@/scene3d/space'
import { strokeRadius } from '@/state/depthEdit'
import { characterInfo } from '@/state/fusion'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { currentScene, currentSurface } from '@/state/view3d'

/** 灯离开所点表面的距离（参考距离的比例），不超过到视点距离的一半 */
const SURFACE_OFFSET = 0.04
const MIN_SCALE = 0.005
const GROUND: Vec3 = [0, 0, 0]
const UP: Vec3 = [0, 1, 0]

/** 屏幕上一点的视线与它碰到的表面；没有场景时为 null */
export function pickScene(screen: Point): { layout: SceneLayout; projection: Projection; ray: { origin: Vec3; dir: Vec3 }; hit: SurfaceHit | null } | null {
  const scene = currentScene()
  const { camera } = useApp.getState().doc
  const surface = scene && currentSurface(scene.layout)
  if (!scene || !surface) return null
  const ray = screenRay(scene.projection, screen)
  // 最远到 3D 视图中最远的景物（见 src/engine/scene3d.ts 的穹顶）
  const hit = pickSurface(surface, ray, 0.02 * camera.height, 1.5 * Math.min(scene.layout.scale.far, 1e4 * camera.height))
  return { ...scene, ray, hit }
}

export type SceneClick = 'add' | 'pick' | 'place'

export function clickScene(screen: Point, action: SceneClick): void {
  const picked = pickScene(screen)
  const app = useApp.getState()
  const bg = app.doc.background
  if (!picked || !bg) return
  const { layout, ray, hit } = picked
  const { camera } = app.doc
  const lampAt = (h: SurfaceHit) => {
    const distance = Math.hypot(...add(h.point, ray.origin, -1))
    return lampFromWorld(camera, bg, layout.scale, add(h.point, ray.dir, -Math.min(SURFACE_OFFSET * layout.reference, distance / 2)))
  }
  const lighting = useLighting.getState()

  if (action === 'pick') {
    const p = hit ? hit.doc : skyPixel(camera, bg, ray.dir)
    const color = p && lighting.selected ? pickColor(bg.id, p, bg) : null
    if (color && lighting.selected) app.updateLight(lighting.selected, { color, kelvin: null })
    lighting.setTool('select')
    return
  }

  if (action === 'add') {
    lighting.setTool('select')
    // 点到表面时添加灯，点到天空或场景之外时添加太阳 / 天光，方向是所点的方向
    const position = hit && lampAt(hit)
    const fallback = { x: bg.width / 2, y: bg.height / 2 }
    const light = position
      ? { ...newLightAt(position, bg, camera.fovDeg, { depth: position.depth, sky: 0 }), position }
      : { ...newLightAt(fallback, bg, camera.fovDeg, { depth: 0.5, sky: 1 }), direction: directionToCamera(camera, ray.dir) }
    if (hit && !position) return
    if (app.addLight(light)) lighting.select(light.id)
    else notify(t.light.full(MAX_LIGHTS))
    return
  }

  const light = app.doc.lighting.lights.find((l) => l.id === lighting.selected)
  if (light?.type !== 'point') return notify(t.view3d.selectLamp)
  const position = hit && lampAt(hit)
  if (position) app.updateLight(light.id, { position })
}

/** 沿地面移动人物：开始时光标在地面上的位置、人物的接地点（世界坐标），以及开始时的接地点（文档坐标）、人物的画面高度和摆放 */
export interface GroundMove {
  anchor: Vec3
  contact: Vec3
  ground: Point
  height: number
  t0: LayerTransform
  /** 最近一次可用的缩放比例 */
  k: number
}

/** 光标处的地面与人物的接地点都在原相机前方的地面上时开始移动 */
export function beginGroundMove(screen: Point): GroundMove | null {
  const scene = currentScene()
  const { doc } = useApp.getState()
  const bg = doc.background
  if (!scene || !bg || !doc.character) return null
  const anchor = planeHit(screenRay(scene.projection, screen), GROUND, UP)
  const bbox = characterInfo(doc)?.bbox
  const ground = characterGround(doc, bg, bbox)
  const contact = groundPoint(doc.camera, bg, ground)
  if (!anchor || !contact) return null
  return { anchor, contact: worldFromCamera(doc.camera, contact), ground, height: characterHeight(doc, bbox), t0: doc.charTransform, k: 1 }
}

/**
 * 接地点随光标在地面上平移，人物按透视缩放（与二维中“拖动时按透视缩放”的算法相同）。
 * 前后位置为手动时改成地面在新接地点处的深度。
 */
export function moveOnGround(m: GroundMove, screen: Point): void {
  const scene = currentScene()
  const app = useApp.getState()
  const bg = app.doc.background
  const hit = scene && planeHit(screenRay(scene.projection, screen), GROUND, UP)
  if (!scene || !bg || !hit) return
  const { camera } = app.doc
  const x = cameraFromWorld(camera, add(m.contact, add(hit, m.anchor, -1)))
  if (-x[2] < LAMP_NEAR * camera.height) return
  const g = projectPoint(x, bg, cameraFocal(camera, bg))
  if (!g) return
  m.k = Math.max(MIN_SCALE / m.t0.scale, standingScale(camera, bg, m.ground, g, m.height) ?? m.k)
  app.setCharTransform({ x: g.x + m.k * (m.t0.x - m.ground.x), y: g.y + m.k * (m.t0.y - m.ground.y), scale: m.t0.scale * m.k })
  if (app.doc.fusion.depth !== null) app.setCharDepth(Math.min(1, Math.max(0, inverseDepth(-x[2], scene.layout.scale))))
}

/** 深度画笔在 3D 视图中的落点：所点处的立绘 UV 和笔画半径（屏幕直径 size 换算到立绘上）；没有点到立绘时为 null */
export function brushAt(screen: Point, size: number): { uv: Point; radius: number } | null {
  const picked = pickScene(screen)
  const { doc } = useApp.getState()
  const bg = doc.background
  const hit = picked?.hit
  if (!picked || !bg || hit?.on !== 'character' || !hit.doc) return null
  const p = picked.projection
  // 屏幕上的半径 → 所点处的世界距离 → 原相机画面中的文档像素
  const along = -dot(add(hit.point, p.position, -1), p.back)
  const z = -cameraFromWorld(doc.camera, hit.point)[2]
  const r = (((size / 2) * along) / p.focal) * (cameraFocal(doc.camera, bg) / z)
  return { uv: characterUV(doc, hit.doc).point, radius: strokeRadius(doc, hit.doc, r) }
}
