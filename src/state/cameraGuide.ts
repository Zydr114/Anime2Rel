import { create } from 'zustand'
import type { Point } from '@/algo/geometry'
import { groundPoint } from '@/camera/geometry'
import { BOX_RANGE, defaultOrigin, defaultRod, ROD_HEIGHT, type GuideKind } from '@/camera/guides'
import type { DocState } from './store'

/** 相机标定的参考形状（M8.5 补充）。界面状态，不进工程和撤销记录。 */
interface CameraGuideState {
  kind: GuideKind
  /** 原点（文档坐标）；只对拖动时的背景有效，更换背景后回到默认位置 */
  origin: { backgroundId: string; point: Point } | null
  /** 立方体的边长（米） */
  boxSize: number
  /** 相机步骤中暗化照片，让线和参考形状更醒目 */
  dim: boolean
  /** 测量杆的底端和顶端（文档坐标）；与原点一样只对拖动时的背景有效 */
  rod: { backgroundId: string; foot: Point; top: Point } | null
  /** 测量杆所对准的物体的实际高度（米） */
  rodReal: number

  setKind: (kind: GuideKind) => void
  setOrigin: (backgroundId: string, point: Point) => void
  resetOrigin: () => void
  setBoxSize: (size: number) => void
  setDim: (dim: boolean) => void
  setRod: (backgroundId: string, foot: Point, top: Point) => void
  setRodReal: (meters: number) => void
}

export const useCameraGuide = create<CameraGuideState>()((set) => ({
  kind: 'ground',
  origin: null,
  boxSize: 1,
  dim: true,
  rod: null,
  rodReal: ROD_HEIGHT,

  setKind: (kind) => set({ kind }),
  setOrigin: (backgroundId, point) => set({ origin: { backgroundId, point } }),
  resetOrigin: () => set({ origin: null }),
  setBoxSize: (size) => set({ boxSize: Math.min(BOX_RANGE[1], Math.max(BOX_RANGE[0], size)) }),
  setDim: (dim) => set({ dim }),
  setRod: (backgroundId, foot, top) => set({ rod: { backgroundId, foot, top } }),
  setRodReal: (rodReal) => set({ rodReal }),
}))

/** 当前背景上参考形状的原点：拖动过的位置仍在地面上时用它，否则用默认位置 */
export function guideOrigin(doc: DocState, origin: CameraGuideState['origin']): Point | null {
  const bg = doc.background
  if (!bg) return null
  if (origin?.backgroundId === bg.id && groundPoint(doc.camera, bg, origin.point)) return origin.point
  return defaultOrigin(doc.camera, bg)
}

/** 当前背景上的测量杆：拖动过的位置仍在地面上时用它，否则用默认位置 */
export function guideRod(doc: DocState, rod: CameraGuideState['rod']): { foot: Point; top: Point } | null {
  const bg = doc.background
  if (!bg) return null
  if (rod?.backgroundId === bg.id && groundPoint(doc.camera, bg, rod.foot)) return rod
  return defaultRod(doc.camera, bg)
}
