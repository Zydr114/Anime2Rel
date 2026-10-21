import { t } from '@/i18n'
import { openGroup } from '@/state/groups'
import { stepLocked, useApp, type StepId } from '@/state/store'
import { notify } from './notify'

/** 切换步骤；相机标定还没有确认时提示并留在原处。group 给出时展开该分组 */
export function goToStep(step: StepId, group?: string): boolean {
  const s = useApp.getState()
  if (stepLocked(s.doc, step)) {
    notify(t.camera.lockedNotice)
    return false
  }
  s.setStep(step)
  if (group) openGroup(group)
  return true
}
