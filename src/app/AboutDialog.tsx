import { useEffect, useRef } from 'react'
import type { Dialog } from 'mdui/components/dialog.js'
import { t } from '@/i18n'
import { useEngine } from '@/state/engine'
import { useDomEvent } from '@/ui/useDomEvent'

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<Dialog>(null)
  const caps = useEngine((s) => s.engine?.capabilities)
  useDomEvent(ref, 'closed', () => onClose())

  // mdui 只在焦点位于对话框内时响应 Esc，这里在窗口级补充处理
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <mdui-dialog ref={ref} open={open} close-on-overlay-click close-on-esc headline={t.about.title} data-testid="about">
      <div className="flex flex-col gap-3 text-sm leading-6">
        <div>{t.about.version(__APP_VERSION__, __APP_COMMIT__)}</div>
        <p className="text-on-surface-variant">{t.about.license}</p>
        <div className="flex flex-wrap gap-x-4">
          <a className="text-primary underline" href={__SOURCE_URL__} target="_blank" rel="noreferrer">
            {t.about.source}
          </a>
          <a className="text-primary underline" href="./LICENSE.txt" target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>
          <a className="text-primary underline" href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">
            {t.about.notices}
          </a>
        </div>
        {caps && (
          <section>
            <h3 className="font-medium">{t.about.gpu}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-on-surface-variant" data-testid="gpu-info">
              <dt>{t.about.backend}</dt>
              <dd>{caps.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}</dd>
              <dt>{t.about.maxTexture}</dt>
              <dd>{caps.maxTextureSize}</dd>
              <dt>{t.about.f16}</dt>
              <dd>{caps.shaderF16 ? t.about.yes : t.about.no}</dd>
              <dt>{t.about.adapter}</dt>
              <dd className="break-all">{caps.adapter}</dd>
            </dl>
          </section>
        )}
      </div>
      <mdui-button slot="action" variant="text" onClick={onClose}>
        {t.about.close}
      </mdui-button>
    </mdui-dialog>
  )
}
