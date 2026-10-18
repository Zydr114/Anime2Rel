import { create } from 'zustand'
import type { CurveChannel, GradeLevel, ToneKey, WheelKey } from '@/grade/model'

/** 调色步骤的两个页面：三级基础调整、全局的色彩风格 */
export type GradeTab = 'basic' | 'style'
export const GRADE_TABS: readonly GradeTab[] = ['basic', 'style']

/** 调色步骤的界面状态。不参与撤销。 */
interface GradeUiState {
  tab: GradeTab
  /** 正在编辑的调整级别 */
  level: GradeLevel
  /** HSL 中选中的色相段序号 */
  band: number
  /** 曲线编辑器当前的通道 */
  channel: CurveChannel
  wheel: WheelKey
  tone: ToneKey

  setTab: (tab: GradeTab) => void
  setLevel: (level: GradeLevel) => void
  setBand: (band: number) => void
  setChannel: (channel: CurveChannel) => void
  setWheel: (wheel: WheelKey) => void
  setTone: (tone: ToneKey) => void
}

export const useGradeUi = create<GradeUiState>()((set) => ({
  tab: 'basic',
  level: 'global',
  band: 0,
  channel: 'master',
  wheel: 'lift',
  tone: 'shadow',
  setTab: (tab) => set({ tab }),
  setLevel: (level) => set({ level }),
  setBand: (band) => set({ band }),
  setChannel: (channel) => set({ channel }),
  setWheel: (wheel) => set({ wheel }),
  setTone: (tone) => set({ tone }),
}))
