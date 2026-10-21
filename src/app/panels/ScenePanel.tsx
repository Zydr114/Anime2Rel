import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { CameraSections } from './CameraPanel'
import { DepthSections } from './DepthPanel'
import { Empty } from './Group'

/** 场景步骤：相机标定与深度估计（docs/Plan.md §3.7 M8.7） */
export function ScenePanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  if (!hasBackground) return <Empty>{t.camera.noBackground}</Empty>
  return (
    <div className="flex flex-col gap-2">
      <CameraSections />
      <DepthSections />
    </div>
  )
}
