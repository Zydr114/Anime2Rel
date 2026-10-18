import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { evalCurve, monotoneCurve } from '@/algo/curve'
import type { CurvePoints } from '@/grade/model'

/** 坐标范围（viewBox） */
const SIZE = 256
/** 相邻控制点的最小横向间距 */
const MIN_GAP = 0.02
/** 中间的控制点拖出方框这么远时松手即删除 */
const REMOVE_DISTANCE = 0.12
/** 拾取控制点的半径（相对方框边长） */
const PICK = 0.05

interface Props {
  points: CurvePoints
  color: string
  /** 其他通道的曲线，淡色显示 */
  others: readonly { points: CurvePoints; color: string }[]
  onBegin: () => void
  onChange: (points: CurvePoints) => void
  onEnd: () => void
  testId?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function path(points: CurvePoints): string {
  const c = monotoneCurve(
    points.map((p) => p[0]),
    points.map((p) => p[1]),
  )
  const n = 96
  return Array.from({ length: n + 1 }, (_, i) => {
    const x = i / n
    const y = clamp(evalCurve(c, x), 0, 1)
    return `${i ? 'L' : 'M'} ${(x * SIZE).toFixed(1)} ${((1 - y) * SIZE).toFixed(1)}`
  }).join(' ')
}

/** 曲线编辑器：点击空白处添加控制点并拖动，拖动控制点调整，双击或拖出方框删除（首尾两点只能上下移动）。 */
export function CurveEditor({ points, color, others, onBegin, onChange, onEnd, testId }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: number; index: number } | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)

  const toCurve = (e: ReactPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height }
  }

  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const p = toCurve(e)
    let index = points.findIndex((q) => Math.hypot(q[0] - p.x, q[1] - p.y) < PICK)
    let next = points
    if (index < 0) {
      // 离已有控制点太近时拖动那个点，否则在该处插入新点
      const near = points.findIndex((q) => Math.abs(q[0] - p.x) < MIN_GAP)
      if (near >= 0) index = near
      else {
        index = points.findIndex((q) => q[0] > p.x)
        next = [...points.slice(0, index), [p.x, clamp(p.y, 0, 1)], ...points.slice(index)]
      }
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    dragRef.current = { id: e.pointerId, index }
    onBegin()
    if (next !== points) onChange(next)
  }

  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    const p = toCurve(e)
    const last = points.length - 1
    const i = d.index
    const x = i === 0 ? 0 : i === last ? 1 : clamp(p.x, points[i - 1][0] + MIN_GAP, points[i + 1][0] - MIN_GAP)
    const out = i !== 0 && i !== last && (p.y < -REMOVE_DISTANCE || p.y > 1 + REMOVE_DISTANCE)
    setRemoving(out ? i : null)
    onChange(points.map((q, k) => (k === i ? [x, clamp(p.y, 0, 1)] : q)))
  }

  const end = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    dragRef.current = null
    if (removing !== null) onChange(points.filter((_, k) => k !== removing))
    setRemoving(null)
    onEnd()
  }

  const remove = (i: number) => {
    if (i === 0 || i === points.length - 1) return
    onBegin()
    onChange(points.filter((_, k) => k !== i))
    onEnd()
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="aspect-square w-full touch-none overflow-visible rounded-lg bg-black/30"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      data-testid={testId}
    >
      {[0.25, 0.5, 0.75].map((v) => (
        <g key={v} stroke="rgba(255,255,255,0.08)">
          <line x1={v * SIZE} y1={0} x2={v * SIZE} y2={SIZE} />
          <line x1={0} y1={v * SIZE} x2={SIZE} y2={v * SIZE} />
        </g>
      ))}
      <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
      {others.map((o, i) => (
        <path key={i} d={path(o.points)} fill="none" stroke={o.color} strokeOpacity={0.35} strokeWidth={1.5} />
      ))}
      <path d={path(points)} fill="none" stroke={color} strokeWidth={2} />
      {points.map(([x, y], i) => (
        <circle
          key={i}
          cx={x * SIZE}
          cy={(1 - y) * SIZE}
          r={6}
          fill={removing === i ? 'transparent' : color}
          stroke="rgba(0,0,0,0.7)"
          strokeWidth={2}
          onDoubleClick={() => remove(i)}
          data-testid={`curve-point-${i}`}
        />
      ))}
    </svg>
  )
}
