import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { FusionSections } from './FusionSections'
import { Empty } from './Group'
import { LightSections } from './LightPanel'

/** 融合步骤：光源，以及立绘的重光照、阴影、颜色匹配、边缘与法线（docs/Plan.md §3.7 M8.7） */
export function FusionPanel() {
  const background = useApp((s) => s.doc.background)
  const hasCharacter = useApp((s) => s.doc.character !== null)
  if (!background) return <Empty>{t.light.noBackground}</Empty>
  return (
    <div className="flex flex-col gap-2">
      <LightSections assetId={background.id} />
      {hasCharacter && <FusionSections />}
    </div>
  )
}
