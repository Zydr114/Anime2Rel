import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import type { AssetRef } from '@/state/assets'
import { useApp } from '@/state/store'
import { BitmapThumb } from '@/ui/BitmapThumb'
import { cn } from '@/ui/lib/cn'
import { BlurFade } from '@/ui/magicui/blur-fade'
import { BorderBeam } from '@/ui/magicui/border-beam'
import { ShimmerButton } from '@/ui/magicui/shimmer-button'
import { HeroMark } from './HeroMark'
import { importFiles, pickFiles } from './importer'
import { LegalLinks } from './LegalLinks'
import { lastAutosave, pickProjectFile, restoreAutosave, type AutosaveInfo } from './project'

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
        'glass group relative flex h-64 w-72 cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-3xl p-5 text-center transition',
        'hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-champagne',
        over && 'scale-[1.02] outline-2 outline-champagne/60',
      )}
    >
      {asset ? (
        <>
          <BitmapThumb assetId={asset.id} maxEdge={150} />
          <div className="max-w-full truncate text-sm text-ivory">{asset.name}</div>
          <div className="text-xs text-taupe">
            {t.landing.loaded} · {asset.width} × {asset.height}
          </div>
        </>
      ) : (
        <>
          {role === 'background' ? (
            <mdui-icon-landscape--outlined className="text-champagne" style={{ fontSize: 40 }} />
          ) : (
            <mdui-icon-face--outlined className="text-champagne" style={{ fontSize: 40 }} />
          )}
          <div className="text-lg font-medium text-ivory">{title}</div>
          <div className="text-xs leading-5 text-taupe">{hint}</div>
          {optional && <div className="text-xs text-taupe/70">{t.landing.optional}</div>}
        </>
      )}
      <HoverLayer />
      <BorderBeam size={90} duration={role === 'background' ? 7 : 9} delay={role === 'background' ? 0 : 3} colorFrom="#ffb27a" colorTo="#8f7bff" borderWidth={1.5} />
    </button>
  )
}

const start = () => useApp.getState().start()

/** 玻璃按钮的悬停高亮：玻璃元素自身的背景会被当作玻璃后面的背景，所以另用一层叠在玻璃之上、内容之下（按钮需带 group 类） */
function HoverLayer() {
  return <span className="pointer-events-none absolute inset-0 -z-1 rounded-[inherit] transition-colors [corner-shape:inherit] group-hover:bg-white/5" />
}

/** 与“开始”按钮同高的胶囊按钮 */
const PILL = 'glass group relative flex h-12 cursor-pointer items-center rounded-full focus-visible:outline-2 focus-visible:outline-champagne'

/** 继续浏览器中自动保存的上一个工程，或打开工程文件 */
function ProjectEntries() {
  const [last, setLast] = useState<(AutosaveInfo & { url: string | null }) | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    let url: string | null = null
    void lastAutosave().then((info) => {
      if (!alive || !info) return
      url = info.thumbnail && URL.createObjectURL(info.thumbnail)
      setLast({ ...info, url })
    })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [])

  const resume = async () => {
    setBusy(true)
    if (await restoreAutosave()) start()
    else setBusy(false)
  }

  const open = () => pickProjectFile(start)

  if (!last) {
    return (
      <button type="button" onClick={open} data-testid="open-project" className={cn(PILL, 'gap-2 px-6 text-sm text-ivory')}>
        <HoverLayer />
        <mdui-icon-folder-open--outlined className="text-champagne" style={{ fontSize: 20 }} />
        {t.landing.openProject}
      </button>
    )
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button type="button" onClick={resume} disabled={busy} data-testid="resume-project" className={cn(PILL, 'gap-3 py-1 pr-5 pl-1 text-left disabled:cursor-progress disabled:opacity-60')}>
        <HoverLayer />
        {last.url ? (
          <img src={last.url} alt="" className="h-10 w-14 rounded-full object-cover" />
        ) : (
          <span className="flex h-10 w-14 items-center justify-center rounded-full bg-white/5">
            <mdui-icon-history--outlined className="text-champagne" />
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ivory">{t.landing.resume}</span>
          <span className="max-w-52 truncate text-xs text-taupe">
            {last.name} · {t.project.savedAt(last.savedAt)}
          </span>
        </span>
      </button>
      <button type="button" onClick={open} data-testid="open-project" className="cursor-pointer text-xs text-taupe underline-offset-4 hover:text-ivory hover:underline">
        {t.landing.openProject}
      </button>
    </div>
  )
}

/** 首屏：选择素材后进入编辑器，或继续之前的工程。 */
export function Landing() {
  const background = useApp((s) => s.doc.background)
  const character = useApp((s) => s.doc.character)

  return (
    <div className="absolute inset-0 overflow-y-auto">
      {/* 顶部一束很淡的香槟色光，叠一层胶片颗粒 */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_50%_at_50%_0%,rgba(201,169,110,0.09),transparent)]" />
      <div className="film-grain pointer-events-none absolute inset-0 opacity-[0.035]" />
      <div className="relative flex min-h-full flex-col items-center justify-center gap-12 px-6 py-12 [@media(max-height:820px)]:gap-8 [@media(max-height:820px)]:py-6">
        {/* 主视觉的高度随窗口高度收缩，矮屏幕上同时收紧间距，让“开始”按钮留在首屏内 */}
        <div className="flex flex-col items-center gap-8 [@media(max-height:820px)]:gap-5">
          <HeroMark className="h-[clamp(8rem,100dvh_-_47rem,13rem)] w-auto max-sm:h-44" />
          <BlurFade delay={0.05}>
            <div className="text-center">
              {/* 名称中的“2”用香槟金斜体 */}
              <h1 className="font-display text-7xl leading-none tracking-tight text-ivory sm:text-8xl">
                {t.app.name.split(/(2)/).map((part, i) => (part === '2' ? <em key={i} className="px-1 text-champagne">2</em> : part))}
              </h1>
              <div className="mx-auto mt-6 h-px w-14 bg-champagne/60" />
              <p className="mt-6 text-lg tracking-[0.3em] text-taupe">{t.app.tagline}</p>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-taupe/75">{t.app.description}</p>
            </div>
          </BlurFade>
        </div>
        <BlurFade delay={0.15}>
          <div className="flex flex-wrap justify-center gap-6">
            <DropZone role="background" title={t.landing.background} hint={t.landing.backgroundHint} asset={background} />
            <DropZone role="character" title={t.landing.character} hint={t.landing.characterHint} asset={character} optional />
          </div>
        </BlurFade>
        <BlurFade delay={0.25}>
          <div className="flex flex-wrap items-start justify-center gap-4">
            <div className="flex flex-col items-center gap-2">
              <ShimmerButton
                className="h-12 px-10 text-base font-medium"
                background="rgb(var(--mdui-color-primary-container))"
                shimmerColor="#ffd2b0"
                disabled={!background}
                onClick={start}
                data-testid="start"
                style={{ opacity: background ? 1 : 0.5 }}
              >
                {t.landing.start}
              </ShimmerButton>
              {!background && <span className="text-xs text-on-surface-variant">{t.landing.needBackground}</span>}
            </div>
            <ProjectEntries />
          </div>
        </BlurFade>
        <LegalLinks className="mt-4" />
      </div>
    </div>
  )
}
