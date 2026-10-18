import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { hueSwatch } from '@/grade/creative'

/** 色相 h 在圆盘上的方向为从右侧逆时针 h + 74°，与示波器的色相环大致相同（红在左上，蓝在右下） */
const HUE_OFFSET = 74
/** 离圆心这么近时视为不偏色 */
const SNAP = 0.04

const DEG = Math.PI / 180

// conic-gradient 从正上方顺时针，θ 处的色相为 90 − θ − 74
const BACKGROUND = [
  'radial-gradient(closest-side, rgb(128 128 128) 0%, rgb(128 128 128 / 0) 100%)',
  `conic-gradient(${Array.from({ length: 25 }, (_, i) => hueSwatch((((90 - HUE_OFFSET - i * 15) % 360) + 360) % 360)).join(', ')})`,
].join(', ')

interface Props {
  hue: number
  amount: number
  onBegin: () => void
  onChange: (hue: number, amount: number) => void
  onEnd: () => void
  testId?: string
}

/** 色轮：圆点的方向为偏色的色相，离圆心的距离为强度。拖动圆盘任意位置调整，双击复位。 */
export function ColorWheel({ hue, amount, onBegin, onChange, onEnd, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const pointer = useRef<number | null>(null)

  const update = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const dx = ((e.clientX - r.left) / r.width) * 2 - 1
    const dy = ((e.clientY - r.top) / r.height) * 2 - 1
    const d = Math.min(1, Math.hypot(dx, dy))
    const h = (((Math.atan2(-dy, dx) / DEG - HUE_OFFSET) % 360) + 360) % 360
    onChange(d < SNAP ? hue : Math.round(h), d < SNAP ? 0 : d)
  }

  const angle = (hue + HUE_OFFSET) * DEG
  return (
    <div
      ref={ref}
      className="relative mx-auto aspect-square w-full max-w-44 touch-none rounded-full ring-1 ring-white/15"
      style={{ background: BACKGROUND }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        pointer.current = e.pointerId
        onBegin()
        update(e)
      }}
      onPointerMove={(e) => pointer.current === e.pointerId && update(e)}
      onPointerUp={(e) => {
        if (pointer.current !== e.pointerId) return
        pointer.current = null
        onEnd()
      }}
      onPointerCancel={() => {
        pointer.current = null
        onEnd()
      }}
      onDoubleClick={() => {
        onBegin()
        onChange(hue, 0)
        onEnd()
      }}
      data-testid={testId}
    >
      <span className="pointer-events-none absolute top-1/2 left-1/2 size-1 -translate-1/2 rounded-full bg-black/40" />
      <span
        className="pointer-events-none absolute size-4 -translate-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        style={{ left: `${50 + 50 * amount * Math.cos(angle)}%`, top: `${50 - 50 * amount * Math.sin(angle)}%`, background: amount > 0 ? hueSwatch(hue) : 'rgb(128 128 128)' }}
      />
    </div>
  )
}
