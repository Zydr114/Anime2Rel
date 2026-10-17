/**
 * 针孔相机：文档像素、相机射线与 2.5D 位置之间的换算（docs/Plan.md §3.2）。
 * 相机空间与法线一致：x 向右，y 向上，z 指向相机（相机看向 -z）。视场角按长边计算。
 */
import type { Point, Size } from './geometry'
import { DEFAULT_NORMAL_OPTIONS, focalLength } from './normals'
import type { Vec3 } from './sh'

/** 像素中心相对主点的坐标（y 向上）。 */
function centered(p: Point, size: Size): [number, number] {
  return [p.x - size.width / 2, size.height / 2 - p.y]
}

/** 穿过文档像素 p 的相机射线（指向场景的单位向量）。远处光源位于该像素时，这也是指向光源的方向。 */
export function pixelToRay(p: Point, size: Size, fovDeg: number): Vec3 {
  const [x, y] = centered(p, size)
  const f = focalLength(size.width, size.height, fovDeg)
  const len = Math.hypot(x, y, f)
  return [x / len, y / len, -f / len]
}

/** 方向 d 在画面上的投影（文档像素）；方向不在相机前方时返回 null。 */
export function rayToPixel(d: Vec3, size: Size, fovDeg: number): Point | null {
  if (d[2] >= -1e-6) return null
  const f = focalLength(size.width, size.height, fovDeg)
  const k = f / -d[2]
  return { x: size.width / 2 + d[0] * k, y: size.height / 2 - d[1] * k }
}

/** 归一化逆深度 [0,1] → 伪深度，与法线估计使用同一平移量。 */
export function pseudoDepth(inverse: number, shift = DEFAULT_NORMAL_OPTIONS.shift): number {
  return 1 / (Math.max(0, inverse) + shift)
}

/** 文档像素 + 归一化逆深度 → 相机空间位置（单位任意，只用于相对方向和距离）。 */
export function unproject(p: Point, inverse: number, size: Size, fovDeg: number): Vec3 {
  const [x, y] = centered(p, size)
  const f = focalLength(size.width, size.height, fovDeg)
  const z = pseudoDepth(inverse)
  return [(x * z) / f, (y * z) / f, -z]
}

/** 方位角（绕 y 轴，0 为正面光、正值来自右侧，|方位角| > 90° 为背光）与仰角，单位为弧度。 */
export function toAngles(d: Vec3): { azimuth: number; elevation: number } {
  return { azimuth: Math.atan2(d[0], d[2]), elevation: Math.asin(Math.max(-1, Math.min(1, d[1]))) }
}

export function fromAngles(azimuth: number, elevation: number): Vec3 {
  const c = Math.cos(elevation)
  return [c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth)]
}

export function normalize(v: readonly number[]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
}

/** 两个单位向量的夹角（弧度）。 */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
}
