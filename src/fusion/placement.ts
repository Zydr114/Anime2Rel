/** 立绘在背景中的位置：不透明区域的包围盒、接地点与所在深度（docs/Plan.md §3.4），以及立绘变形前后的坐标换算。 */
import { docToLayerUV, layerToDoc, type Point, type Size } from '@/algo/geometry'
import type { DepthResult } from '@/depth/protocol'
import { sampleDepthMedian } from '@/lighting/sampling'
import type { DocState } from '@/state/store'
import type { CharacterInfo } from './protocol'
import { unwarpPoint, warpPoint } from './warp'

const FULL_BOX: CharacterInfo['bbox'] = { x0: 0, y0: 0, x1: 1, y1: 1 }

/** 立绘 UV（变形后，可以超出 [0,1]）→ 文档坐标 */
export function layerUVToDoc(doc: DocState, uv: Point): Point {
  const ch = doc.character
  if (!ch) return uv
  return layerToDoc(doc.charTransform, { x: (uv.x - 0.5) * ch.width, y: (uv.y - 0.5) * ch.height })
}

/** 原立绘上的一点（立绘 UV）经变形和摆放后在文档中的位置 */
export function characterPoint(doc: DocState, uv: Point): Point {
  return layerUVToDoc(doc, warpPoint(doc.charWarp, uv))
}

/** 文档坐标 → 原立绘 UV（经逆变形）。点在变形后的立绘之外时取外框上最近的点，inside 为 false */
export function characterUV(doc: DocState, p: Point): { point: Point; inside: boolean } {
  const ch = doc.character
  if (!ch) return { point: { x: 0.5, y: 0.5 }, inside: false }
  return unwarpPoint(doc.charWarp, docToLayerUV(doc.charTransform, ch, p))
}

/** 变形后立绘的外框（文档坐标），从左上角开始顺时针，每条边取 perEdge 段 */
export function characterOutline(doc: DocState, perEdge = 16): Point[] {
  const edge = (from: Point, to: Point) => Array.from({ length: perEdge }, (_, k) => ({ x: from.x + ((to.x - from.x) * k) / perEdge, y: from.y + ((to.y - from.y) * k) / perEdge }))
  const corners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  return corners.flatMap((c, i) => edge(c, corners[(i + 1) % 4])).map((uv) => characterPoint(doc, uv))
}

/** 立绘不透明区域包围盒的四角（文档坐标）。bbox 缺省时用整张图。 */
export function characterBox(doc: DocState, bbox: CharacterInfo['bbox'] = FULL_BOX): Point[] {
  if (!doc.character) return []
  return [
    { x: bbox.x0, y: bbox.y0 },
    { x: bbox.x1, y: bbox.y0 },
    { x: bbox.x1, y: bbox.y1 },
    { x: bbox.x0, y: bbox.y1 },
  ].map((uv) => layerUVToDoc(doc, uv))
}

/** 立绘不透明区域的高度（文档像素）。bbox 缺省时用整张图。 */
export function characterHeight(doc: DocState, bbox: CharacterInfo['bbox'] = FULL_BOX): number {
  return (bbox.y1 - bbox.y0) * (doc.character?.height ?? 0) * doc.charTransform.scale
}

/** 接地点（变形后的立绘 UV）：用户设置的点经变形后的位置，或不透明区域包围盒底边的中点。 */
export function groundUV(doc: DocState, bbox: CharacterInfo['bbox'] = FULL_BOX): { u: number; v: number } {
  const g = doc.fusion.ground
  if (!g) return { u: (bbox.x0 + bbox.x1) / 2, v: bbox.y1 }
  const p = warpPoint(doc.charWarp, { x: g.u, y: g.v })
  return { u: p.x, v: p.y }
}

/** 接地点（文档坐标）；没有立绘时为画面中心。 */
export function characterGround(doc: DocState, size: Size, bbox: CharacterInfo['bbox'] = FULL_BOX): Point {
  if (!doc.character) return { x: size.width / 2, y: size.height / 2 }
  const { u, v } = groundUV(doc, bbox)
  return layerUVToDoc(doc, { x: u, y: v })
}

/** 立绘所在的归一化逆深度：用户设置的值，或接地点附近背景深度的中位数。 */
export function characterDepth(doc: DocState, depth: DepthResult | undefined, bbox?: CharacterInfo['bbox']): number {
  if (doc.fusion.depth !== null) return doc.fusion.depth
  const bg = doc.background
  if (!bg) return 0.5
  return sampleDepthMedian(depth, characterGround(doc, bg, bbox), bg)
}
