/**
 * 立绘深度修正（docs/Plan.md §3.7 M8.6b）：画笔笔画按顺序栅格化成一层低分辨率的增量，加到立绘自身的归一化逆深度上。
 * 笔画的点用变形前的立绘 UV，半径按立绘长边的比例；增量的长边为 EDIT_LONG 像素，与立绘同宽高比。
 * 推、拉、恢复只看增量本身；平滑看修正后的深度（原深度 + 增量），只在不透明区域内取平均。
 */
import type { Size } from '@/algo/geometry'

export type DepthBrushMode = 'push' | 'pull' | 'smooth' | 'restore'
export const DEPTH_BRUSH_MODES: readonly DepthBrushMode[] = ['push', 'pull', 'smooth', 'restore']

export interface DepthStroke {
  mode: DepthBrushMode
  /** 半径（立绘长边的比例） */
  radius: number
  /** 强度 [0,1] */
  strength: number
  /** 硬度 [0,1]：从中心到这个比例的半径保持全强度，之外平滑地减到 0 */
  hardness: number
  /** [u0, v0, u1, v1, …]（变形前的立绘 UV） */
  points: number[]
}

export interface DepthEditDoc {
  strokes: DepthStroke[]
}

export const EMPTY_DEPTH_EDIT: DepthEditDoc = { strokes: [] }

/** 增量的长边（像素） */
export const EDIT_LONG = 256
/** 笔画上落点的间距（半径的比例） */
const SPACING = 0.25
/** 推、拉：一笔从中心划过时增量改变强度 × PASS */
const PASS = 0.2
/** 平滑、恢复：一笔从中心划过时按 exp(−强度 × RATE) 保留 */
const RATE = 3
/** 平滑取平均的窗口半径（画笔半径的比例） */
const SMOOTH_WINDOW = 1 / 3
/** 增量的范围 */
const LIMIT = 1
/** 平滑时算作不透明的 alpha */
const OPAQUE = 0.5

export interface DepthEditRaster extends Size {
  delta: Float32Array
}

/** 修正所依据的原深度与不透明度（增量的分辨率） */
export interface DepthEditBase extends Size {
  depth: Float32Array
  alpha: Float32Array
}

export function editSize(character: Size): Size {
  const k = EDIT_LONG / Math.max(character.width, character.height)
  return { width: Math.max(1, Math.round(character.width * k)), height: Math.max(1, Math.round(character.height * k)) }
}

/** 笔画在栅格上的进度：已处理到第几个点，以及距下一个落点还差的长度（像素） */
interface Progress {
  next: number
  carry: number
}

function falloff(t: number, hardness: number): number {
  if (t >= 1) return 0
  if (t <= hardness) return 1
  const s = (t - hardness) / (1 - hardness)
  return 1 - s * s * (3 - 2 * s)
}

const clampDelta = (v: number) => Math.max(-LIMIT, Math.min(LIMIT, v))

/** 在 (cx, cy)（像素）处落一笔 */
function dab(delta: Float32Array, base: DepthEditBase, stroke: DepthStroke, r: number, cx: number, cy: number): void {
  const { width: w, height: h } = base
  // 一笔从中心划过时，覆盖中心的各落点的衰减之和约为 (1 + 硬度) / 间距比例，权重相加正好是强度
  const unit = (stroke.strength * SPACING) / (1 + stroke.hardness)
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  if (x0 > x1 || y0 > y1) return
  const weight = (x: number, y: number) => unit * falloff(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r, stroke.hardness)

  if (stroke.mode === 'push' || stroke.mode === 'pull') {
    const sign = stroke.mode === 'pull' ? PASS : -PASS
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = weight(x, y)
        if (k > 0) delta[y * w + x] = clampDelta(delta[y * w + x] + sign * k)
      }
    return
  }
  if (stroke.mode === 'restore') {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = weight(x, y)
        if (k > 0) delta[y * w + x] *= Math.exp(-RATE * k)
      }
    return
  }

  // 平滑：窗口内不透明像素的修正后深度的平均，用积分图求
  const kr = Math.max(1, Math.round(r * SMOOTH_WINDOW))
  const ax0 = Math.max(0, x0 - kr)
  const ax1 = Math.min(w - 1, x1 + kr)
  const ay0 = Math.max(0, y0 - kr)
  const ay1 = Math.min(h - 1, y1 + kr)
  const sw = ax1 - ax0 + 2
  const sh = ay1 - ay0 + 2
  const sum = new Float64Array(sw * sh)
  const count = new Float64Array(sw * sh)
  for (let y = ay0; y <= ay1; y++) {
    const row = (y - ay0 + 1) * sw
    const prev = (y - ay0) * sw
    let rs = 0
    let rc = 0
    for (let x = ax0; x <= ax1; x++) {
      const i = y * w + x
      if (base.alpha[i] >= OPAQUE) {
        rs += base.depth[i] + delta[i]
        rc += 1
      }
      const j = x - ax0 + 1
      sum[row + j] = sum[prev + j] + rs
      count[row + j] = count[prev + j] + rc
    }
  }
  const box = (a: Float64Array, xa: number, ya: number, xb: number, yb: number) => a[(yb + 1) * sw + xb + 1] - a[ya * sw + xb + 1] - a[(yb + 1) * sw + xa] + a[ya * sw + xa]
  const changes: number[] = []
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x
      const k = weight(x, y)
      if (k <= 0 || base.alpha[i] < OPAQUE) continue
      const xa = Math.max(ax0, x - kr) - ax0
      const xb = Math.min(ax1, x + kr) - ax0
      const ya = Math.max(ay0, y - kr) - ay0
      const yb = Math.min(ay1, y + kr) - ay0
      const n = box(count, xa, ya, xb, yb)
      if (n <= 0) continue
      const mean = box(sum, xa, ya, xb, yb) / n
      changes.push(i, (1 - Math.exp(-RATE * k)) * (mean - (base.depth[i] + delta[i])))
    }
  // 先求出全部平均再写回，同一个落点内的结果与遍历顺序无关
  for (let c = 0; c < changes.length; c += 2) delta[changes[c]] = clampDelta(delta[changes[c]] + changes[c + 1])
}

/** 沿笔画从 progress 处继续落点，返回新的进度 */
function walk(delta: Float32Array, base: DepthEditBase, stroke: DepthStroke, progress: Progress | null): Progress {
  const { width: w, height: h } = base
  const r = Math.max(0.5, stroke.radius * Math.max(w, h))
  const spacing = Math.max(0.25, r * SPACING)
  const pts = stroke.points
  const px = (i: number) => pts[i * 2] * w
  const py = (i: number) => pts[i * 2 + 1] * h
  const n = pts.length / 2
  if (n === 0) return { next: 0, carry: 0 }
  let { next, carry } = progress ?? { next: 1, carry: 0 }
  if (!progress) dab(delta, base, stroke, r, px(0), py(0))
  for (; next < n; next++) {
    const ax = px(next - 1)
    const ay = py(next - 1)
    const len = Math.hypot(px(next) - ax, py(next) - ay)
    // carry 是从上一个落点走过的长度
    let s = spacing - carry
    while (s <= len) {
      const t = len > 0 ? s / len : 0
      dab(delta, base, stroke, r, ax + (px(next) - ax) * t, ay + (py(next) - ay) * t)
      s += spacing
    }
    carry = len - (s - spacing)
  }
  return { next, carry }
}

const sameStroke = (a: DepthStroke, b: DepthStroke) => a.mode === b.mode && a.radius === b.radius && a.strength === b.strength && a.hardness === b.hardness

/**
 * 按顺序栅格化全部笔画。正在画的最后一笔只是在末尾加点时，从上次的进度继续，不重画整笔：
 * 缓存“除最后一笔外”的结果和最后一笔画到哪里。
 */
export class DepthEditRasterizer {
  private base: DepthEditBase | null = null
  /** 已画完的笔画及其结果 */
  private done: DepthStroke[] = []
  private before: Float32Array = new Float32Array(0)
  /** 最后一笔：笔画、进度，以及 before 加上这一笔的结果 */
  private last: { stroke: DepthStroke; progress: Progress; delta: Float32Array } | null = null

  rasterize(strokes: readonly DepthStroke[], base: DepthEditBase): DepthEditRaster {
    const { width, height } = base
    const head = strokes.slice(0, -1)
    const tail = strokes.at(-1)
    // 已画完的笔画必须是现在的前缀（撤销、换立绘深度后从头画）
    if (base !== this.base || head.length < this.done.length || this.done.some((s, i) => s !== head[i])) {
      this.base = base
      this.done = []
      this.before = new Float32Array(width * height)
      this.last = null
    }
    for (let i = this.done.length; i < head.length; i++) {
      const l = this.last
      if (l && this.extends(head[i])) {
        // 上次正在画的一笔画完了
        walk(l.delta, base, head[i], l.progress)
        this.before = l.delta
      } else walk(this.before, base, head[i], null)
      this.last = null
      this.done.push(head[i])
    }
    if (!tail) {
      this.last = null
      return { width, height, delta: this.before.slice() }
    }
    if (this.last && this.extends(tail)) {
      this.last.progress = walk(this.last.delta, base, tail, this.last.progress)
      this.last.stroke = tail
    } else {
      const delta = this.before.slice()
      this.last = { stroke: tail, progress: walk(delta, base, tail, null), delta }
    }
    return { width, height, delta: this.last.delta.slice() }
  }

  /** 笔画是上次最后一笔加点后的结果：参数相同、原有的点不变 */
  private extends(stroke: DepthStroke): boolean {
    const l = this.last
    if (!l) return false
    if (stroke === l.stroke) return true
    const n = l.stroke.points.length
    if (!sameStroke(stroke, l.stroke) || stroke.points.length < n) return false
    for (let i = 0; i < n; i++) if (stroke.points[i] !== l.stroke.points[i]) return false
    return true
  }
}

/** 增量在立绘 UV (u, v) 处的值（双线性） */
export function sampleEdit(raster: DepthEditRaster, u: number, v: number): number {
  const { width: w, height: h, delta } = raster
  const fx = Math.min(Math.max(u * w - 0.5, 0), w - 1)
  const fy = Math.min(Math.max(v * h - 0.5, 0), h - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const tx = fx - x0
  const ty = fy - y0
  const top = delta[y0 * w + x0] + (delta[y0 * w + x1] - delta[y0 * w + x0]) * tx
  const bottom = delta[y1 * w + x0] + (delta[y1 * w + x1] - delta[y1 * w + x0]) * tx
  return top + (bottom - top) * ty
}
