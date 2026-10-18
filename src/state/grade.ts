import { create } from 'zustand'
import type { CurveChannel, GradeLevel } from '@/grade/model'

/** 调色步骤的界面状态。不参与撤销。 */
interface GradeUiState {
  /** 正在编辑的调整级别 */
  level: GradeLevel
  /** HSL 中选中的色相段序号 */
  band: number
  /** 曲线编辑器当前的通道 */
  channel: CurveChannel

  setLevel: (level: GradeLevel) => void
  setBand: (band: number) => void
  setChannel: (channel: CurveChannel) => void
}

export const useGradeUi = create<GradeUiState>()((set) => ({
  level: 'global',
  band: 0,
  channel: 'master',
  setLevel: (level) => set({ level }),
  setBand: (band) => set({ band }),
  setChannel: (channel) => set({ channel }),
}))
