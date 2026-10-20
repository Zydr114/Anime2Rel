/** 3D 视图中拖动光源的几何（世界坐标，y 向上），见 src/canvas/View3DLights.tsx */
import type { Vec3 } from '@/algo/sh'
import { add, dot, unit } from '@/camera/vec'

type Ray = { origin: Vec3; dir: Vec3 }

/**
 * 视线与球面的交点相对球心的方向。near 为 true 时取靠近视点的交点，视点在球内时只有远处的交点；
 * 视线不经过球面时取球面上离视线最近的点，拖到球的轮廓之外仍连续。
 */
export function sphereDirection(ray: Ray, center: Vec3, radius: number, near: boolean): Vec3 {
  const oc = add(ray.origin, center, -1)
  const b = dot(oc, ray.dir)
  const disc = b * b - (dot(oc, oc) - radius * radius)
  if (disc < 0) return unit(add(add(ray.origin, ray.dir, Math.max(0, -b)), center, -1))
  const s = Math.sqrt(disc)
  const t = near && -b - s > 0 ? -b - s : -b + s
  return unit(add(oc, ray.dir, t))
}

/** 视线与过 point、法线为 normal 的平面的交点；视线与平面平行或交点在视点后方时为 null */
export function planeHit(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(ray.dir, normal)
  if (Math.abs(denom) < 1e-9) return null
  const t = dot(add(point, ray.origin, -1), normal) / denom
  return t > 0 ? add(ray.origin, ray.dir, t) : null
}

/** 方向相对地面的方位角和仰角各吸附到 step 的整数倍（与光源面板的方位、仰角一致：方位 0 朝向 +z） */
export function snapDirection(d: Vec3, step: number): Vec3 {
  const snap = (v: number) => Math.round(v / step) * step
  const azimuth = snap(Math.atan2(d[0], d[2]))
  const elevation = snap(Math.asin(Math.max(-1, Math.min(1, d[1]))))
  const c = Math.cos(elevation)
  return [c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth)]
}
