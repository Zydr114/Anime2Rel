/** 立绘与标定的相机（docs/Plan.md §3.7 M8.5）：身高读数和“按相机透视”。 */
import { docToLayerUV, type Point } from '@/algo/geometry'
import { characterGround, characterHeight, layerUVToDoc } from '@/fusion/placement'
import type { CharacterInfo } from '@/fusion/protocol'
import { hasPerspective, homography, invertHomography, project, UNIT_CORNERS } from '@/fusion/warp'
import type { DocState } from '@/state/store'
import { standingHeight, standingPerspective } from './geometry'

/** 人物在场景中的身高（米，按相机高度换算）；没有立绘或接地点不在地面上时为 null */
export function characterMeters(doc: DocState, bbox?: CharacterInfo['bbox']): number | null {
  const bg = doc.background
  if (!bg || !doc.character) return null
  return standingHeight(doc.camera, bg, characterGround(doc, bg, bbox), characterHeight(doc, bbox))
}

/**
 * “按相机透视”的四角（M8.3 四角透视，变形后的立绘 UV）：把立绘当作立在接地点上的竖直平面，按标定的相机重新投影，
 * 人物在画面中的高度不变。以去掉已有透视的立绘为准，重复使用结果不变。接地点不在地面上时为 null。
 */
export function cameraCorners(doc: DocState, bbox?: CharacterInfo['bbox']): Point[] | null {
  const bg = doc.background
  const ch = doc.character
  if (!bg || !ch) return null
  const toLayer = (p: Point) => docToLayerUV(doc.charTransform, ch, p)
  let foot = characterGround(doc, bg, bbox)
  // 已有透视时，接地点按透视的逆变换回到没有透视时的位置
  const w = doc.charWarp
  const perspective = hasPerspective(w) ? homography(UNIT_CORNERS, w.corners) : null
  const inverse = perspective && invertHomography(perspective)
  if (inverse) foot = layerUVToDoc(doc, project(inverse, toLayer(foot)))
  const h = standingPerspective(doc.camera, bg, foot, characterHeight(doc, bbox))
  return h && UNIT_CORNERS.map((c) => toLayer(project(h, layerUVToDoc(doc, c))))
}
