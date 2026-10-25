import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Button } from 'mdui/components/button.js'
import { t } from '@/i18n'
import { useTour } from '@/state/dialogs'
import { cameraPending, useApp } from '@/state/store'
import { steps } from './steps'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 气泡相对高亮区域的位置；center 为放在区域（没有区域时为整个窗口）的正中 */
type Side = 'right' | 'left' | 'top' | 'center'

interface Page {
  id: string
  title: string
  /** 高亮的元素（选择器）或区域；都没有时不高亮 */
  selector?: string
  area?: () => Rect
  side: Side
  /** 高亮框的圆角（px） */
  radius: number
  /** 气泡宽度（rem） */
  width: number
  body: (ctx: { found: boolean; pending: boolean }) => ReactNode
}

/** 高亮框比目标向外多出的距离、气泡与高亮框的间距、气泡与窗口边缘的最小距离（px） */
const PAD = 6
const GAP = 14
const MARGIN = 16

const s = t.tour

const Paragraphs = ({ lines }: { lines: readonly string[] }) => (
  <>
    {lines.map((line) => (
      <p key={line}>{line}</p>
    ))}
  </>
)

/** 画布：编辑器浮动面板之间露出的区域（见 App 的 EDITOR_INSETS） */
function canvasArea(): Rect {
  const i = useApp.getState().viewInsets
  return { x: i.left, y: i.top, w: innerWidth - i.left - i.right, h: innerHeight - i.top - i.bottom }
}

const PAGES: Page[] = [
  {
    id: 'welcome',
    title: s.welcome.title,
    side: 'center',
    radius: 0,
    width: 30,
    body: () => (
      <>
        <p>{s.welcome.body}</p>
        <ol className="flex flex-col gap-2">
          {s.welcome.flow.map((f, i) => (
            <li key={f.name} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{f.name}</span>
                  <span className="rounded-full bg-on-surface/10 px-2 text-xs leading-5 text-on-surface-variant">{t.steps[f.step]}</span>
                </div>
                <div className="text-xs leading-5 text-on-surface-variant">{f.text}</div>
              </div>
            </li>
          ))}
        </ol>
      </>
    ),
  },
  {
    id: 'steps',
    title: s.steps.title,
    selector: '[data-tour="steps"]',
    side: 'right',
    radius: 30,
    width: 24,
    body: () => (
      <>
        <p>{s.steps.body}</p>
        <ul className="flex flex-col gap-1.5 text-xs leading-5">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2">
              {createElement(`mdui-icon-${step.icon}`, { className: 'mt-0.5 size-4 shrink-0 text-primary' })}
              <span>
                <span className="font-medium">{step.label}</span>
                <span className="text-on-surface-variant">：{s.steps.items[step.id]}</span>
              </span>
            </li>
          ))}
        </ul>
      </>
    ),
  },
  { id: 'canvas', title: s.canvas.title, area: canvasArea, side: 'center', radius: 16, width: 22, body: () => <Paragraphs lines={s.canvas.body} /> },
  { id: 'inspector', title: s.inspector.title, selector: '[data-testid="inspector"]', side: 'left', radius: 30, width: 22, body: () => <Paragraphs lines={s.inspector.body} /> },
  { id: 'toolbar', title: s.toolbar.title, selector: '[data-tour="toolbar"]', side: 'top', radius: 30, width: 22, body: () => <Paragraphs lines={s.toolbar.body} /> },
  {
    id: 'hints',
    title: s.hints.title,
    selector: '[data-testid="op-hints"], [data-testid="op-hints-expand"]',
    side: 'top',
    radius: 20,
    width: 22,
    body: ({ found }) => (
      <>
        <Paragraphs lines={s.hints.body} />
        {!found && <p className="text-on-surface-variant">{s.hints.hidden}</p>}
      </>
    ),
  },
  {
    id: 'settings',
    title: s.settings.title,
    selector: '[data-testid="settings-button"]',
    side: 'right',
    radius: 999,
    width: 22,
    body: ({ pending }) => (
      <>
        <Paragraphs lines={s.settings.body} />
        {pending && <p className="font-medium text-primary">{s.settings.calibrate}</p>}
      </>
    ),
  },
]

function measure(page: Page): Rect | null {
  if (page.area) return page.area()
  const el = page.selector ? document.querySelector(page.selector) : null
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
}

const sameRect = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

/** 气泡的左上角：按 side 放在高亮框旁边，限制在窗口内 */
function place(side: Side, rect: Rect | null, size: { w: number; h: number }): { left: number; top: number } {
  let left: number
  let top: number
  if (!rect || side === 'center') {
    const area = rect ?? { x: 0, y: 0, w: innerWidth, h: innerHeight }
    left = area.x + (area.w - size.w) / 2
    top = area.y + (area.h - size.h) / 2
  } else if (side === 'right') {
    left = rect.x + rect.w + PAD + GAP
    top = rect.y + (rect.h - size.h) / 2
  } else if (side === 'left') {
    left = rect.x - PAD - GAP - size.w
    top = rect.y + (rect.h - size.h) / 2
  } else {
    left = rect.x + (rect.w - size.w) / 2
    top = rect.y - PAD - GAP - size.h
  }
  const clamp = (v: number, hi: number) => Math.max(MARGIN, Math.min(v, hi - MARGIN))
  return { left: clamp(left, innerWidth - size.w), top: clamp(top, innerHeight - size.h) }
}

/** 当前页高亮区域的位置，随窗口和目标元素的大小变化更新 */
function useTargetRect(page: Page): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => measure(page))
  useLayoutEffect(() => {
    const update = () => {
      const next = measure(page)
      setRect((prev) => (sameRect(prev, next) ? prev : next))
    }
    update()
    window.addEventListener('resize', update)
    const el = page.selector ? document.querySelector(page.selector) : null
    const observer = new ResizeObserver(update)
    if (el) observer.observe(el)
    return () => {
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [page])
  return rect
}

/**
 * 新手指引（docs/Plan.md §3.7 M8.9）：屏幕变暗，逐页高亮界面的一个区域并在旁边说明。
 * 显示期间其他界面不能点击，快捷键不生效；Esc 跳过，← → 翻页。
 */
export function Tour() {
  const open = useTour((st) => st.open)
  if (!open) return null
  return createPortal(<TourOverlay />, document.body)
}

function TourOverlay() {
  const index = Math.min(useTour((st) => st.page), PAGES.length - 1)
  const pending = useApp((st) => cameraPending(st.doc))
  const page = PAGES[index]
  const last = index === PAGES.length - 1
  const rect = useTargetRect(page)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<Button>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const go = useCallback((i: number) => {
    if (i >= PAGES.length) useTour.getState().close()
    else useTour.getState().setPage(Math.max(0, i))
  }, [])

  // 气泡的大小随内容变化：渲染后测量，再放到高亮框旁边（在绘制之前完成，不会闪动）
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    const update = () => setPos(place(page.side, rect, { w: el.offsetWidth, h: el.offsetHeight }))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [page, rect])

  // 焦点放在“下一步”上：Enter 翻页，屏幕阅读器从气泡开始读
  useEffect(() => {
    const el = nextRef.current
    void el?.updateComplete.then(() => el.focus())
  }, [index])

  // 捕获阶段拦截按键：快捷键不生效；气泡中的按钮仍可用 Enter、空格、Tab 操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inBubble = e.target instanceof Node && !!bubbleRef.current?.contains(e.target)
      if (e.key === 'Tab' || (inBubble && (e.key === 'Enter' || e.key === ' '))) return
      if (e.key === 'Escape') useTour.getState().close()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(useTour.getState().page + 1)
      else if (e.key === 'ArrowLeft') go(useTour.getState().page - 1)
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go])

  const spot = rect && { left: rect.x - PAD, top: rect.y - PAD, width: rect.w + 2 * PAD, height: rect.h + 2 * PAD }

  return (
    <div className="fixed inset-0 z-[2350]" role="dialog" aria-modal="true" aria-label={t.tour.label} data-testid="tour" data-page={page.id}>
      {spot ? (
        <div
          className="pointer-events-none absolute outline-2 outline-primary/70 motion-safe:transition-all motion-safe:duration-300"
          style={{ ...spot, borderRadius: Math.min(page.radius, spot.width / 2, spot.height / 2), boxShadow: '0 0 0 200vmax rgb(0 0 0 / 0.55)' }}
          data-testid="tour-spotlight"
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}
      <div
        ref={bubbleRef}
        className="glass absolute flex flex-col gap-3 rounded-3xl p-5 text-sm leading-6"
        style={{ width: `min(${page.width}rem, calc(100vw - ${2 * MARGIN}px))`, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? undefined : 'hidden' }}
        data-testid="tour-bubble"
      >
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">{page.title}</h2>
          <span className="shrink-0 text-xs text-on-surface-variant tabular-nums" data-testid="tour-progress">
            {t.tour.progress(index + 1, PAGES.length)}
          </span>
        </header>
        <div className="flex flex-col gap-2">{page.body({ found: rect !== null, pending })}</div>
        <footer className="flex items-center justify-between gap-2 pt-1">
          {last ? <span /> : (
            <mdui-button variant="text" onClick={() => useTour.getState().close()} data-testid="tour-skip">
              {t.tour.skip}
            </mdui-button>
          )}
          <div className="flex items-center gap-2">
            {index > 0 && (
              <mdui-button variant="text" onClick={() => go(index - 1)} data-testid="tour-prev">
                {t.tour.prev}
              </mdui-button>
            )}
            <mdui-button ref={nextRef} variant="filled" onClick={() => go(index + 1)} data-testid="tour-next">
              {last ? t.tour.done : t.tour.next}
            </mdui-button>
          </div>
        </footer>
      </div>
    </div>
  )
}
