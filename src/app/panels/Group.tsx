import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Switch } from 'mdui/components/switch.js'
import { t } from '@/i18n'
import { useGroups } from '@/state/groups'
import { cn } from '@/ui/lib/cn'
import { useDomEvent } from '@/ui/useDomEvent'

/** 说明：一段文字或几段文字 */
export type HelpText = string | readonly string[]

interface GroupProps {
  /** 展开状态按 id 记在浏览器中 */
  id: string
  title: ReactNode
  /** 收起时显示在标题后面 */
  summary?: ReactNode
  /** “?”按钮中的说明 */
  help?: HelpText
  /** 可以整体开关的效果：标题行上的开关 */
  toggle?: { checked: boolean; onChange: (v: boolean) => void; testId: string }
  defaultOpen?: boolean
  testId?: string
  /** 写在 data-state 上的状态（收起时测试也能读到） */
  state?: string
  children: ReactNode
}

/** 侧栏中可折叠的分组（docs/Plan.md §3.7 M8.7）。收起时不渲染内容 */
export function Group({ id, title, summary, help, toggle, defaultOpen = false, testId, state, children }: GroupProps) {
  const open = useGroups((s) => s.open[id] ?? defaultOpen)
  return (
    <section className="flex flex-col rounded-2xl bg-white/5 text-sm" data-testid={testId} data-group={id} data-open={open} data-state={state}>
      <div className="flex min-h-11 items-center gap-1 pr-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch rounded-2xl py-2 pl-2 text-left"
          aria-expanded={open}
          onClick={() => useGroups.getState().setOpen(id, !open)}
          data-group-header={id}
        >
          <mdui-icon-expand-more--outlined className={cn('size-5 shrink-0 text-on-surface-variant transition-transform', !open && '-rotate-90')} />
          <h3 className="shrink-0 font-medium">{title}</h3>
          {!open && summary !== undefined && <span className="ml-1 min-w-0 truncate text-xs text-on-surface-variant">{summary}</span>}
        </button>
        {toggle && <HeaderSwitch {...toggle} />}
        {help && <Help title={typeof title === 'string' ? title : undefined} text={help} />}
      </div>
      {open && <div className="flex flex-col gap-3 px-3 pb-3">{children}</div>}
    </section>
  )
}

function HeaderSwitch({ checked, onChange, testId }: { checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  const ref = useRef<Switch>(null)
  useDomEvent(ref, 'change', (e, el) => {
    if (e.target === el) onChange(el.checked)
  })
  return <mdui-switch ref={ref} checked={checked} className="mx-1 shrink-0" data-testid={testId} />
}

/**
 * “?”说明按钮：悬停时显示，点击后保持显示，点击别处或按 Esc 关闭。
 * 侧栏的背景模糊会成为 fixed 定位的包含块，所以说明画在 body 上，放在按钮左侧。
 */
export function Help({ title, text, className }: { title?: string; text: HelpText; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const timer = useRef(0)
  /** 打开方式和打开时按钮的位置 */
  const [open, setOpen] = useState<{ mode: 'hover' | 'pinned'; anchor: DOMRect } | null>(null)
  const paragraphs = typeof text === 'string' ? [text] : text
  const pinned = open?.mode === 'pinned'

  useEffect(() => {
    if (!pinned) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [pinned])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={title ? `${t.ui.help}：${title}` : t.ui.help}
        aria-expanded={!!open}
        className={cn('flex size-7 shrink-0 cursor-help items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-white/10 hover:text-on-surface', className)}
        onMouseEnter={(e) => {
          const el = e.currentTarget
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setOpen((o) => o ?? { mode: 'hover', anchor: el.getBoundingClientRect() }), 250)
        }}
        onMouseLeave={() => {
          window.clearTimeout(timer.current)
          setOpen((o) => (o?.mode === 'hover' ? null : o))
        }}
        onClick={(e) => {
          e.stopPropagation()
          const anchor = e.currentTarget.getBoundingClientRect()
          window.clearTimeout(timer.current)
          setOpen((o) => (o?.mode === 'pinned' ? null : { mode: 'pinned', anchor }))
        }}
        data-testid="help"
      >
        <mdui-icon-help-outline--outlined className="size-[18px]" />
      </button>
      {open && createPortal(<HelpPopup anchor={open.anchor} title={title} paragraphs={paragraphs} />, document.body)}
    </>
  )
}

const POPUP_GAP = 8

function HelpPopup({ anchor: a, title, paragraphs }: { anchor: DOMRect; title?: string; paragraphs: readonly string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    setAt({
      left: Math.max(POPUP_GAP, a.left - el.offsetWidth - POPUP_GAP),
      top: Math.max(POPUP_GAP, Math.min(a.top - POPUP_GAP, window.innerHeight - el.offsetHeight - POPUP_GAP)),
    })
  }, [a])
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn('glass-popup pointer-events-none fixed z-[2500] flex w-72 flex-col gap-1.5 rounded-2xl px-4 py-3 text-xs leading-5', at && 'animate-popover-in origin-top-right')}
      style={at ?? { left: 0, top: 0, visibility: 'hidden' }}
      data-testid="help-popup"
    >
      {title && <div className="text-sm font-medium text-on-surface">{title}</div>}
      {paragraphs.map((p, i) => (
        <p key={i} className="text-on-surface-variant">
          {p}
        </p>
      ))}
    </div>
  )
}

/** 分组中不常用的参数，默认收起 */
export function More({ id, children }: { id: string; children: ReactNode }) {
  const open = useGroups((s) => s.open[id] ?? false)
  return (
    <>
      <button
        type="button"
        className="-my-1 flex cursor-pointer items-center gap-1 self-start rounded-full py-1 pr-2 text-xs text-on-surface-variant transition-colors hover:text-on-surface"
        aria-expanded={open}
        onClick={() => useGroups.getState().setOpen(id, !open)}
        data-group-header={id}
      >
        <mdui-icon-expand-more--outlined className={cn('size-4 transition-transform', !open && '-rotate-90')} />
        {open ? t.ui.less : t.ui.more}
      </button>
      {open && children}
    </>
  )
}

/** 侧栏中的状态与警告（说明放在“?”中） */
export function Hint({ children, warn, testId }: { children: ReactNode; warn?: boolean; testId?: string }) {
  return (
    <p className={cn('text-xs leading-5', warn ? 'text-champagne' : 'text-on-surface-variant')} data-testid={testId}>
      {children}
    </p>
  )
}

export function ToggleRow({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  const ref = useRef<Switch>(null)
  useDomEvent(ref, 'change', (e, el) => {
    if (e.target === el) onChange(el.checked)
  })
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <mdui-switch ref={ref} checked={checked} data-testid={testId} />
    </div>
  )
}

/** 面板没有可编辑内容时的提示 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 text-sm text-on-surface-variant">{children}</p>
}
