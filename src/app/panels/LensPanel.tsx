import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { DofSection, TargetSection } from './FocusSections'
import { Empty } from './Group'
import { PostSections } from './PostSections'

/** 镜头步骤：景深与对焦，以及后期效果（docs/Plan.md §3.7 M8.7） */
export function LensPanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  if (!hasBackground) return <Empty>{t.focus.noBackground}</Empty>
  return (
    <div className="flex flex-col gap-2">
      <DofSection />
      <TargetSection />
      <PostSections />
      <mdui-button variant="text" onClick={() => useApp.getState().resetLens()} data-testid="lens-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.lens.reset}
      </mdui-button>
    </div>
  )
}
