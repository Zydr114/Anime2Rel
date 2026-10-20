/**
 * 立绘变形（docs/Plan.md §3.7 M8.3）：先做网格变形 G，再做四角透视 H，W(p) = H(G(p))。
 * 坐标都是立绘 UV（左上角为原点，立绘本身为 [0,1]²，变形后可以超出），变形发生在移动、缩放、旋转、翻转之前。
 * - 网格变形：n×n 个控制点，控制点之间按 Catmull-Rom 样条插值（双三次，经过各控制点），控制点在默认位置时不变形。
 * - 四角透视：单应变换，把单位正方形的四角映射到 corners。
 * GPU 把立绘画到按 W 摆放的细分网格上（src/engine/warp.ts）；这里的网格与之相同，用于逆变换和 Worker 中的几何统计。
 */
import type { Point } from '@/algo/geometry'
import { solveLinear } from '@/algo/linalg'
import { num, oneOf, record } from '@/io/conform'

export const WARP_GRID_SIZES = [3, 4, 5, 6] as const
export type WarpGridSize = (typeof WARP_GRID_SIZES)[number]
export const DEFAULT_WARP_GRID: WarpGridSize = 4
/** 控制点和四角允许的范围（立绘 UV）：最多超出立绘一倍 */
export const WARP_MIN = -1
export const WARP_MAX = 2
/** 细分网格每边的段数 */
export const WARP_SEGMENTS = 64
/** 透视的分母下限：网格上的点不能接近单应变换的地平线 */
const MIN_W = 0.05
const EPS = 1e-6

export interface CharWarp {
  /** 网格变形每边的控制点数 */
  grid: WarpGridSize
  /** 控制点在透视之前的位置（立绘 UV），按行从上到下、每行从左到右，共 grid² 个 */
  points: Point[]
  /** 立绘四角（左上、右上、右下、左下）在透视后的位置（立绘 UV），即单位正方形四角经单应变换的结果 */
  corners: Point[]
}

export const UNIT_CORNERS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/** 默认位置的控制点：均匀分布在立绘上 */
export function gridPoints(n: number): Point[] {
  const out: Point[] = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push({ x: i / (n - 1), y: j / (n - 1) })
  return out
}

export const IDENTITY_WARP: CharWarp = { grid: DEFAULT_WARP_GRID, points: gridPoints(DEFAULT_WARP_GRID), corners: UNIT_CORNERS.map((p) => ({ ...p })) }

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

export const hasPerspective = (w: CharWarp) => !w.corners.every((c, i) => near(c, UNIT_CORNERS[i]))

export function hasGridWarp(w: CharWarp): boolean {
  const d = gridPoints(w.grid)
  return !w.points.every((p, i) => near(p, d[i]))
}

const identityCache = new WeakMap<CharWarp, boolean>()

export function isIdentityWarp(w: CharWarp): boolean {
  let v = identityCache.get(w)
  if (v === undefined) identityCache.set(w, (v = !hasPerspective(w) && !hasGridWarp(w)))
  return v
}

/** 网格控制点的索引：网格的四角（左上、右上、右下、左下） */
export function gridCornerIndices(n: number): number[] {
  return [0, n - 1, n * n - 1, n * (n - 1)]
}

// ── 单应变换 ──

/** 3×3 行主序矩阵 */
export type Homography = Float64Array

/** 把 src 的四个点分别映射到 dst 的单应变换；退化（三点共线等）时返回 null */
export function homography(src: readonly Point[], dst: readonly Point[]): Homography | null {
  const a = new Float64Array(64)
  const b = new Float64Array(8)
  for (let k = 0; k < 4; k++) {
    const { x, y } = src[k]
    const { x: X, y: Y } = dst[k]
    a.set([x, y, 1, 0, 0, 0, -X * x, -X * y], 2 * k * 8)
    a.set([0, 0, 0, x, y, 1, -Y * x, -Y * y], (2 * k + 1) * 8)
    b[2 * k] = X
    b[2 * k + 1] = Y
  }
  const h = solveLinear(a, b, 8)
  return h && h.every(Number.isFinite) ? Float64Array.of(...h, 1) : null
}

/** 齐次坐标的分母 w 与变换结果 */
export function project(h: Homography, p: Point): Point & { w: number } {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w, w }
}

export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, k, l] = h
  const A = e * l - f * k
  const B = c * k - b * l
  const C = b * f - c * e
  const det = a * A + d * B + g * C
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const inv = Float64Array.of(A, B, C, f * g - d * l, a * l - c * g, c * d - a * f, d * k - e * g, b * g - a * k, a * e - b * d)
  for (let i = 0; i < 9; i++) inv[i] /= det
  return inv
}

/** 四边形是否严格凸（顶点按顺序排列，任意方向） */
export function isConvex(q: readonly Point[]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const c = q[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) return false
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return true
}

// ── 网格变形 ──

/** Catmull-Rom 的四个权重 */
function catmullRom(t: number): [number, number, number, number] {
  const t2 = t * t
  const t3 = t2 * t
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]
}

interface Compiled {
  n: number
  /** 向外线性延伸一圈的控制点，(n+2)² 个，x、y 交错存放 */
  ext: Float64Array
  /** 透视；没有透视时为 null */
  h: Homography | null
}

const compiled = new WeakMap<CharWarp, Compiled>()

function compile(w: CharWarp): Compiled {
  let c = compiled.get(w)
  if (c) return c
  const n = w.grid
  const m = n + 2
  const ext = new Float64Array(m * m * 2)
  const set = (i: number, j: number, x: number, y: number) => ext.set([x, y], ((j + 1) * m + i + 1) * 2)
  const get = (i: number, j: number) => [ext[((j + 1) * m + i + 1) * 2], ext[((j + 1) * m + i + 1) * 2 + 1]]
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) set(i, j, w.points[j * n + i].x, w.points[j * n + i].y)
  // 边界外的一圈按相邻两点线性延伸：Catmull-Rom 在边界处也经过控制点，默认网格保持恒等
  const extend = (a: number[], b: number[]) => [2 * a[0] - b[0], 2 * a[1] - b[1]] as const
  for (let j = 0; j < n; j++) {
    set(-1, j, ...extend(get(0, j), get(1, j)))
    set(n, j, ...extend(get(n - 1, j), get(n - 2, j)))
  }
  for (let i = -1; i <= n; i++) {
    set(i, -1, ...extend(get(i, 0), get(i, 1)))
    set(i, n, ...extend(get(i, n - 1), get(i, n - 2)))
  }
  c = { n, ext, h: hasPerspective(w) ? homography(UNIT_CORNERS, w.corners) : null }
  compiled.set(w, c)
  return c
}

/** 网格变形 G：原立绘 UV → 透视之前的位置 */
function gridWarp(c: Compiled, p: Point): Point {
  const { n, ext } = c
  const m = n + 2
  const su = p.x * (n - 1)
  const sv = p.y * (n - 1)
  const i = Math.min(n - 2, Math.max(0, Math.floor(su)))
  const j = Math.min(n - 2, Math.max(0, Math.floor(sv)))
  const wu = catmullRom(su - i)
  const wv = catmullRom(sv - j)
  let x = 0
  let y = 0
  for (let b = 0; b < 4; b++) {
    const row = (j + b) * m
    for (let a = 0; a < 4; a++) {
      const k = (row + i + a) * 2
      const wt = wu[a] * wv[b]
      x += wt * ext[k]
      y += wt * ext[k + 1]
    }
  }
  return { x, y }
}

/** 网格变形 G：原立绘 UV → 透视之前的位置 */
export function gridPoint(w: CharWarp, p: Point): Point {
  return gridWarp(compile(w), p)
}

/** 原立绘 UV → 变形后的立绘 UV */
export function warpPoint(w: CharWarp, p: Point): Point {
  if (isIdentityWarp(w)) return p
  const c = compile(w)
  const g = gridWarp(c, p)
  if (!c.h) return g
  const q = project(c.h, g)
  return { x: q.x, y: q.y }
}

/** 换成另一种网格密度：新控制点取原网格变形在新位置上的值，透视不变 */
export function resampleGrid(w: CharWarp, grid: WarpGridSize): CharWarp {
  if (grid === w.grid) return w
  const c = compile(w)
  const points = hasGridWarp(w) ? gridPoints(grid).map((p) => gridWarp(c, p)) : gridPoints(grid)
  return { ...w, grid, points }
}

// ── 细分网格 ──

export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface WarpMesh {
  segments: number
  /** 顶点变形后的位置（立绘 UV），(segments+1)² 个，按行排列，x、y 交错存放；顶点的原 UV 为 (i, j) / segments */
  positions: Float64Array
  bounds: Bounds
  /** 透视在整个网格上都有效（不接近地平线），且所有顶点都在允许的范围内 */
  valid: boolean
}

const meshes = new WeakMap<CharWarp, WarpMesh>()

export function warpMesh(w: CharWarp, segments = WARP_SEGMENTS): WarpMesh {
  const cached = segments === WARP_SEGMENTS ? meshes.get(w) : undefined
  if (cached) return cached
  const c = compile(w)
  const n = segments + 1
  const positions = new Float64Array(n * n * 2)
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  let valid = !hasPerspective(w) || c.h !== null
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let p = gridWarp(c, { x: i / segments, y: j / segments })
      if (c.h) {
        const q = project(c.h, p)
        if (!(q.w > MIN_W)) valid = false
        p = q
      }
      if (!(p.x >= WARP_MIN - 0.5 && p.x <= WARP_MAX + 0.5 && p.y >= WARP_MIN - 0.5 && p.y <= WARP_MAX + 0.5)) valid = false
      positions[(j * n + i) * 2] = p.x
      positions[(j * n + i) * 2 + 1] = p.y
      bounds.x0 = Math.min(bounds.x0, p.x)
      bounds.y0 = Math.min(bounds.y0, p.y)
      bounds.x1 = Math.max(bounds.x1, p.x)
      bounds.y1 = Math.max(bounds.y1, p.y)
    }
  const mesh = { segments, positions, bounds, valid }
  if (segments === WARP_SEGMENTS) meshes.set(w, mesh)
  return mesh
}

/** 变形是否可用：透视有效、四角构成凸四边形、所有点在允许的范围内 */
export function isValidWarp(w: CharWarp): boolean {
  if (isIdentityWarp(w)) return true
  if (hasPerspective(w) && !isConvex(w.corners)) return false
  return warpMesh(w).valid
}

/** 网格的两个三角形：顶点 (i,j)、(i+1,j)、(i+1,j+1) 与 (i,j)、(i+1,j+1)、(i,j+1) */
function forEachTriangle(mesh: WarpMesh, visit: (a: number, b: number, c: number) => boolean | void): void {
  const s = mesh.segments
  const n = s + 1
  for (let j = 0; j < s; j++)
    for (let i = 0; i < s; i++) {
      const a = j * n + i
      if (visit(a, a + 1, a + n + 1) || visit(a, a + n + 1, a + n)) return
    }
}

const vertexUV = (mesh: WarpMesh, k: number): Point => ({ x: (k % (mesh.segments + 1)) / mesh.segments, y: Math.floor(k / (mesh.segments + 1)) / mesh.segments })

/**
 * 逆变形：变形后的立绘 UV → 原立绘 UV。点在变形后的立绘之外时，取外框上最近的点（inside 为 false）。
 * 网格有折叠时取找到的第一个三角形。
 */
export function unwarpPoint(w: CharWarp, q: Point): { point: Point; inside: boolean } {
  if (isIdentityWarp(w)) return { point: q, inside: q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 }
  const mesh = warpMesh(w)
  const pos = mesh.positions
  let hit: Point | null = null
  forEachTriangle(mesh, (a, b, c) => {
    const ax = pos[a * 2]
    const ay = pos[a * 2 + 1]
    const e1x = pos[b * 2] - ax
    const e1y = pos[b * 2 + 1] - ay
    const e2x = pos[c * 2] - ax
    const e2y = pos[c * 2 + 1] - ay
    const det = e1x * e2y - e1y * e2x
    if (Math.abs(det) < 1e-14) return
    const dx = q.x - ax
    const dy = q.y - ay
    const s = (dx * e2y - dy * e2x) / det
    const t = (e1x * dy - e1y * dx) / det
    if (s < -1e-9 || t < -1e-9 || s + t > 1 + 1e-9) return
    const ua = vertexUV(mesh, a)
    const ub = vertexUV(mesh, b)
    const uc = vertexUV(mesh, c)
    hit = { x: ua.x + s * (ub.x - ua.x) + t * (uc.x - ua.x), y: ua.y + s * (ub.y - ua.y) + t * (uc.y - ua.y) }
    return true
  })
  if (hit) return { point: hit, inside: true }
  // 外框上最近的点
  const s = mesh.segments
  const n = s + 1
  const border: number[] = []
  for (let i = 0; i < s; i++) border.push(i)
  for (let j = 0; j < s; j++) border.push(j * n + s)
  for (let i = s; i > 0; i--) border.push(s * n + i)
  for (let j = s; j > 0; j--) border.push(j * n)
  let best = Infinity
  let point: Point = { x: 0.5, y: 0.5 }
  for (let k = 0; k < border.length; k++) {
    const a = border[k]
    const b = border[(k + 1) % border.length]
    const ex = pos[b * 2] - pos[a * 2]
    const ey = pos[b * 2 + 1] - pos[a * 2 + 1]
    const len2 = ex * ex + ey * ey
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((q.x - pos[a * 2]) * ex + (q.y - pos[a * 2 + 1]) * ey) / len2)) : 0
    const d = Math.hypot(pos[a * 2] + t * ex - q.x, pos[a * 2 + 1] + t * ey - q.y)
    if (d < best) {
      best = d
      const ua = vertexUV(mesh, a)
      const ub = vertexUV(mesh, b)
      point = { x: ua.x + t * (ub.x - ua.x), y: ua.y + t * (ub.y - ua.y) }
    }
  }
  return { point, inside: false }
}

/**
 * 把原立绘上的数据按网格重采样到变形后的包围盒 box（立绘 UV）中 width×height 的栅格：
 * 像素中心落在网格内时，以该处的原立绘 UV 调用 visit（index 为像素序号，首行在上）。
 */
export function rasterizeWarp(mesh: WarpMesh, box: Bounds, width: number, height: number, visit: (index: number, u: number, v: number) => void): void {
  const pos = mesh.positions
  const sx = width / (box.x1 - box.x0)
  const sy = height / (box.y1 - box.y0)
  // 像素 (x, y) 的中心在栅格坐标 (x, y) 处
  const px = (k: number) => (pos[k * 2] - box.x0) * sx - 0.5
  const py = (k: number) => (pos[k * 2 + 1] - box.y0) * sy - 0.5
  forEachTriangle(mesh, (a, b, c) => {
    const ax = px(a)
    const ay = py(a)
    const e1x = px(b) - ax
    const e1y = py(b) - ay
    const e2x = px(c) - ax
    const e2y = py(c) - ay
    const det = e1x * e2y - e1y * e2x
    if (Math.abs(det) < 1e-12) return
    const xs = [ax, ax + e1x, ax + e2x]
    const ys = [ay, ay + e1y, ay + e2y]
    const x0 = Math.max(0, Math.ceil(Math.min(...xs)))
    const x1 = Math.min(width - 1, Math.floor(Math.max(...xs)))
    const y0 = Math.max(0, Math.ceil(Math.min(...ys)))
    const y1 = Math.min(height - 1, Math.floor(Math.max(...ys)))
    if (x0 > x1 || y0 > y1) return
    const ua = vertexUV(mesh, a)
    const ub = vertexUV(mesh, b)
    const uc = vertexUV(mesh, c)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x - ax
        const dy = y - ay
        const s = (dx * e2y - dy * e2x) / det
        const t = (e1x * dy - e1y * dx) / det
        if (s < -1e-9 || t < -1e-9 || s + t > 1 + 1e-9) continue
        visit(y * width + x, ua.x + s * (ub.x - ua.x) + t * (uc.x - ua.x), ua.y + s * (ub.y - ua.y) + t * (uc.y - ua.y))
      }
  })
}

// ── 工程文件 ──

function conformPoints(v: unknown, count: number): Point[] | null {
  if (!Array.isArray(v) || v.length !== count) return null
  const out: Point[] = []
  for (const item of v) {
    const o = record(item)
    if (typeof o.x !== 'number' || typeof o.y !== 'number' || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null
    out.push({ x: num(o.x, 0, WARP_MIN, WARP_MAX), y: num(o.y, 0, WARP_MIN, WARP_MAX) })
  }
  return out
}

/** 文件中的变形：结构不对的部分取默认值，整体不可用时不变形 */
export function conformWarp(v: unknown): CharWarp {
  const o = record(v)
  const grid = oneOf(o.grid, WARP_GRID_SIZES, DEFAULT_WARP_GRID)
  const warp: CharWarp = {
    grid,
    points: conformPoints(o.points, grid * grid) ?? gridPoints(grid),
    corners: conformPoints(o.corners, 4) ?? UNIT_CORNERS.map((p) => ({ ...p })),
  }
  return !isValidWarp(warp) || (isIdentityWarp(warp) && grid === DEFAULT_WARP_GRID) ? IDENTITY_WARP : warp
}
