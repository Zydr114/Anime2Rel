import { t } from '@/i18n'

export function PlaceholderPanel({ milestone }: { milestone: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 p-5 text-sm text-on-surface-variant">
      <div className="mb-1 font-medium text-on-surface">{t.placeholder.title}</div>
      {t.placeholder.body(milestone)}
    </div>
  )
}
