import { useState } from 'react'
import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { ShimmerButton } from '@/ui/magicui/shimmer-button'
import { exportPng } from '../exporter'

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
    </div>
  )
}
