/**
 * 标定相机的几何（docs/Plan.md §3.7 M8.5）。相机空间与 src/algo/camera.ts 一致：x 向右，y 向上，z 指向相机，主点在画面中心。
 * 世界的上方向由俯仰和倾斜决定；地面是相机下方 height 处的水平面，单位为米。
 * 消失点标定按 Guillou 等人的方法：两组互相垂直的平行线的消失点 Fu、Fv（相对主点）满足 Fu·Fv + f² = 0。
 */
import type { Point, Size } from '@/algo/geometry'
import { focalLength } from '@/algo/normals'
import type { Vec3 } from '@/algo/sh'
import { homography, type Homography } from '@/fusion/warp'
import { FOV_RANGE, PITCH_LIMIT, ROLL_LIMIT, type CameraDoc, type CameraLines, type Segment } from './model'

type Orientation = Pick<CameraDoc, 'pitch' | 'roll'>
type Intrinsics = Pick<CameraDoc, 'fovDeg'>

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const unit = (a: Vec3): Vec3 => mul(a, 1 / Math.hypot(a[0], a[1], a[2]))

export const cameraFocal = (c: Intrinsics, size: Size) => focalLength(size.width, size.height, c.fovDeg)

/** 世界的上方向（相机空间的单位向量） */
export function cameraUp(c: Orientation): Vec3 {
  const cp = Math.cos(c.pitch)
  return [-Math.sin(c.roll) * cp, Math.cos(c.roll) * cp, -Math.sin(c.pitch)]
}

/** 地面上的两个方向：相机横轴在地面上的投影，以及与之垂直、朝向相机的方向 */
export function groundAxes(c: Orientation): { right: Vec3; back: Vec3; up: Vec3 } {
  const up = cameraUp(c)
  const right = unit(add([1, 0, 0], up, -up[0]))
  return { right, back: cross(right, up), up }
}

/** 穿过文档像素 p 的射线（未归一化，z = −f） */
function ray(p: Point, size: Size, f: number): Vec3 {
  return [p.x - size.width / 2, size.height / 2 - p.y, -f]
}

/** 相机空间的点在画面上的位置（文档像素）；点不在相机前方时为 null */
export function projectPoint(x: Vec3, size: Size, f: number): Point | null {
  if (x[2] > -1e-9) return null
  return { x: size.width / 2 + (f * x[0]) / -x[2], y: size.height / 2 - (f * x[1]) / -x[2] }
}

/**
 * 画面中的地平线（文档坐标）：离画面中心最近的点、向右的方向，以及指向下方（地面一侧）的法线。
 * 地平线到中心的距离为 f·tan(俯仰)，俯仰向上时地平线在中心以下。
 */
export function horizonLine(c: CameraDoc, size: Size): { point: Point; dir: Point; normal: Point } {
  const d = -cameraFocal(c, size) * Math.tan(c.pitch)
  const s = Math.sin(c.roll)
  const k = Math.cos(c.roll)
  return {
    point: { x: size.width / 2 - s * d, y: size.height / 2 - k * d },
    dir: { x: k, y: -s },
    normal: { x: s, y: k },
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 过文档坐标 a、b 的地平线 → 俯仰与倾斜（限制在允许的范围内） */
export function orientationFromHorizon(a: Point, b: Point, size: Size, c: Intrinsics): Orientation {
  const [l, r] = a.x <= b.x ? [a, b] : [b, a]
  const roll = clamp(Math.atan2(l.y - r.y, Math.max(r.x - l.x, 1e-6)), -ROLL_LIMIT, ROLL_LIMIT)
  // 中心到地平线的有符号距离（沿画面向上的法线）
  const d = -Math.sin(roll) * (l.x - size.width / 2) + Math.cos(roll) * (size.height / 2 - l.y)
  return { pitch: clamp(Math.atan(-d / cameraFocal(c, size)), -PITCH_LIMIT, PITCH_LIMIT), roll }
}

/** 文档像素 p 处的地面点（相机空间，米）；p 不在地平线以下时为 null */
export function groundPoint(c: CameraDoc, size: Size, p: Point, height = c.height): Vec3 | null {
  const r = ray(p, size, cameraFocal(c, size))
  const ur = dot(cameraUp(c), r)
  return ur < -1e-9 ? mul(r, -height / ur) : null
}

export interface GridLine {
  a: Point
  b: Point
}

/** 网格的半径（格数） */
const GRID_CELLS = 30

/**
 * 地面网格（文档坐标的线段）：以 anchor 处的地面点为中心，间距 1 m，方向按相机的朝向。
 * anchor 不在地平线以下时为空。相机后方的部分被裁掉。
 */
export function groundGrid(c: CameraDoc, size: Size, anchor: Point): GridLine[] {
  const p0 = groundPoint(c, size, anchor)
  if (!p0) return []
  const f = cameraFocal(c, size)
  const { right, back } = groundAxes(c)
  const a = add(mul(right, Math.cos(c.yaw)), back, Math.sin(c.yaw))
  const b = add(mul(back, Math.cos(c.yaw)), right, -Math.sin(c.yaw))
  // 离相机太近的部分投影后无限长，按到相机的距离裁掉
  const near = -0.05 * c.height
  const lines: GridLine[] = []
  const segment = (from: Vec3, to: Vec3) => {
    let [p, q] = [from, to]
    if (p[2] > near && q[2] > near) return
    if (p[2] > near) p = add(q, add(p, q, -1), (near - q[2]) / (p[2] - q[2]))
    else if (q[2] > near) q = add(p, add(q, p, -1), (near - p[2]) / (q[2] - p[2]))
    const s = projectPoint(p, size, f)
    const e = projectPoint(q, size, f)
    if (s && e) lines.push({ a: s, b: e })
  }
  for (let i = -GRID_CELLS; i <= GRID_CELLS; i++) {
    segment(add(add(p0, b, i), a, -GRID_CELLS), add(add(p0, b, i), a, GRID_CELLS))
    segment(add(add(p0, a, i), b, -GRID_CELLS), add(add(p0, a, i), b, GRID_CELLS))
  }
  return lines
}

// ── 消失点标定 ──

export type SolveError = 'parallel-first' | 'parallel-second' | 'not-orthogonal' | 'out-of-range'

/** 平行线标定的结果 */
export type LineSolution = { ok: true; camera: Pick<CameraDoc, 'fovDeg' | 'pitch' | 'roll' | 'yaw'> } | { ok: false; error: SolveError }

/** 两条线段所在直线的交点（相对画面中心、y 向上的像素坐标）；两线在画面上几乎平行时为 null */
function vanishingPoint([s, t]: [Segment, Segment], size: Size): [number, number] | null {
  const k = Math.max(size.width, size.height)
  // 以长边为单位，数值接近 1
  const h = (p: Point): Vec3 => [((p.x - 0.5) * size.width) / k, ((0.5 - p.y) * size.height) / k, 1]
  const v = cross(cross(h(s[0]), h(s[1])), cross(h(t[0]), h(t[1])))
  // 消失点超过画面长边的 1000 倍时当作平行
  if (Math.abs(v[2]) < 1e-3 * Math.hypot(v[0], v[1])) return null
  return [(v[0] / v[2]) * k, (v[1] / v[2]) * k]
}

/** 两组平行线 → 视场角、俯仰、倾斜和网格朝向 */
export function solveLines(lines: CameraLines, size: Size): LineSolution {
  const fu = vanishingPoint(lines.first, size)
  if (!fu) return { ok: false, error: 'parallel-first' }
  const fv = vanishingPoint(lines.second, size)
  if (!fv) return { ok: false, error: 'parallel-second' }
  const f2 = -(fu[0] * fv[0] + fu[1] * fv[1])
  if (f2 <= 0) return { ok: false, error: 'not-orthogonal' }
  const f = Math.sqrt(f2)
  const fovDeg = (2 * Math.atan(Math.max(size.width, size.height) / 2 / f) * 180) / Math.PI
  const du = unit([fu[0], fu[1], -f])
  const dv = unit([fv[0], fv[1], -f])
  let up = lines.secondAxis === 'vertical' ? dv : unit(cross(du, dv))
  if (up[1] < 0) up = mul(up, -1)
  const pitch = -Math.asin(clamp(up[2], -1, 1))
  const roll = Math.atan2(-up[0], up[1])
  if (fovDeg < FOV_RANGE[0] || fovDeg > FOV_RANGE[1] || Math.abs(pitch) > PITCH_LIMIT || Math.abs(roll) > ROLL_LIMIT) return { ok: false, error: 'out-of-range' }
  const { right, back } = groundAxes({ pitch, roll })
  // 网格四个方向对称，朝向取 (−45°, 45°]
  const quarter = Math.PI / 2
  let yaw = Math.atan2(dot(du, back), dot(du, right))
  yaw -= quarter * Math.round(yaw / quarter)
  return { ok: true, camera: { fovDeg, pitch, roll, yaw } }
}

/** 地面上离相机较近、在画面中可见的一点（文档像素）：画面下部的中央；地面不可见时为 null */
export function groundAnchor(c: CameraDoc, size: Size): Point | null {
  const p = { x: size.width / 2, y: size.height * 0.8 }
  return groundPoint(c, size, p) ? p : null
}

/** 地面看不到时的默认线段：两组线分别向右、向左收拢 */
const FALLBACK_LINES: CameraLines = {
  first: [
    [
      { x: 0.15, y: 0.7 },
      { x: 0.45, y: 0.62 },
    ],
    [
      { x: 0.15, y: 0.9 },
      { x: 0.45, y: 0.78 },
    ],
  ],
  second: [
    [
      { x: 0.55, y: 0.62 },
      { x: 0.85, y: 0.7 },
    ],
    [
      { x: 0.55, y: 0.78 },
      { x: 0.85, y: 0.9 },
    ],
  ],
  secondAxis: 'horizontal',
}

/**
 * 与当前标定一致的平行线（文档 UV），切换到平行线方式时作为起点：
 * 第一组沿地面上与相机横轴成 45° 的方向，第二组沿与之垂直的水平方向或竖直方向。
 */
export function linesFromCamera(c: CameraDoc, size: Size, secondAxis = c.lines?.secondAxis ?? 'horizontal'): CameraLines {
  const anchor = groundAnchor(c, size)
  const p0 = anchor && groundPoint(c, size, anchor)
  if (!p0) return { ...FALLBACK_LINES, secondAxis }
  const f = cameraFocal(c, size)
  const { right, back, up } = groundAxes(c)
  const d = Math.hypot(...p0)
  const a = unit(add(right, back, -1))
  const b = unit(add(right, back))
  const uv = (x: Vec3): Point => {
    const p = projectPoint(x, size, f) ?? { x: 0, y: 0 }
    return { x: p.x / size.width, y: p.y / size.height }
  }
  const seg = (center: Vec3, dir: Vec3, half: number): Segment => [uv(add(center, dir, -half)), uv(add(center, dir, half))]
  const w = 0.25 * d
  const first: [Segment, Segment] = [seg(add(p0, b, -w), a, 0.3 * d), seg(add(p0, b, w), a, 0.3 * d)]
  const second: [Segment, Segment] =
    secondAxis === 'vertical'
      ? [seg(add(add(p0, a, -w), up, 0.3 * d), up, 0.3 * d), seg(add(add(p0, a, w), up, 0.3 * d), up, 0.3 * d)]
      : [seg(add(p0, a, -w), b, 0.3 * d), seg(add(p0, a, w), b, 0.3 * d)]
  return { first, second, secondAxis }
}

// ── 立在地面上的物体 ──

/** 3×3 矩阵乘法（行优先） */
function mat3(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const m = new Float64Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return m
}

/** 相机空间方向 ↔ 文档像素的齐次坐标 */
function intrinsics(size: Size, f: number): { k: Float64Array; inverse: Float64Array } {
  const [cx, cy] = [size.width / 2, size.height / 2]
  return {
    k: Float64Array.of(f, 0, -cx, 0, -f, -cy, 0, 0, -1),
    inverse: Float64Array.of(1 / f, 0, -cx / f, 0, -1 / f, cy / f, 0, 0, -1),
  }
}

/**
 * 倒影的单应变换（文档像素 → 文档像素）：把立绘看作立在 foot 处的竖直平面（横向为相机横轴在地面上的投影），
 * 画面上一点经这个平面关于水面（过 foot 的水平面）镜像后的位置。镜像两次回到原处，所以它也是自己的逆。
 * 相机水平时就是关于过 foot 的水平线上下翻转。
 */
export function mirrorHomography(c: CameraDoc, size: Size, foot: Point): Homography {
  const f = cameraFocal(c, size)
  const { up, back } = groundAxes(c)
  const p = ray(foot, size, f)
  const db = dot(back, p)
  const b = mul(up, 2 * dot(up, p))
  // 平面上的点 X = db·K⁻¹q / (n·K⁻¹q)，镜像为 A·X + b（A = I − 2·up·upᵀ），投影回画面：K·(db·A + b·nᵀ)·K⁻¹
  const m = new Float64Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = db * ((i === j ? 1 : 0) - 2 * up[i] * up[j]) + b[i] * back[j]
  const { k, inverse } = intrinsics(size, f)
  const h = mat3(mat3(k, m), inverse)
  const s = Math.abs(h[8]) > 1e-12 ? h[8] : 1
  return h.map((v) => v / s)
}

/** 文档像素的单应变换 → 文档 UV 的单应变换 */
export function homographyToUV(h: Homography, size: Size): Homography {
  const s = Float64Array.of(size.width, 0, 0, 0, size.height, 0, 0, 0, 1)
  const inv = Float64Array.of(1 / size.width, 0, 0, 0, 1 / size.height, 0, 0, 0, 1)
  return mat3(mat3(inv, h), s)
}

/** 画面中立在 foot 处、高 heightPx 像素的物体，在世界中的高度（米）；foot 不在地面上时为 null */
export function standingHeight(c: CameraDoc, size: Size, foot: Point, heightPx: number): number | null {
  const p0 = groundPoint(c, size, foot)
  if (!p0) return null
  const f = cameraFocal(c, size)
  const up = cameraUp(c)
  // 画面中物体向上的方向：竖直线的投影
  const tip = projectPoint(add(p0, up, 1e-3 * Math.hypot(...p0)), size, f)
  if (!tip) return null
  const len = Math.hypot(tip.x - foot.x, tip.y - foot.y) || 1
  const top = { x: foot.x + ((tip.x - foot.x) / len) * heightPx, y: foot.y + ((tip.y - foot.y) / len) * heightPx }
  // 竖直线 p0 + s·up 与穿过 top 的射线最接近的位置
  const r = ray(top, size, f)
  const b = dot(up, r)
  const cc = dot(r, r)
  const denom = cc - b * b
  if (denom < 1e-12) return null
  const s = (b * dot(r, p0) - cc * dot(up, p0)) / denom
  return s > 0 ? s : null
}

/** 立在地面上、世界中高 height 米的物体在 foot 处的画面高度（像素）；看不到时为 null */
function standingPixels(c: CameraDoc, size: Size, foot: Point, height: number): number | null {
  const p0 = groundPoint(c, size, foot)
  const top = p0 && projectPoint(add(p0, cameraUp(c), height), size, cameraFocal(c, size))
  return top ? Math.hypot(top.x - foot.x, top.y - foot.y) : null
}

/**
 * 立在地面上的物体从 from 移到 to、在世界中高度不变时，画面中大小的比例。
 * heightPx 为物体在 from 处的画面高度。任一处不在地面上时为 null。
 */
export function standingScale(c: CameraDoc, size: Size, from: Point, to: Point, heightPx: number): number | null {
  const height = standingHeight(c, size, from, heightPx)
  if (!height) return null
  const a = standingPixels(c, size, from, height)
  const b = standingPixels(c, size, to, height)
  return a && b ? b / a : null
}

/**
 * 按相机透视立起来的立绘：立绘原本按相机水平时的样子平放在画面上，这里把它当作立在 foot 处的竖直平面，
 * 求出它在标定的相机下的样子，再以 foot 为中心缩放，使 foot 上方 heightPx 处的点仍在原来的高度。
 * 返回文档像素 → 文档像素的单应变换；foot 不在地面上时为 null。
 */
export function standingPerspective(c: CameraDoc, size: Size, foot: Point, heightPx: number): Homography | null {
  const p0 = groundPoint(c, size, foot)
  if (!p0) return null
  const f = cameraFocal(c, size)
  const { right, up } = groundAxes(c)
  // 文档中相对 foot 的偏移 (dx, dy) → 平面上的点 p0 + dx·k·right − dy·k·up，k 为 foot 处每像素的长度
  const k = -p0[2] / f
  const toPlane = (q: Point): Vec3 => add(add(p0, right, (q.x - foot.x) * k), up, -(q.y - foot.y) * k)
  const map = (q: Point) => projectPoint(toPlane(q), size, f)
  const top = map({ x: foot.x, y: foot.y - heightPx })
  if (!top) return null
  const scale = heightPx / (Math.hypot(top.x - foot.x, top.y - foot.y) || 1)
  // 四个点确定单应变换：取 foot 周围、立绘大小的正方形
  const src = [
    { x: foot.x - heightPx, y: foot.y - heightPx },
    { x: foot.x + heightPx, y: foot.y - heightPx },
    { x: foot.x + heightPx, y: foot.y },
    { x: foot.x - heightPx, y: foot.y },
  ]
  const dst: Point[] = []
  for (const q of src) {
    const m = map(q)
    if (!m) return null
    dst.push({ x: foot.x + (m.x - foot.x) * scale, y: foot.y + (m.y - foot.y) * scale })
  }
  return homography(src, dst)
}
