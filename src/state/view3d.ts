import { create } from 'zustand'
import { sceneLayout, type SceneLayout } from '@/scene3d/layout'
import { surfaceModel, type SurfaceModel } from '@/scene3d/pick'
import { viewProjection, type Projection, type View3d } from '@/scene3d/space'
import { getDepthResult } from './depth'
import { currentDepthEdit } from './depthEdit'
import { characterInfo } from './fusion'
import { useApp, type StepId } from './store'

/** 3D 视图的界面状态（docs/Plan.md §3.7 M8.6a），不参与撤销。view 为 null 时打开后按场景定出初始的环绕视角 */
interface View3dState {
  open: boolean
  view: View3d | null
  setOpen: (open: boolean) => void
  setView: (view: View3d) => void
}

export const useView3d = create<View3dState>()((set) => ({
  open: false,
  view: null,
  setOpen: (open) => set({ open }),
  setView: (view) => set({ view }),
}))

/** 可以打开 3D 视图的步骤：摆放（M8.6b）与融合（M8.6a） */
export const isView3dStep = (step: StepId) => step === 'place' || step === 'fusion'

/** 3D 视图是否正在显示；显示时二维的控件隐藏 */
export function useView3dShown(): boolean {
  const open = useView3d((s) => s.open)
  const step = useApp((s) => s.step)
  return open && isView3dStep(step)
}

/** 当前的场景布局与投影；view 缺省时取 3D 视图当前的视角 */
export function currentScene(view?: View3d): { layout: SceneLayout; projection: Projection } | null {
  const { doc, view: view2d, viewport, viewInsets } = useApp.getState()
  const bg = doc.background
  if (!bg) return null
  const layout = sceneLayout(doc, getDepthResult(bg.id), characterInfo(doc)?.bbox)
  const v = view ?? useView3d.getState().view ?? { kind: 'camera' }
  return layout && { layout, projection: viewProjection(v, doc.camera, bg, view2d, viewport, viewInsets) }
}

/** 当前场景的表面（点选用）；scale 取自 currentScene 的布局 */
export function currentSurface(layout: SceneLayout): SurfaceModel | null {
  const { doc } = useApp.getState()
  if (!doc.background) return null
  return surfaceModel(doc, layout.scale, getDepthResult(doc.background.id), getDepthResult(doc.character?.id), characterInfo(doc), currentDepthEdit(doc))
}
