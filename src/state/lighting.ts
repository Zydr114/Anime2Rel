import { create } from 'zustand'
import type { AnalysisResult } from '@/analysis/protocol'

export type AnalysisStatus = { state: 'running' } | { state: 'done'; result: AnalysisResult } | { state: 'error'; message: string }

/** 画布上的光源工具：选择/拖动、点击添加、吸管取色 */
export type LightTool = 'select' | 'add' | 'pick'

/** 光源分析结果（按背景资源 id）与光源步骤的界面状态。不参与撤销。 */
interface LightingState {
  analyses: Record<string, AnalysisStatus>
  selected: string | null
  tool: LightTool
  /** 在立绘位置显示灰球 */
  showBall: boolean

  setAnalysis: (assetId: string, status: AnalysisStatus) => void
  select: (id: string | null) => void
  setTool: (tool: LightTool) => void
  setShowBall: (on: boolean) => void
}

export const useLighting = create<LightingState>()((set) => ({
  analyses: {},
  selected: null,
  tool: 'select',
  showBall: true,

  setAnalysis: (assetId, status) => set((s) => ({ analyses: { ...s.analyses, [assetId]: status } })),
  select: (selected) => set({ selected }),
  setTool: (tool) => set({ tool }),
  setShowBall: (showBall) => set({ showBall }),
}))

export function getAnalysis(assetId: string | null | undefined): AnalysisResult | undefined {
  if (!assetId) return undefined
  const s = useLighting.getState().analyses[assetId]
  return s?.state === 'done' ? s.result : undefined
}
