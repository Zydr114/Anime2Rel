import type { StepId } from '@/state/store'
import { t } from '@/i18n'

export interface StepDef {
  id: StepId
  label: string
  icon: string
}

export const steps: StepDef[] = [
  { id: 'assets', label: t.steps.assets, icon: 'layers--outlined' },
  { id: 'camera', label: t.steps.camera, icon: 'photo-camera--outlined' },
  { id: 'depth', label: t.steps.depth, icon: 'landscape--outlined' },
  { id: 'light', label: t.steps.light, icon: 'light-mode--outlined' },
  { id: 'character', label: t.steps.character, icon: 'face--outlined' },
  { id: 'focus', label: t.steps.focus, icon: 'center-focus-strong--outlined' },
  { id: 'adjust', label: t.steps.adjust, icon: 'tune--outlined' },
  { id: 'effects', label: t.steps.effects, icon: 'auto-awesome--outlined' },
  { id: 'export', label: t.steps.export, icon: 'download--outlined' },
]

/** 调色、后期步骤：前后对比显示调色前的结果，没有立绘时也可以对比 */
export const isGradeStep = (step: StepId) => step === 'adjust' || step === 'effects'
