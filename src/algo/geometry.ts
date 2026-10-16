// 文档空间以背景原图像素为单位，原点在左上角，y 轴向下。

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 立绘在文档空间中的变换。x/y 为立绘中心，scale 为相对立绘原图的倍率，rotation 为弧度（顺时针为正）。 */
export interface LayerTransform {
  x: number
  y: number
  scale: number
  rotation: number
  flipX: boolean
}

/** 视口变换：screen = pan + zoom * doc，单位为 CSS 像素。 */
export interface ViewTransform {
  zoom: number
  panX: number
  panY: number
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 32

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function docToScreen(view: ViewTransform, p: Point): Point {
  return { x: view.panX + p.x * view.zoom, y: view.panY + p.y * view.zoom }
}

export function screenToDoc(view: ViewTransform, p: Point): Point {
  return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom }
}

/** 视口中被浮动面板遮挡的边距（CSS 像素）。 */
export interface Insets {
  left: number
  right: number
  top: number
  bottom: number
}

export const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 }

/** 让文档完整居中显示在视口的可见区域内（扣除 insets），四周再留出 padding（相对可见区域短边的比例）。 */
export function fitView(doc: Size, viewport: Size, padding = 0.06, insets: Insets = NO_INSETS): ViewTransform {
  const visW = Math.max(1, viewport.width - insets.left - insets.right)
  const visH = Math.max(1, viewport.height - insets.top - insets.bottom)
  const pad = Math.min(visW, visH) * padding
  const availW = Math.max(1, visW - pad * 2)
  const availH = Math.max(1, visH - pad * 2)
  const zoom = clamp(Math.min(availW / doc.width, availH / doc.height), MIN_ZOOM, MAX_ZOOM)
  return {
    zoom,
    panX: insets.left + (visW - doc.width * zoom) / 2,
    panY: insets.top + (visH - doc.height * zoom) / 2,
  }
}

/** 以屏幕上的 anchor 点为中心缩放，anchor 下的文档点保持不动。 */
export function zoomAt(view: ViewTransform, factor: number, anchor: Point): ViewTransform {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const docAnchor = screenToDoc(view, anchor)
  return { zoom, panX: anchor.x - docAnchor.x * zoom, panY: anchor.y - docAnchor.y * zoom }
}

/** 立绘局部坐标（以立绘中心为原点、原图像素为单位）→ 文档坐标。 */
export function layerToDoc(t: LayerTransform, local: Point): Point {
  const lx = (t.flipX ? -local.x : local.x) * t.scale
  const ly = local.y * t.scale
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  return { x: t.x + c * lx - s * ly, y: t.y + s * lx + c * ly }
}

/** 文档坐标 → 立绘 UV（[0,1] 内为立绘区域，左上角为原点）。与合成着色器中的公式一致。 */
export function docToLayerUV(t: LayerTransform, size: Size, p: Point): Point {
  const dx = p.x - t.x
  const dy = p.y - t.y
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  let lx = (c * dx + s * dy) / t.scale
  const ly = (-s * dx + c * dy) / t.scale
  if (t.flipX) lx = -lx
  return { x: lx / size.width + 0.5, y: ly / size.height + 0.5 }
}

/** 立绘四角在文档空间的位置，顺序为左上、右上、右下、左下（以立绘自身朝向为准）。 */
export function layerCorners(t: LayerTransform, size: Size): Point[] {
  const hw = size.width / 2
  const hh = size.height / 2
  return [
    layerToDoc(t, { x: -hw, y: -hh }),
    layerToDoc(t, { x: hw, y: -hh }),
    layerToDoc(t, { x: hw, y: hh }),
    layerToDoc(t, { x: -hw, y: hh }),
  ]
}

/** 立绘的默认摆放：高度占背景的 80%，水平居中，底边距背景底部 2%。 */
export function defaultLayerTransform(doc: Size, layer: Size): LayerTransform {
  const scale = Math.min((doc.height * 0.8) / layer.height, (doc.width * 0.9) / layer.width)
  const h = layer.height * scale
  return { x: doc.width / 2, y: doc.height * 0.98 - h / 2, scale, rotation: 0, flipX: false }
}

/** 预览分辨率：长边不超过 maxEdge，保持比例。 */
export function fitWithin(size: Size, maxEdge: number): Size {
  const k = Math.min(1, maxEdge / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) }
}
