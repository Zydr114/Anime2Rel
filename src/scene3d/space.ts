/**
 * 3D 视图的空间与视角（docs/Plan.md §3.7 M8.6a），不依赖 three.js：渲染（src/engine/scene3d.ts）和交互（src/canvas/View3D.tsx）共用。
 * 世界坐标按标定的相机摆正：地面是 y = 0，x、z 分别沿相机横轴在地面上的投影和朝向相机的水平方向（见 groundAxes），
 * 原相机在 (0, 相机高度, 0)。距离的单位与深度校准一致（米）。
 * 屏幕坐标是视口的 CSS 像素，y 向下，与二维视图相同。
 */
import type { Insets, Point, Size, ViewTransform } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { cameraFocal, fromGround, toGround } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import { add, cross, dot, mul, unit } from '@/camera/vec'

type Pose = Pick<CameraDoc, 'pitch' | 'roll' | 'height'>

export function worldFromCamera(c: Pose, x: Vec3): Vec3 {
  return add(toGround(c, x), [0, c.height, 0])
}

export function cameraFromWorld(c: Pose, w: Vec3): Vec3 {
  return fromGround(c, add(w, [0, -c.height, 0]))
}

/** 方向只旋转，不平移 */
export const directionToWorld = (c: Pose, d: Vec3): Vec3 => toGround(c, d)
export const directionToCamera = (c: Pose, d: Vec3): Vec3 => fromGround(c, d)

/** 环绕 target 的视角：yaw 绕竖直轴（0 时从 +z 一侧看），pitch 向上为正，fovDeg 为竖直视场角 */
export interface Orbit {
  target: Vec3
  yaw: number
  pitch: number
  distance: number
  fovDeg: number
}

/** 原相机视角（与二维画面重合），或环绕视角 */
export type View3d = { kind: 'camera' } | { kind: 'orbit'; orbit: Orbit }

export const ORBIT_PITCH_LIMIT = (85 * Math.PI) / 180

/** 视角在屏幕上的投影：位置、朝向（世界坐标中的右、上、后），焦距与主点（CSS 像素） */
export interface Projection {
  position: Vec3
  right: Vec3
  up: Vec3
  back: Vec3
  focal: number
  principal: Point
  viewport: Size
}

export function orbitPosition(o: Orbit): Vec3 {
  const cp = Math.cos(o.pitch)
  return add(o.target, [cp * Math.sin(o.yaw), Math.sin(o.pitch), cp * Math.cos(o.yaw)], o.distance)
}

/**
 * 原相机视角按二维视图的缩放和平移投影，与二维画面逐像素重合；环绕视角的主点在两侧面板之间可见区域的中心。
 * size 为文档尺寸，view 为二维视图的变换。
 */
export function viewProjection(view: View3d, camera: CameraDoc, size: Size, view2d: ViewTransform, viewport: Size, insets: Insets): Projection {
  if (view.kind === 'camera') {
    return {
      position: [0, camera.height, 0],
      right: directionToWorld(camera, [1, 0, 0]),
      up: directionToWorld(camera, [0, 1, 0]),
      back: directionToWorld(camera, [0, 0, 1]),
      focal: cameraFocal(camera, size) * view2d.zoom,
      principal: { x: view2d.panX + (size.width / 2) * view2d.zoom, y: view2d.panY + (size.height / 2) * view2d.zoom },
      viewport,
    }
  }
  const o = view.orbit
  const position = orbitPosition(o)
  const back = unit(add(position, o.target, -1))
  const right = unit(cross([0, 1, 0], back))
  const height = Math.max(1, viewport.height - insets.top - insets.bottom)
  return {
    position,
    right,
    up: cross(back, right),
    back,
    focal: height / 2 / Math.tan(((o.fovDeg / 2) * Math.PI) / 180),
    principal: { x: (insets.left + viewport.width - insets.right) / 2, y: insets.top + height / 2 },
    viewport,
  }
}

/** 世界坐标 → 屏幕；在视点后方时为 null */
export function projectToScreen(p: Projection, w: Vec3): Point | null {
  const v = add(w, p.position, -1)
  const z = -dot(v, p.back)
  if (z <= 1e-6) return null
  return { x: p.principal.x + (p.focal * dot(v, p.right)) / z, y: p.principal.y - (p.focal * dot(v, p.up)) / z }
}

/** 穿过屏幕点的视线（单位方向） */
export function screenRay(p: Projection, s: Point): { origin: Vec3; dir: Vec3 } {
  const x = (s.x - p.principal.x) / p.focal
  const y = (p.principal.y - s.y) / p.focal
  return { origin: p.position, dir: unit(add(add(mul(p.right, x), p.up, y), p.back, -1)) }
}

/** 从任意投影转为环绕 target 的视角，位置不变（原相机的倾斜会被摆正）；视场角按可见区域的高度换算 */
export function orbitFrom(p: Projection, target: Vec3, insets: Insets): Orbit {
  const v = add(p.position, target, -1)
  const distance = Math.max(Math.hypot(...v), 1e-3)
  return {
    target,
    yaw: Math.atan2(v[0], v[2]),
    pitch: Math.max(-ORBIT_PITCH_LIMIT, Math.min(ORBIT_PITCH_LIMIT, Math.asin(v[1] / distance))),
    distance,
    fovDeg: (2 * Math.atan(Math.max(1, p.viewport.height - insets.top - insets.bottom) / 2 / p.focal) * 180) / Math.PI,
  }
}
