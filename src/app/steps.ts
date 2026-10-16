import type { StepId } from '@/state/store'
import { t } from '@/i18n'

export interface StepDef {
  id: StepId
  label: string
  icon: string
  /** 尚未实现的步骤所属里程碑 */
  milestone?: string
}

export const steps: StepDef[] = [
  { id: 'assets', label: t.steps.assets, icon: 'layers--outlined' },
  { id: 'depth', label: t.steps.depth, icon: 'landscape--outlined', milestone: 'M1' },
  { id: 'light', label: t.steps.light, icon: 'light-mode--outlined', milestone: 'M2' },
  { id: 'character', label: t.steps.character, icon: 'face--outlined' },
  { id: 'focus', label: t.steps.focus, icon: 'center-focus-strong--outlined', milestone: 'M4' },
  { id: 'adjust', label: t.steps.adjust, icon: 'tune--outlined', milestone: 'M5' },
  { id: 'effects', label: t.steps.effects, icon: 'auto-awesome--outlined', milestone: 'M5' },
  { id: 'export', label: t.steps.export, icon: 'download--outlined' },
]
