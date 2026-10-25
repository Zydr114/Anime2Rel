import type { DebugView } from '@/state/depth'
import type { StepId } from '@/state/store'
import { t } from '@/i18n'

export interface StepDef {
  id: StepId
  label: string
  icon: string
}

/** 导航中的顺序（docs/Plan.md §3.7 M8.9）：调色在镜头之后，是最后一个编辑步骤；渲染顺序与此无关 */
export const steps: StepDef[] = [
  { id: 'assets', label: t.steps.assets, icon: 'layers--outlined' },
  { id: 'scene', label: t.steps.scene, icon: 'photo-camera--outlined' },
  { id: 'place', label: t.steps.place, icon: 'face--outlined' },
  { id: 'fusion', label: t.steps.fusion, icon: 'light-mode--outlined' },
  { id: 'lens', label: t.steps.lens, icon: 'center-focus-strong--outlined' },
  { id: 'adjust', label: t.steps.adjust, icon: 'tune--outlined' },
  { id: 'export', label: t.steps.export, icon: 'download--outlined' },
]

/** 镜头、调色步骤：前后对比显示调色前的结果，没有立绘时也可以对比 */
export const isGradeStep = (step: StepId) => step === 'adjust' || step === 'lens'

/**
 * 画布是否显示镜头失真：只在镜头、导出步骤中，且没有前后对比和调试视图（调试视图叠加的是未失真的深度等信息）。
 * 其他步骤的画布控件需要与未失真的画面对位（docs/Plan.md §3.7 M8.8a）
 */
export const showsDistortion = (step: StepId, compare: boolean, view: DebugView) => (step === 'lens' || step === 'export') && !compare && view === 'composite'
