import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react'
import { hexToHsv, hsvToHex, parseHex, type Hsv } from '@/algo/color'
import { t } from '@/i18n'
import { cn } from './lib/cn'

const SWATCHES = ['#ffffff', '#ffe2bf', '#ffb36b', '#ff6b4a', '#ff8ac2', '#a78bfa', '#6aa6ff', '#6fdcc8']
const HUE_GRADIENT = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)'

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> }
const EyeDropper = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** 外部颜色换成 HSV；灰色、黑色没有色相（和饱和度），沿用当前值，指示点不会跳回左上角 */
function fromHex(hex: string, prev: Hsv): Hsv {
  const next = hexToHsv(hex)
  if (!next) return prev
  if (next.v === 0) return { ...prev, v: 0 }
  return next.s === 0 ? { ...next, h: prev.h } : next
}

interface Props {
  value: string
  onBegin: () => void
  onChange: (hex: string) => void
  onEnd: () => void
  testId?: string
}

/** Material 风格的取色面板：饱和度与明度区域、色相条、十六进制输入、常用颜色和屏幕取色。每次拖动或输入合并为一次撤销记录。 */
export function ColorPicker({ value, onBegin, onChange, onEnd, testId }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => fromHex(value, { h: 0, s: 0, v: 1 }))
  // 外部的值变化（如撤销）时同步；自己发出的修改不回写，否则灯光颜色按最大分量归一化后指示点会跳动
  const [seen, setSeen] = useState({ value, own: false })
  if (seen.value !== value) {
    setSeen({ value, own: false })
    if (!seen.own) setHsv((prev) => fromHex(value, prev))
  }
  const [draft, setDraft] = useState<string | null>(null)
  const hex = hsvToHex(hsv)

  const active = useRef(false)
  const endRef = useRef(onEnd)
  useEffect(() => {
    endRef.current = onEnd
  })
  // 拖动中面板被关闭时也要结束这次撤销记录
  useEffect(
    () => () => {
      if (active.current) endRef.current()
    },
    [],
  )

  const emit = (next: Hsv) => {
    setHsv(next)
    // 颜色没变（如灰色时改色相、拖到边界外）不产生修改，也就不会留下空的撤销记录
    if (hsvToHex(next) === hex) return
    setSeen((s) => ({ ...s, own: true }))
    active.current = true
    onBegin()
    onChange(hsvToHex(next))
  }
  const end = () => {
    if (!active.current) return
    active.current = false
    onEnd()
  }
  const commit = (text: string) => {
    const parsed = parseHex(text)
    if (!parsed) return
    emit(fromHex(parsed, hsv))
    end()
  }

  // 方向键微调，Shift 加大步长
  const nudge = (next: Hsv | null) => {
    if (!next) return false
    emit(next)
    end()
    return true
  }

  return (
    <div className="flex w-68 flex-col gap-4 p-4" data-testid={testId && `${testId}-picker`}>
      <Surface
        aria-label={t.colorPicker.area}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={t.colorPicker.areaValue(Math.round(hsv.s * 100), Math.round(hsv.v * 100))}
        className="h-40 cursor-crosshair rounded-xl focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-high"
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }), backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)' }}
        onPick={(x, y) => emit({ h: hsv.h, s: x, v: 1 - y })}
        onNudge={(key, k) => {
          const d = k / 100
          if (key === 'ArrowLeft' || key === 'ArrowRight') return nudge({ ...hsv, s: clamp01(hsv.s + (key === 'ArrowLeft' ? -d : d)) })
          if (key === 'ArrowDown' || key === 'ArrowUp') return nudge({ ...hsv, v: clamp01(hsv.v + (key === 'ArrowDown' ? -d : d)) })
          return false
        }}
        onRelease={end}
        testId={testId && `${testId}-area`}
      >
        <span className="pointer-events-none absolute size-5 -translate-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hex }} />
      </Surface>

      <Surface
        aria-label={t.colorPicker.hue}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="flex h-6 cursor-pointer items-center rounded-full"
        onPick={(x) => emit({ ...hsv, h: x * 360 })}
        onNudge={(key, k) => {
          if (key === 'ArrowLeft' || key === 'ArrowDown') return nudge({ ...hsv, h: Math.max(0, hsv.h - k) })
          if (key === 'ArrowRight' || key === 'ArrowUp') return nudge({ ...hsv, h: Math.min(360, hsv.h + k) })
          return false
        }}
        onRelease={end}
        testId={testId && `${testId}-hue`}
      >
        <div className="h-3 w-full rounded-full" style={{ background: HUE_GRADIENT }} />
        <span
          className="pointer-events-none absolute top-1/2 size-5 -translate-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgb(0_0_0/0.5)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        />
      </Surface>

      <div className="flex items-center gap-2">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-(--mdui-shape-corner-extra-small) px-3 ring-1 ring-outline focus-within:ring-2 focus-within:ring-primary">
          <span className="size-5 shrink-0 rounded-full ring-1 ring-white/20" style={{ backgroundColor: hex }} />
          <span className="text-on-surface-variant">#</span>
          <input
            value={draft ?? hex.slice(1)}
            onChange={(e) => {
              setDraft(e.target.value)
              // 完整的六位颜色立即生效（粘贴时），三位简写等确认后再生效
              if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) commit(e.target.value)
            }}
            onBlur={() => {
              if (draft !== null) commit(draft)
              setDraft(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || draft === null) return
              commit(draft)
              setDraft(null)
            }}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-label={t.colorPicker.hex}
            className="min-w-0 flex-1 bg-transparent font-mono text-sm tracking-wider uppercase outline-none"
            data-testid={testId && `${testId}-hex`}
          />
        </label>
        {EyeDropper && (
          <mdui-button-icon
            onClick={() =>
              new EyeDropper()
                .open()
                .then((r) => commit(r.sRGBHex))
                .catch(() => {})
            }
            aria-label={t.colorPicker.eyedropper}
            title={t.colorPicker.eyedropper}
          >
            <mdui-icon-colorize--outlined />
          </mdui-button-icon>
        )}
      </div>

      <div className="flex justify-between">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => commit(c)}
            aria-label={t.colorPicker.swatch(c)}
            className={cn(
              'size-6 cursor-pointer rounded-full ring-1 ring-white/20 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              c === hex && 'outline-2 outline-offset-2 outline-primary',
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  )
}

type SurfaceProps = {
  /** 指针在区域内的相对位置，0–1 */
  onPick: (fx: number, fy: number) => void
  /** 方向键；返回 true 表示已处理 */
  onNudge: (key: string, step: number) => boolean
  onRelease: () => void
  testId?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onPointerDown' | 'onPointerMove' | 'onLostPointerCapture'>

/** 可拖动的二维或一维取色区域（role=slider），按下后持续报告指针位置，方向键微调（Shift 加大步长） */
function Surface({ onPick, onNudge, onRelease, testId, className, children, ...rest }: SurfaceProps) {
  const at = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onPick(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height))
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      {...rest}
      className={cn('relative touch-none outline-none focus-visible:ring-2 focus-visible:ring-primary', className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        at(e)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e)
      }}
      onLostPointerCapture={onRelease}
      onKeyDown={(e: KeyboardEvent) => {
        // 处理过的按键不再触发编辑器快捷键（如方向键移动立绘）
        if (!onNudge(e.key, e.shiftKey ? 10 : 1)) return
        e.preventDefault()
        e.stopPropagation()
      }}
      data-testid={testId}
    >
      {children}
    </div>
  )
}
