/**
 * 投影的阴影贴图（docs/Plan.md M8.8d）：从主光源的视角记录立绘占据的体积，GPU 实现见 src/engine/shadowMap.ts。
 *
 * 立绘的占据：画面上 alpha > 0.5、沿视线的距离在 [正面, 正面 + 身体厚度] 内的点。正面是立绘起伏换算到米的结果，
 * 与 3D 视图一致：z正面 = z平面 − (r − r基准) × 立绘厚度 × H。
 * 方向光用沿光线方向的正交投影，灯用从灯的位置出发的透视投影；贴图只覆盖占据体积的包围盒，与影子的长短无关。
 * 光源空间坐标 (a, b, s)：a、b 为贴图平面上的位置（方向光为米，灯为相对 forward 的正切），s 为沿光线到光源一侧的距离（米）。
 */
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'

export interface ShadowMapParams {
  point: boolean
  /** 方向光：光线的传播方向（背离光源）；灯：灯的相机空间位置 */
  light: Vec3
  /** 贴图平面的两个轴与光源的朝向（方向光为传播方向，灯为指向占据体积中心的方向），两两正交 */
  e1: Vec3
  e2: Vec3
  forward: Vec3
  /** 贴图覆盖的 a、b 范围：a0、b0、a 的跨度、b 的跨度 */
  rect: [number, number, number, number]
  /** s 的起点与跨度：贴图中存放 (s − 起点) / 跨度 */
  range: [number, number]
  /** 步进只在占据体积的包围盒内进行（相机空间） */
  boxMin: Vec3
  boxMax: Vec3
}

/** 贴图四周多留的比例：半影的模糊不会在边界处截断 */
const PAD = 0.05
/** 灯偏离 forward 超过这个夹角的余弦时视为灯在立绘旁边或之中，不投影 */
const MAX_OFF_AXIS = 0.25

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * 占据体积的 8 个角（相机空间）：画面上的矩形范围在最近、最远距离处的位置。
 * @param rect 文档像素中的范围 x0、y0、x1、y1
 */
export function occupancyCorners(rect: [number, number, number, number], size: Size, focal: number, near: number, far: number): Vec3[] {
  const [x0, y0, x1, y1] = rect
  const out: Vec3[] = []
  for (const z of [near, far])
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
      out.push([((x - size.width / 2) * z) / focal, ((size.height / 2 - y) * z) / focal, -z])
  return out
}

/** 一组文档像素的外接矩形，四周各放大 margin 倍的尺寸 */
export function boundingRect(points: readonly Point[], margin: number): [number, number, number, number] {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const mx = (x1 - x0) * margin
  const my = (y1 - y0) * margin
  return [x0 - mx, y0 - my, x1 + mx, y1 + my]
}

/** 与 forward 正交的两个单位向量 */
function basis(forward: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const e1 = unit(cross(helper, forward))
  return [e1, cross(forward, e1)]
}

type Frame = Pick<ShadowMapParams, 'point' | 'light' | 'e1' | 'e2' | 'forward'>

/** 相机空间的点 → 光源空间 (a, b, s) */
function toLight(f: Frame, x: Vec3): Vec3 {
  if (!f.point) return [dot(x, f.e1), dot(x, f.e2), dot(x, f.forward)]
  const y = sub(x, f.light)
  const depth = Math.max(dot(y, f.forward), 1e-6)
  return [dot(y, f.e1) / depth, dot(y, f.e2) / depth, Math.hypot(...y)]
}

/**
 * 主光源的阴影贴图参数。
 * @param light 方向光为指向光源的单位向量，灯为灯的相机空间位置
 * @param corners 占据体积的角（occupancyCorners）
 * @returns 灯位于占据体积旁边或之中时为 null
 */
export function shadowMapParams(light: { point: boolean; vector: Vec3 }, corners: readonly Vec3[]): ShadowMapParams | null {
  let frame: Frame
  if (light.point) {
    const center = corners.reduce<Vec3>((acc, c) => [acc[0] + c[0] / corners.length, acc[1] + c[1] / corners.length, acc[2] + c[2] / corners.length], [0, 0, 0])
    const forward = unit(sub(center, light.vector))
    if (corners.some((c) => dot(sub(c, light.vector), forward) < MAX_OFF_AXIS * Math.hypot(...sub(c, light.vector)))) return null
    const [e1, e2] = basis(forward)
    frame = { point: true, light: light.vector, e1, e2, forward }
  } else {
    const forward = unit([-light.vector[0], -light.vector[1], -light.vector[2]])
    const [e1, e2] = basis(forward)
    frame = { point: false, light: forward, e1, e2, forward }
  }
  const coords = corners.map((c) => toLight(frame, c))
  const span = (k: number): [number, number] => {
    const values = coords.map((c) => c[k])
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const pad = Math.max((hi - lo) * PAD, 1e-4)
    return [lo - pad, hi - lo + 2 * pad]
  }
  const [a0, aSpan] = span(0)
  const [b0, bSpan] = span(1)
  // 正交投影下贴图是正方形的纹素才不会拉伸：短的一边放大到与长的一边相同
  const side = Math.max(aSpan, bSpan)
  const boxMin = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))) as Vec3
  const boxMax = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) as Vec3
  return { ...frame, rect: [a0 - (side - aSpan) / 2, b0 - (side - bSpan) / 2, side, side], range: span(2), boxMin, boxMax }
}

/** 相机空间的点 → 贴图坐标 (u, v) 与归一化的 s；与着色器中的 lightUV 一致 */
export function lightUV(p: ShadowMapParams, x: Vec3): Vec3 {
  const [a, b, s] = toLight(p, x)
  return [(a - p.rect[0]) / p.rect[2], (b - p.rect[1]) / p.rect[3], (s - p.range[0]) / p.range[1]]
}

/** 贴图坐标处的光线：起点与单位方向，沿光线的参数 t 就是 s（方向光的起点在 s = 0 的平面上）；与着色器一致 */
export function texelRay(p: ShadowMapParams, u: number, v: number): { origin: Vec3; dir: Vec3 } {
  const a = p.rect[0] + u * p.rect[2]
  const b = p.rect[1] + v * p.rect[3]
  const lateral: Vec3 = [p.e1[0] * a + p.e2[0] * b, p.e1[1] * a + p.e2[1] * b, p.e1[2] * a + p.e2[2] * b]
  if (!p.point) return { origin: lateral, dir: p.forward }
  return { origin: p.light, dir: unit([p.forward[0] + lateral[0], p.forward[1] + lateral[1], p.forward[2] + lateral[2]]) }
}

/** 光线与包围盒的交段 [t0, t1]；不相交时 t0 > t1 */
export function boxSegment(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): [number, number] {
  let t0 = -Infinity
  let t1 = Infinity
  for (let k = 0; k < 3; k++) {
    const inv = 1 / (Math.abs(dir[k]) > 1e-9 ? dir[k] : 1e-9)
    const a = (min[k] - origin[k]) * inv
    const b = (max[k] - origin[k]) * inv
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  return [t0, t1]
}

/**
 * 半影：遮挡点与受影点沿光线的距离换算为贴图上的模糊半径（贴图坐标的比例）。
 * k 为单位距离的模糊量（与平面方式的柔和度换算相同）；灯的贴图坐标是正切，按受影点到灯的距离换算。
 */
export function penumbraRadius(p: ShadowMapParams, receiver: number, blocker: number, k: number): number {
  const gap = Math.max(receiver - blocker, 0) * k
  return (p.point ? gap / Math.max(receiver, 1e-6) : gap) / p.rect[2]
}
