import { create } from 'zustand'
import type { CurveChannel, GradeLevel, ToneKey, WheelKey } from '@/grade/model'
import type { BrushTool } from './regions'

/** 调色步骤的页面：三级基础调整、局部调整、全局的色彩风格、预设（前三项与计算顺序一致） */
export type GradeTab = 'basic' | 'local' | 'style' | 'presets'
export const GRADE_TABS: readonly GradeTab[] = ['basic', 'local', 'style', 'presets']

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
  /** “局部”页中选中的局部调整，画布控件和蒙版预览针对它 */
  mask: string | null
  /** 预览中用红色叠加显示选中项的蒙版 */
  showMask: boolean
  /** 画笔形状的工具与画笔直径（屏幕像素） */
  maskTool: BrushTool
  maskBrushSize: number

  setTab: (tab: GradeTab) => void
  setLevel: (level: GradeLevel) => void
  setBand: (band: number) => void
  setChannel: (channel: CurveChannel) => void
  setWheel: (wheel: WheelKey) => void
  setTone: (tone: ToneKey) => void
  setMask: (id: string | null) => void
  setShowMask: (show: boolean) => void
  setMaskTool: (tool: BrushTool) => void
  setMaskBrushSize: (size: number) => void
}

export const useGradeUi = create<GradeUiState>()((set) => ({
  tab: 'basic',
  level: 'global',
  band: 0,
  channel: 'master',
  wheel: 'lift',
  tone: 'shadow',
  mask: null,
  showMask: false,
  maskTool: 'brush',
  maskBrushSize: 80,
  setTab: (tab) => set({ tab }),
  setLevel: (level) => set({ level }),
  setBand: (band) => set({ band }),
  setChannel: (channel) => set({ channel }),
  setWheel: (wheel) => set({ wheel }),
  setTone: (tone) => set({ tone }),
  setMask: (mask) => set({ mask }),
  setShowMask: (showMask) => set({ showMask }),
  setMaskTool: (maskTool) => set({ maskTool }),
  setMaskBrushSize: (maskBrushSize) => set({ maskBrushSize }),
}))
