import { create } from 'zustand'
import type { Point } from '@/algo/geometry'
import { resizeBilinear } from '@/algo/raster'
import type { DepthResult } from '@/depth/protocol'
import { characterUV } from '@/fusion/placement'
import { DepthEditRasterizer, editSize, type DepthBrushMode, type DepthEditBase, type DepthEditRaster, type DepthStroke } from '@/fusion/depthEdit'
import { assetPixels } from '@/lighting/sampling'
import { getDepthResult } from './depth'
import { useApp, type DocState } from './store'

/** 深度画笔的设置（docs/Plan.md §3.7 M8.6b），不参与撤销。画笔是否在用由立绘步骤的工具决定 */
interface DepthBrushState {
  mode: DepthBrushMode
  /** 画笔直径（屏幕像素） */
  size: number
  strength: number
  hardness: number
  setMode: (mode: DepthBrushMode) => void
  setSize: (size: number) => void
  setStrength: (strength: number) => void
  setHardness: (hardness: number) => void
}

export const useDepthBrush = create<DepthBrushState>()((set) => ({
  mode: 'pull',
  size: 60,
  strength: 0.5,
  hardness: 0.3,
  setMode: (mode) => set({ mode }),
  setSize: (size) => set({ size }),
  setStrength: (strength) => set({ strength }),
  setHardness: (hardness) => set({ hardness }),
}))

let base: { id: string; depth: DepthResult; value: DepthEditBase } | null = null
const rasterizer = new DepthEditRasterizer()
let result: { strokes: DepthStroke[]; base: DepthEditBase; raster: DepthEditRaster } | null = null

/** 修正所依据的原深度与不透明度（增量的分辨率）；立绘深度未就绪时为 null */
export function depthEditBase(doc: DocState): DepthEditBase | null {
  const ch = doc.character
  const depth = getDepthResult(ch?.id)
  if (!ch || !depth) return null
  if (base?.id === ch.id && base.depth === depth) return base.value
  const pixels = assetPixels(ch.id)
  if (!pixels) return null
  const size = editSize(ch)
  const alpha = new Float32Array(pixels.width * pixels.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3] / 255
  const { width: gw, height: gh } = depth.guideSize
  const value = {
    ...size,
    depth: resizeBilinear(depth.depth, gw, gh, size.width, size.height),
    alpha: resizeBilinear(alpha, pixels.width, pixels.height, size.width, size.height),
  }
  base = { id: ch.id, depth, value }
  return value
}

/** 当前的深度修正增量；没有修正或立绘深度未就绪时为 null。同样的笔画返回同一个对象 */
export function currentDepthEdit(doc: DocState): DepthEditRaster | null {
  const strokes = doc.charDepthEdit.strokes
  if (!strokes.length) return null
  const b = depthEditBase(doc)
  if (!b) return null
  if (result?.strokes === strokes && result.base === b) return result.raster
  result = { strokes, base: b, raster: rasterizer.rasterize(strokes, b) }
  return result.raster
}

/** 文档中以 p 为中心、半径 r（文档像素）的圆换算成笔画半径（立绘长边的比例），按 p 处的变形取局部比例 */
export function strokeRadius(doc: DocState, p: Point, r: number): number {
  const ch = doc.character
  if (!ch) return 0
  const long = Math.max(ch.width, ch.height)
  const at = characterUV(doc, p)
  const dx = characterUV(doc, { x: p.x + r, y: p.y })
  const dy = characterUV(doc, { x: p.x, y: p.y + r })
  const span = (q: Point) => Math.hypot((q.x - at.point.x) * ch.width, (q.y - at.point.y) * ch.height)
  const local = at.inside && dx.inside && dy.inside ? (span(dx.point) + span(dy.point)) / 2 : r / doc.charTransform.scale
  return Math.min(0.5, Math.max(1e-3, local / long))
}

/** 正在画的一笔：每次加点都写入文档，整笔是一次撤销 */
let painting: { before: DepthStroke[]; stroke: DepthStroke } | null = null

/** 从立绘 UV 处开始一笔；立绘深度未就绪时返回 false */
export function beginDepthStroke(uv: Point, radius: number): boolean {
  const app = useApp.getState()
  if (!depthEditBase(app.doc)) return false
  const { mode, strength, hardness } = useDepthBrush.getState()
  app.beginGesture()
  painting = { before: app.doc.charDepthEdit.strokes, stroke: { mode, radius, strength, hardness, points: [uv.x, uv.y] } }
  app.setDepthStrokes([...painting.before, painting.stroke])
  return true
}

export function extendDepthStroke(uv: Point): void {
  if (!painting) return
  painting.stroke = { ...painting.stroke, points: [...painting.stroke.points, uv.x, uv.y] }
  useApp.getState().setDepthStrokes([...painting.before, painting.stroke])
}

export function endDepthStroke(): void {
  if (!painting) return
  painting = null
  useApp.getState().endGesture()
}
