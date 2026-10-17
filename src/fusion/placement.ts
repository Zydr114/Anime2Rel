/** 立绘在背景中的位置：不透明区域的包围盒、脚下的地面点与所在深度（docs/Plan.md §3.4）。 */
import { layerToDoc, type Point, type Size } from '@/algo/geometry'
import type { DepthResult } from '@/depth/protocol'
import { sampleDepth } from '@/lighting/sampling'
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

/** 立绘脚下的地面点：不透明区域包围盒底边中点；没有立绘时为画面中心。 */
export function characterGround(doc: DocState, size: Size, bbox: CharacterInfo['bbox'] = FULL_BOX): Point {
  const ch = doc.character
  if (!ch) return { x: size.width / 2, y: size.height / 2 }
  return layerToDoc(doc.charTransform, { x: ((bbox.x0 + bbox.x1) / 2 - 0.5) * ch.width, y: (bbox.y1 - 0.5) * ch.height })
}

/** 立绘所在的归一化逆深度：用户设置的值，或地面点处的背景深度。 */
export function characterDepth(doc: DocState, depth: DepthResult | undefined, bbox?: CharacterInfo['bbox']): number {
  if (doc.fusion.depth !== null) return doc.fusion.depth
  const bg = doc.background
  if (!bg) return 0.5
  return sampleDepth(depth, characterGround(doc, bg, bbox), bg).depth
}
