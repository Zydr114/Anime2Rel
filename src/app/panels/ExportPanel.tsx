import { useState } from 'react'
import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { ShimmerButton } from '@/ui/magicui/shimmer-button'
import { exportPng } from '../exporter'
import { pickProjectFile, saveProjectFile } from '../project'

export function ExportPanel() {
  const background = useApp((s) => s.doc.background)
  const [busy, setBusy] = useState(false)
  if (!background) return null

  const run = async () => {
    setBusy(true)
    try {
      await exportPng()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl bg-white/5 p-3 text-sm leading-6">
        <div>{t.export.format}</div>
        <div>{t.export.resolution(background.width, background.height)}</div>
      </section>
      <ShimmerButton
        className="w-full text-sm font-medium"
        background="rgb(var(--mdui-color-primary-container))"
        shimmerColor="rgb(var(--mdui-color-primary))"
        onClick={run}
        disabled={busy}
        data-testid="export-png"
      >
        {busy ? t.export.working : t.export.action}
      </ShimmerButton>

      <section className="mt-1 flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
        <h3 className="text-sm font-medium">{t.project.title}</h3>
        <p className="text-xs leading-5 text-on-surface-variant">{t.project.hint}</p>
        <mdui-button variant="tonal" onClick={() => void saveProjectFile()} data-testid="save-project">
          <mdui-icon-save--outlined slot="icon" />
          {t.project.save}
        </mdui-button>
        <mdui-button variant="outlined" onClick={() => pickProjectFile()} data-testid="open-project-editor">
          <mdui-icon-folder-open--outlined slot="icon" />
          {t.project.open}
        </mdui-button>
      </section>
    </div>
  )
}
