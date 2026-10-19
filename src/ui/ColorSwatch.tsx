import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ColorPicker } from './ColorPicker'

interface Props {
  /** sRGB 十六进制颜色 */
  value: string
  label: string
  /** 选色过程中连续调用；onBegin、onEnd 用于把一次拖动或输入合并为一次撤销记录 */
  onBegin: () => void
  onChange: (hex: string) => void
  onEnd: () => void
  testId?: string
}

/** 色块按钮，点击后在旁边弹出取色面板。 */
export function ColorSwatch({ value, label, onBegin, onChange, onEnd, testId }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className="size-8 shrink-0 cursor-pointer rounded-full ring-1 ring-white/25 transition-shadow hover:ring-2 hover:ring-white/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        style={{ backgroundColor: value }}
        data-testid={testId}
      />
      {open && (
        <Popover anchor={triggerRef} label={label} onClose={() => setOpen(false)}>
          <ColorPicker value={value} onBegin={onBegin} onChange={onChange} onEnd={onEnd} testId={testId} />
        </Popover>
      )}
    </>
  )
}

const MARGIN = 8
const GAP = 8

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), Math.max(lo, hi))

/** 优先放在锚点下方，放不下时放上方，都放不下时贴着窗口；水平方向向窗口内侧对齐。整个面板始终留在窗口内。 */
function place(el: HTMLElement, anchor: DOMRect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = el.offsetWidth
  const h = Math.min(el.scrollHeight, vh - 2 * MARGIN)
  const left = clamp(anchor.left + anchor.width / 2 > vw / 2 ? anchor.right - w : anchor.left, MARGIN, vw - w - MARGIN)
  let top: number
  let originY: string
  if (anchor.bottom + GAP + h <= vh - MARGIN) {
    top = anchor.bottom + GAP
    originY = 'top'
  } else if (anchor.top - GAP - h >= MARGIN) {
    top = anchor.top - GAP - h
    originY = 'bottom'
  } else {
    top = clamp(anchor.top + anchor.height / 2 - h / 2, MARGIN, vh - h - MARGIN)
    originY = 'center'
  }
  Object.assign(el.style, {
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${vh - 2 * MARGIN}px`,
    transformOrigin: `${clamp(anchor.left + anchor.width / 2 - left, 0, w)}px ${originY}`,
  })
}

/** 挂到 body 上的浮层：点击外部、按 Esc 或焦点移出时关闭；窗口缩放、滚动时跟随锚点。 */
function Popover({ anchor, label, onClose, children }: { anchor: RefObject<HTMLElement | null>; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor.current) return
    const update = () => anchor.current && place(el, anchor.current.getBoundingClientRect())
    update()
    el.focus({ preventScroll: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath()
      if (ref.current && !path.includes(ref.current) && !(anchor.current && path.includes(anchor.current))) closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        closeRef.current()
        anchor.current?.focus()
      }}
      onBlur={(e) => {
        const to = e.relatedTarget
        if (to instanceof Node && !e.currentTarget.contains(to) && to !== anchor.current) closeRef.current()
      }}
      className="fixed top-0 left-0 z-2100 animate-popover-in overflow-y-auto rounded-2xl bg-surface-container-high text-on-surface shadow-(--mdui-elevation-level3) ring-1 ring-white/8 outline-none motion-reduce:animate-none"
    >
      {children}
    </div>,
    document.body,
  )
}
