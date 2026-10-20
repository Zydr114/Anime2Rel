import { create } from 'zustand'
import { sceneLayout, type SceneLayout } from '@/scene3d/layout'
import { viewProjection, type Projection, type View3d } from '@/scene3d/space'
import { getDepthResult } from './depth'
import { characterInfo } from './fusion'
import { useApp } from './store'

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

/** 当前的场景布局与投影；view 缺省时取 3D 视图当前的视角 */
export function currentScene(view?: View3d): { layout: SceneLayout; projection: Projection } | null {
  const { doc, view: view2d, viewport, viewInsets } = useApp.getState()
  const bg = doc.background
  if (!bg) return null
  const layout = sceneLayout(doc, getDepthResult(bg.id), characterInfo(doc)?.bbox)
  const v = view ?? useView3d.getState().view ?? { kind: 'camera' }
  return layout && { layout, projection: viewProjection(v, doc.camera, bg, view2d, viewport, viewInsets) }
}
