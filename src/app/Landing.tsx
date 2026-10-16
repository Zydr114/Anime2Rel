import { useState } from 'react'
import { t } from '@/i18n'
import type { AssetRef } from '@/state/assets'
import { useApp } from '@/state/store'
import { BitmapThumb } from '@/ui/BitmapThumb'
import { cn } from '@/ui/lib/cn'
import { AuroraText } from '@/ui/magicui/aurora-text'
import { BlurFade } from '@/ui/magicui/blur-fade'
import { BorderBeam } from '@/ui/magicui/border-beam'
import { ShimmerButton } from '@/ui/magicui/shimmer-button'
import { importFiles, pickFiles } from './importer'
import { LegalLinks } from './LegalLinks'

function DropZone({ role, title, hint, asset, optional }: { role: 'background' | 'character'; title: string; hint: string; asset: AssetRef | null; optional?: boolean }) {
  const [over, setOver] = useState(false)
  return (
    <button
      type="button"
      data-testid={`drop-${role}`}
      onClick={() => pickFiles(role)}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files, role)
      }}
      className={cn(
        'glass relative flex h-64 w-72 cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-3xl p-5 text-center transition-transform',
        'hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-primary',
        over && 'scale-[1.02] bg-primary/10',
      )}
    >
      {asset ? (
        <>
          <BitmapThumb assetId={asset.id} maxEdge={150} />
          <div className="max-w-full truncate text-sm">{asset.name}</div>
          <div className="text-xs text-on-surface-variant">
            {t.landing.loaded} · {asset.width} × {asset.height}
          </div>
        </>
      ) : (
        <>
          {role === 'background' ? (
            <mdui-icon-landscape--outlined style={{ fontSize: 44 }} />
          ) : (
            <mdui-icon-face--outlined style={{ fontSize: 44 }} />
          )}
          <div className="text-lg font-medium">{title}</div>
          <div className="text-xs leading-5 text-on-surface-variant">{hint}</div>
          {optional && <div className="text-xs text-on-surface-variant/70">{t.landing.optional}</div>}
        </>
      )}
      <BorderBeam size={90} duration={role === 'background' ? 7 : 9} delay={role === 'background' ? 0 : 3} colorFrom="#ffb27a" colorTo="#8f7bff" borderWidth={1.5} />
    </button>
  )
}

/** 首屏：选择素材后进入编辑器。 */
export function Landing({ onStart }: { onStart: () => void }) {
  const background = useApp((s) => s.doc.background)
  const character = useApp((s) => s.doc.character)

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_20%_10%,rgba(255,150,90,0.16),transparent),radial-gradient(50%_50%_at_85%_80%,rgba(120,100,255,0.18),transparent)]" />
      <div className="relative flex min-h-full flex-col items-center justify-center gap-10 px-6 py-12">
        <BlurFade delay={0.05}>
          <div className="text-center">
            <h1 className="text-6xl font-bold tracking-tight">
              <AuroraText colors={['#ffb27a', '#ff7aa8', '#8f7bff', '#6ad7ff']}>{t.app.name}</AuroraText>
            </h1>
            <p className="mt-3 text-xl">{t.app.tagline}</p>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-on-surface-variant">{t.app.description}</p>
          </div>
        </BlurFade>
        <BlurFade delay={0.15}>
          <div className="flex flex-wrap justify-center gap-6">
            <DropZone role="background" title={t.landing.background} hint={t.landing.backgroundHint} asset={background} />
            <DropZone role="character" title={t.landing.character} hint={t.landing.characterHint} asset={character} optional />
          </div>
        </BlurFade>
        <BlurFade delay={0.25}>
          <div className="flex flex-col items-center gap-2">
            <ShimmerButton
              className="px-10 text-base font-medium"
              background="rgb(var(--mdui-color-primary-container))"
              shimmerColor="#ffd2b0"
              disabled={!background}
              onClick={onStart}
              data-testid="start"
              style={{ opacity: background ? 1 : 0.5 }}
            >
              {t.landing.start}
            </ShimmerButton>
            {!background && <span className="text-xs text-on-surface-variant">{t.landing.needBackground}</span>}
          </div>
        </BlurFade>
        <LegalLinks className="mt-4" />
      </div>
    </div>
  )
}
