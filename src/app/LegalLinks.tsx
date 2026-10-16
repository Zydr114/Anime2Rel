import { t } from '@/i18n'
import { cn } from '@/ui/lib/cn'

/** AGPL §13：向网络用户提供源码。 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-on-surface-variant', className)}>
      <span>{t.footer.local}</span>
      {/* 两个链接作为一组换行，避免在窄侧栏里被拆散 */}
      <span className="flex gap-x-4">
        <a className="underline hover:text-on-surface" href={__SOURCE_URL__} target="_blank" rel="noreferrer" data-testid="source-link">
          {t.footer.source}
        </a>
        <a className="underline hover:text-on-surface" href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">
          {t.footer.notices}
        </a>
      </span>
    </div>
  )
}
