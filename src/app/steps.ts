import type { StepId } from '@/state/store'
import { t } from '@/i18n'

export interface StepDef {
  id: StepId
  label: string
  icon: string
}

export const steps: StepDef[] = [
  { id: 'assets', label: t.steps.assets, icon: 'layers--outlined' },
  { id: 'scene', label: t.steps.scene, icon: 'photo-camera--outlined' },
  { id: 'place', label: t.steps.place, icon: 'face--outlined' },
  { id: 'fusion', label: t.steps.fusion, icon: 'light-mode--outlined' },
  { id: 'adjust', label: t.steps.adjust, icon: 'tune--outlined' },
  { id: 'lens', label: t.steps.lens, icon: 'center-focus-strong--outlined' },
  { id: 'export', label: t.steps.export, icon: 'download--outlined' },
]

/** 调色、镜头步骤：前后对比显示调色前的结果，没有立绘时也可以对比 */
export const isGradeStep = (step: StepId) => step === 'adjust' || step === 'lens'
