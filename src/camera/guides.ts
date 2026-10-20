/**
 * 相机标定的参考形状（docs/Plan.md §3.7 M8.5 补充）：放在地面上的原点处，按标定的相机投影到画面上，
 * 拖到画面各处检查是否始终贴合照片。坐标轴见 sceneAxes：x（红）、z（蓝）水平，y（绿）向上，单位为米。
 */
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { cameraFocal, groundAxes, groundPoint, horizonLine, projectPoint, ray, sceneAxes } from './geometry'
import type { CameraDoc } from './model'
import { add, dot, mul } from './vec'

export const GUIDE_KINDS = ['ground', 'wallX', 'wallZ', 'box', 'figure', 'none'] as const
export type GuideKind = (typeof GUIDE_KINDS)[number]

/** 三根轴的颜色（红、绿、蓝），平行线按所沿的轴取色 */
export const AXIS_COLORS = { x: 'rgb(248, 113, 113)', y: 'rgb(74, 222, 128)', z: 'rgb(96, 165, 250)' } as const

/** 立方体边长的范围（米） */
export const BOX_RANGE: readonly [number, number] = [0.25, 10]
/** 人形标尺的身高（米） */
export const FIGURE_HEIGHT = 1.7
/** 地面网格的半径（格数，每格 1 m） */
const GROUND_CELLS = 30
/** 竖直网格的半宽和高度（米） */
const WALL_HALF = 5
const WALL_HEIGHT = 4
/** 坐标轴的长度（米） */
const AXIS_LENGTH = 1

export interface GuideLine {
  a: Point
  b: Point
}

export interface GuideGeometry {
  /** 网格线或棱（文档坐标） */
  lines: GuideLine[]
  /** 人形的轮廓（文档坐标） */
  outline: Point[] | null
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

/** 人形标尺的右半边轮廓（米，x 向右、y 向上，身高 FIGURE_HEIGHT），从头顶开始顺时针 */
const FIGURE_HALF: [number, number][] = (() => {
  const head: [number, number][] = []
  // 头：圆心 (0, 1.585)，半径 0.115，从头顶画到颈部
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI / 2 - (i / 8) * (Math.PI * 0.85)
    head.push([0.115 * Math.cos(a), 1.585 + 0.115 * Math.sin(a)])
  }
  return [
    ...head,
    [0.05, 1.45],
    [0.19, 1.42],
    [0.235, 1.37],
    [0.255, 1.1],
    [0.245, 0.83],
    [0.205, 0.8],
    [0.195, 1.05],
    [0.175, 1.24],
    [0.16, 1.0],
    [0.17, 0.88],
    [0.15, 0.45],
    [0.125, 0.06],
    [0.14, 0],
    [0.03, 0],
    [0.035, 0.45],
    [0, 0.78],
  ]
})()
/** 完整的轮廓：右半边加上镜像的左半边 */
const FIGURE_OUTLINE: [number, number][] = [...FIGURE_HALF, ...FIGURE_HALF.slice(1, -1).reverse().map(([x, y]): [number, number] => [-x, y])]

/** 默认的原点：画面下部的中央；那里不在地面上时取地平线以下的一点 */
export function defaultOrigin(c: CameraDoc, size: Size): Point {
  const p = { x: size.width / 2, y: size.height * 0.8 }
  if (groundPoint(c, size, p)) return p
  const h = horizonLine(c, size)
  return { x: h.point.x + h.normal.x * 0.25 * size.height, y: h.point.y + h.normal.y * 0.25 * size.height }
}

/** 参考形状在画面上的样子；origin 不在地面上或 kind 为 none 时为 null */
export function guideGeometry(c: CameraDoc, size: Size, kind: GuideKind, origin: Point, boxSize = 1): GuideGeometry | null {
  const o = kind === 'none' ? null : groundPoint(c, size, origin)
  if (!o) return null
  const f = cameraFocal(c, size)
  const near = nearZ(c)
  const { x, y, z } = sceneAxes(c)
  const at = (u: number, v: number, w: number) => add(add(add(o, x, u), y, v), z, w)
  const lines: GuideLine[] = []
  const segment = (p: Vec3, q: Vec3) => {
    const clipped = clipSegment(p, q, near)
    const a = clipped && projectPoint(clipped[0], size, f)
    const b = clipped && projectPoint(clipped[1], size, f)
    if (a && b) lines.push({ a, b })
  }
  const polygon = (poly: Vec3[]) => clipPolygon(poly, near).flatMap((p) => projectPoint(p, size, f) ?? [])
  let outline: Point[] | null = null
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
    const s = boxSize / 2
    const corner = (i: number) => at(i & 1 ? s : -s, i & 2 ? boxSize : 0, i & 4 ? s : -s)
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4])
        if (!(i & bit)) segment(corner(i), corner(i | bit))
    // 拾取区域：棱在相机前方的部分的凸包
    const ends = lines.flatMap((l) => [l.a, l.b])
    hit = ends.length ? [convexHull(ends)] : []
  } else if (kind === 'figure') {
    // 人形面向相机：立在相机横轴在地面上的投影与上方向张成的平面上
    const { right } = groundAxes(c)
    const poly = FIGURE_OUTLINE.map(([u, v]) => add(add(o, right, u), y, v))
    outline = polygon(poly)
    hit = outline.length ? [outline] : []
  }
  const tip = (d: Vec3) => {
    const clipped = clipSegment(o, add(o, d, AXIS_LENGTH), near)
    return clipped && projectPoint(clipped[1], size, f)
  }
  return { lines, outline, hit, axes: { origin, x: tip(x), y: tip(y), z: tip(z) } }
}

/** 文档像素 p 处、离地面 h 米的水平面上的点（相机空间）；看不到时为 null */
export function pointAtHeight(c: CameraDoc, size: Size, p: Point, h: number): Vec3 | null {
  const r = ray(p, size, cameraFocal(c, size))
  const ur = dot(groundAxes(c).up, r)
  if (Math.abs(ur) < 1e-9) return null
  const t = (h - c.height) / ur
  return t > 0 ? mul(r, t) : null
}

/** 在参考形状上按下的点离地面的高度（米）：拖动时在这个高度的水平面上平移 */
export function grabHeight(c: CameraDoc, size: Size, kind: GuideKind, origin: Point, p: Point, boxSize = 1): number {
  const o = groundPoint(c, size, origin)
  if (!o || kind === 'ground' || kind === 'none') return 0
  const { x, y, z } = sceneAxes(c)
  // 按下的点所在的竖直平面：竖直网格所在的平面，立方体和人形取面向相机的平面
  const normal = kind === 'wallX' ? z : kind === 'wallZ' ? x : groundAxes(c).back
  const r = ray(p, size, cameraFocal(c, size))
  const rn = dot(normal, r)
  if (Math.abs(rn) < 1e-9) return 0
  const t = dot(normal, o) / rn
  if (t <= 0) return 0
  const h = dot(y, add(mul(r, t), o, -1))
  const top = kind === 'box' ? boxSize : kind === 'figure' ? FIGURE_HEIGHT : WALL_HEIGHT
  return Math.min(top, Math.max(0, h))
}

/**
 * 拖动参考形状：在 start 处按下、移到 p 时原点的新位置（文档坐标）。在离地 h 米的水平面上平移，
 * 新位置不在相机前方时为 null。
 */
export function dragOrigin(c: CameraDoc, size: Size, origin: Point, h: number, start: Point, p: Point): Point | null {
  const o = groundPoint(c, size, origin)
  const a = pointAtHeight(c, size, start, h)
  const b = pointAtHeight(c, size, p, h)
  if (!o || !a || !b) return null
  const moved = add(o, add(b, a, -1))
  return moved[2] < nearZ(c) ? projectPoint(moved, size, cameraFocal(c, size)) : null
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
