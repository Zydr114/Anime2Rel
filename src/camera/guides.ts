/**
 * 相机标定的参考形状（docs/Plan.md §3.7 M8.5 补充）：放在地面上的原点处，按标定的相机投影到画面上，
 * 拖到画面各处检查是否始终贴合照片。坐标轴见 sceneAxes：x（红）、z（蓝）水平，y（绿）向上。
 * 与 fSpy 一样，形状的单位长度按原点到相机的距离换算，拖到哪里在画面上都差不多大；它只用来检查透视，不代表实际尺寸。
 */
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { cameraFocal, groundAxes, groundPoint, horizonLine, pointAbove, projectPoint, ray, sceneAxes } from './geometry'
import type { CameraDoc } from './model'
import { add, dot, mul } from './vec'

export const GUIDE_KINDS = ['ground', 'wallX', 'wallZ', 'box', 'none'] as const
export type GuideKind = (typeof GUIDE_KINDS)[number]

/** 三根轴的颜色（红、绿、蓝），平行线按所沿的轴取色 */
export const AXIS_COLORS = { x: 'rgb(248, 113, 113)', y: 'rgb(74, 222, 128)', z: 'rgb(96, 165, 250)' } as const

/** 参考形状大小倍数的范围 */
export const GUIDE_SCALE_RANGE: readonly [number, number] = [0.25, 4]
/** 单位长度在原点处约占画面长边的比例 */
const UNIT_SCREEN = 0.1
/** 地面网格的半径（格数） */
const GROUND_CELLS = 60
/** 竖直网格的半宽和高度（格数） */
const WALL_HALF = 5
const WALL_HEIGHT = 4
/** 立方体的边长（单位长度） */
const BOX_EDGE = 2
/** 坐标轴的长度（单位长度，不随大小倍数变化） */
const AXIS_LENGTH = 1

export interface GuideLine {
  a: Point
  b: Point
}

export interface GuideGeometry {
  /** 网格线或棱（文档坐标） */
  lines: GuideLine[]
  /** 按下后拖动整个形状的区域（文档坐标的多边形） */
  hit: Point[][]
  /** 原点和三根轴的末端；末端不在相机前方时为 null */
  axes: { origin: Point; x: Point | null; y: Point | null; z: Point | null }
}

/** 离相机太近的部分投影后无限长，按到相机的距离裁掉 */
const nearZ = (c: CameraDoc) => -0.05 * c.height

function clipSegment(p: Vec3, q: Vec3, near: number): [Vec3, Vec3] | null {
  if (p[2] > near && q[2] > near) return null
  if (p[2] > near) return [add(q, add(p, q, -1), (near - q[2]) / (p[2] - q[2])), q]
  if (q[2] > near) return [p, add(p, add(q, p, -1), (near - p[2]) / (q[2] - p[2]))]
  return [p, q]
}

/** 多边形在相机前方的部分（Sutherland–Hodgman） */
function clipPolygon(poly: Vec3[], near: number): Vec3[] {
  const out: Vec3[] = []
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length]
    const [pin, qin] = [p[2] <= near, q[2] <= near]
    if (pin) out.push(p)
    if (pin !== qin) out.push(add(p, add(q, p, -1), (near - p[2]) / (q[2] - p[2])))
  })
  return out
}

/** 文档坐标中的凸包（单调链） */
function convexHull(points: Point[]): Point[] {
  const ps = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (ps.length < 3) return ps
  const side = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: Point[]) => {
    const h: Point[] = []
    for (const p of list) {
      while (h.length >= 2 && side(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  return [...half(ps), ...half(ps.reverse())]
}

/** 画面中地面的部分：画面矩形在地平线以下的部分 */
function groundRegion(c: CameraDoc, size: Size): Point[] {
  const h = horizonLine(c, size)
  const rect = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ]
  const side = (p: Point) => (p.x - h.point.x) * h.normal.x + (p.y - h.point.y) * h.normal.y
  const out: Point[] = []
  rect.forEach((p, i) => {
    const q = rect[(i + 1) % rect.length]
    const [sp, sq] = [side(p), side(q)]
    if (sp > 0) out.push(p)
    if (sp > 0 !== sq > 0) {
      const t = sp / (sp - sq)
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
    }
  })
  return out
}

/** 单位长度与原点深度之比：原点在相机空间 o 处时，单位长度为 k·(−o_z) 米 */
const unitPerDepth = (c: CameraDoc, size: Size) => (UNIT_SCREEN * Math.max(size.width, size.height)) / cameraFocal(c, size)

/** 默认的原点：画面下部的中央；那里不在地面上时取地平线以下的一点 */
export function defaultOrigin(c: CameraDoc, size: Size): Point {
  const p = { x: size.width / 2, y: size.height * 0.8 }
  if (groundPoint(c, size, p)) return p
  const h = horizonLine(c, size)
  return { x: h.point.x + h.normal.x * 0.25 * size.height, y: h.point.y + h.normal.y * 0.25 * size.height }
}

/** 测量杆的初始高度（米） */
export const ROD_HEIGHT = 1.7

/** 测量杆的默认位置：底端在画面左下部，高 ROD_HEIGHT */
export function defaultRod(c: CameraDoc, size: Size): { foot: Point; top: Point } {
  let foot = { x: size.width * 0.3, y: size.height * 0.85 }
  if (!groundPoint(c, size, foot)) {
    const o = defaultOrigin(c, size)
    foot = { x: o.x - size.width * 0.2, y: o.y }
  }
  return { foot, top: pointAbove(c, size, foot, ROD_HEIGHT) ?? { x: foot.x, y: foot.y - size.height * 0.2 } }
}

/** 参考形状在画面上的样子，scale 为大小倍数；origin 不在地面上或 kind 为 none 时为 null */
export function guideGeometry(c: CameraDoc, size: Size, kind: GuideKind, origin: Point, scale = 1): GuideGeometry | null {
  const o = kind === 'none' ? null : groundPoint(c, size, origin)
  if (!o) return null
  const f = cameraFocal(c, size)
  const near = nearZ(c)
  const { x, y, z } = sceneAxes(c)
  const unit = -o[2] * unitPerDepth(c, size)
  const cell = unit * scale
  const at = (u: number, v: number, w: number) => add(add(add(o, x, u * cell), y, v * cell), z, w * cell)
  const lines: GuideLine[] = []
  const segment = (p: Vec3, q: Vec3) => {
    const clipped = clipSegment(p, q, near)
    const a = clipped && projectPoint(clipped[0], size, f)
    const b = clipped && projectPoint(clipped[1], size, f)
    if (a && b) lines.push({ a, b })
  }
  const polygon = (poly: Vec3[]) => clipPolygon(poly, near).flatMap((p) => projectPoint(p, size, f) ?? [])
  let hit: Point[][] = []
  if (kind === 'ground') {
    const n = GROUND_CELLS
    for (let i = -n; i <= n; i++) {
      segment(at(-n, 0, i), at(n, 0, i))
      segment(at(i, 0, -n), at(i, 0, n))
    }
    hit = [groundRegion(c, size)]
  } else if (kind === 'wallX' || kind === 'wallZ') {
    // 沿红轴的网格在 x–y 平面上，沿蓝轴的在 z–y 平面上
    const on = (s: number, v: number) => (kind === 'wallX' ? at(s, v, 0) : at(0, v, s))
    for (let i = -WALL_HALF; i <= WALL_HALF; i++) segment(on(i, 0), on(i, WALL_HEIGHT))
    for (let j = 0; j <= WALL_HEIGHT; j++) segment(on(-WALL_HALF, j), on(WALL_HALF, j))
    hit = [polygon([on(-WALL_HALF, 0), on(WALL_HALF, 0), on(WALL_HALF, WALL_HEIGHT), on(-WALL_HALF, WALL_HEIGHT)])]
  } else if (kind === 'box') {
    const s = BOX_EDGE / 2
    const corner = (i: number) => at(i & 1 ? s : -s, i & 2 ? BOX_EDGE : 0, i & 4 ? s : -s)
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4])
        if (!(i & bit)) segment(corner(i), corner(i | bit))
    // 拾取区域：棱在相机前方的部分的凸包
    const ends = lines.flatMap((l) => [l.a, l.b])
    hit = ends.length ? [convexHull(ends)] : []
  }
  const tip = (d: Vec3) => {
    const clipped = clipSegment(o, add(o, d, AXIS_LENGTH * unit), near)
    return clipped && projectPoint(clipped[1], size, f)
  }
  return { lines, hit, axes: { origin, x: tip(x), y: tip(y), z: tip(z) } }
}

/**
 * 在参考形状上按下的点相对原点的偏移（相机空间，以原点处的单位长度计），拖动时让这一点始终在光标下。
 * 按下的点取光标视线与形状所在平面的交点：地面网格取地面，竖直网格取所在的竖直面，立方体取过原点、正对相机的竖直面。
 */
export function grabOffset(c: CameraDoc, size: Size, kind: GuideKind, origin: Point, p: Point): Vec3 {
  const o = groundPoint(c, size, origin)
  if (!o || kind === 'none') return [0, 0, 0]
  const { x, z } = sceneAxes(c)
  const { up, back } = groundAxes(c)
  const normal = kind === 'ground' ? up : kind === 'wallX' ? z : kind === 'wallZ' ? x : back
  const r = ray(p, size, cameraFocal(c, size))
  const rn = dot(normal, r)
  const t = Math.abs(rn) < 1e-9 ? 0 : dot(normal, o) / rn
  if (t <= 0) return [0, 0, 0]
  return mul(add(mul(r, t), o, -1), 1 / (-o[2] * unitPerDepth(c, size)))
}

/**
 * 拖动参考形状：按下的点（offset 见 grabOffset）移到光标 p 下方时原点的新位置（文档坐标）。
 * 单位长度随原点的深度变化：按下的点 P = O − k·O_z·offset = (I − k·offset·e_zᵀ)·O，令 P = t·r（光标的视线）、
 * O 在地面上，按 Sherman–Morrison 求逆即得 O。求不出或原点不在相机前方时为 null。
 */
export function dragOrigin(c: CameraDoc, size: Size, offset: Vec3, p: Point): Point | null {
  const f = cameraFocal(c, size)
  const k = unitPerDepth(c, size)
  const r = ray(p, size, f)
  const d = 1 - k * offset[2]
  if (d <= 1e-9) return null
  const w = add(r, offset, (k * r[2]) / d)
  const uw = dot(groundAxes(c).up, w)
  if (Math.abs(uw) < 1e-12) return null
  const t = -c.height / uw
  const o = mul(w, t)
  return t > 0 && o[2] < nearZ(c) ? projectPoint(o, size, f) : null
}

/** 让红轴（axis 为 x）或蓝轴（z）从原点指向 p 处地面的参考方向（弧度，(−π, π]）；p 不在地面上时为 null */
export function yawToward(c: CameraDoc, size: Size, origin: Point, p: Point, axis: 'x' | 'z'): number | null {
  const o = groundPoint(c, size, origin)
  const g = groundPoint(c, size, p)
  if (!o || !g) return null
  const { right, back } = groundAxes(c)
  const v = add(g, o, -1)
  let yaw = Math.atan2(dot(v, back), dot(v, right)) - (axis === 'z' ? Math.PI / 2 : 0)
  if (yaw <= -Math.PI) yaw += 2 * Math.PI
  return yaw
}
