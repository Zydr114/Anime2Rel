/** 立绘在背景中的位置：不透明区域的包围盒、接地点与所在深度（docs/Plan.md §3.4）。 */
import { layerToDoc, type Point, type Size } from '@/algo/geometry'
import type { DepthResult } from '@/depth/protocol'
import { sampleDepthMedian } from '@/lighting/sampling'
import type { DocState } from '@/state/store'
import type { CharacterInfo } from './protocol'

const FULL_BOX: CharacterInfo['bbox'] = { x0: 0, y0: 0, x1: 1, y1: 1 }

/** 立绘不透明区域包围盒的四角（文档坐标）。bbox 缺省时用整张图。 */
export function characterBox(doc: DocState, bbox: CharacterInfo['bbox'] = FULL_BOX): Point[] {
  const ch = doc.character
  if (!ch) return []
  const local = (u: number, v: number) => layerToDoc(doc.charTransform, { x: (u - 0.5) * ch.width, y: (v - 0.5) * ch.height })
  return [local(bbox.x0, bbox.y0), local(bbox.x1, bbox.y0), local(bbox.x1, bbox.y1), local(bbox.x0, bbox.y1)]
}

/** 接地点的立绘 UV：用户设置的点，或不透明区域包围盒底边的中点。 */
export function groundUV(doc: DocState, bbox: CharacterInfo['bbox'] = FULL_BOX): { u: number; v: number } {
  return doc.fusion.ground ?? { u: (bbox.x0 + bbox.x1) / 2, v: bbox.y1 }
}

/** 接地点（文档坐标）；没有立绘时为画面中心。 */
export function characterGround(doc: DocState, size: Size, bbox: CharacterInfo['bbox'] = FULL_BOX): Point {
  const ch = doc.character
  if (!ch) return { x: size.width / 2, y: size.height / 2 }
  const { u, v } = groundUV(doc, bbox)
  return layerToDoc(doc.charTransform, { x: (u - 0.5) * ch.width, y: (v - 0.5) * ch.height })
}

/** 立绘所在的归一化逆深度：用户设置的值，或接地点附近背景深度的中位数。 */
export function characterDepth(doc: DocState, depth: DepthResult | undefined, bbox?: CharacterInfo['bbox']): number {
  if (doc.fusion.depth !== null) return doc.fusion.depth
  const bg = doc.background
  if (!bg) return 0.5
  return sampleDepthMedian(depth, characterGround(doc, bg, bbox), bg)
}
