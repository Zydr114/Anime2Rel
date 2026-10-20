/** 3D 视图中点击场景：添加光源、吸管取色、按住 Ctrl 把选中的灯放到所点的表面附近（docs/Plan.md §3.7 M8.6a） */
import type { Point } from '@/algo/geometry'
import { notify } from '@/app/notify'
import { add } from '@/camera/vec'
import { t } from '@/i18n'
import { MAX_LIGHTS, newLightAt } from '@/lighting/model'
import { pickColor } from '@/lighting/sampling'
import { lampFromWorld } from '@/scene3d/layout'
import { pickSurface, skyPixel, type SurfaceHit } from '@/scene3d/pick'
import { directionToCamera, screenRay } from '@/scene3d/space'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { currentScene, currentSurface } from '@/state/view3d'

/** 灯离开所点表面的距离（参考距离的比例），不超过到视点距离的一半 */
const SURFACE_OFFSET = 0.04

export type SceneClick = 'add' | 'pick' | 'place'

export function clickScene(screen: Point, action: SceneClick): void {
  const scene = currentScene()
  const app = useApp.getState()
  const bg = app.doc.background
  const surface = scene && currentSurface(scene.layout)
  if (!scene || !bg || !surface) return
  const { layout, projection } = scene
  const { camera } = app.doc
  const ray = screenRay(projection, screen)
  // 最远到 3D 视图中最远的景物（见 src/engine/scene3d.ts 的穹顶）
  const hit = pickSurface(surface, ray, 0.02 * camera.height, 1.5 * Math.min(layout.scale.far, 1e4 * camera.height))
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
