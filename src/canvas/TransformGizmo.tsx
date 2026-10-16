import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { docToScreen, layerCorners, screenToDoc, type LayerTransform, type Point } from '@/algo/geometry'
import { useApp } from '@/state/store'

const HANDLE_RADIUS = 6
const ROTATE_OFFSET = 32
const ROTATE_SNAP = Math.PI / 12
const MIN_SCALE = 0.005

type Mode = 'move' | 'scale' | 'rotate'

interface Drag {
  id: number
  mode: Mode
  start: Point // 文档坐标
  t0: LayerTransform
}

const angleOf = (p: Point, c: Point) => Math.atan2(p.y - c.y, p.x - c.x)

/** 立绘变换控件：拖动主体移动，四角等比缩放，上方圆点旋转。 */
export function TransformGizmo({ passThrough }: { passThrough: boolean }) {
  const character = useApp((s) => s.doc.character)
  const transform = useApp((s) => s.doc.charTransform)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)

  if (!character || (step !== 'assets' && step !== 'character')) return null

  const corners = layerCorners(transform, character).map((p) => docToScreen(view, p))
  const center = docToScreen(view, transform)
  const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 }
  // 旋转手柄沿立绘“上方”方向偏移固定的屏幕距离
  const up = { x: topMid.x - center.x, y: topMid.y - center.y }
  const upLen = Math.hypot(up.x, up.y) || 1
  const rotateHandle = { x: topMid.x + (up.x / upLen) * ROTATE_OFFSET, y: topMid.y + (up.y / upLen) * ROTATE_OFFSET }

  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const begin = (e: ReactPointerEvent<SVGElement>) => {
    const mode = (e.currentTarget as SVGElement).dataset.mode as Mode | undefined
    if (e.button !== 0 || !mode) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const s = useApp.getState()
    s.beginGesture()
    dragRef.current = { id: e.pointerId, mode, start: toDoc(e), t0: s.doc.charTransform }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const p = toDoc(e)
    const { t0 } = d
    const s = useApp.getState()
    if (d.mode === 'move') {
      s.setCharTransform({ x: t0.x + p.x - d.start.x, y: t0.y + p.y - d.start.y })
    } else if (d.mode === 'scale') {
      const r0 = Math.hypot(d.start.x - t0.x, d.start.y - t0.y) || 1
      const r1 = Math.hypot(p.x - t0.x, p.y - t0.y)
      s.setCharTransform({ scale: Math.max(MIN_SCALE, (t0.scale * r1) / r0) })
    } else {
      let rotation = t0.rotation + angleOf(p, t0) - angleOf(d.start, t0)
      rotation = Math.atan2(Math.sin(rotation), Math.cos(rotation))
      if (e.shiftKey) rotation = Math.round(rotation / ROTATE_SNAP) * ROTATE_SNAP
      s.setCharTransform({ rotation })
    }
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  const handlers = { onPointerDown: begin, onPointerMove: move, onPointerUp: end, onPointerCancel: end }
  const points = corners.map((p) => `${p.x},${p.y}`).join(' ')
  const interactive = passThrough ? 'none' : 'auto'

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="gizmo">
      <polygon points={points} fill="transparent" style={{ pointerEvents: interactive, cursor: 'move' }} data-mode="move" {...handlers} data-testid="gizmo-body" />
      <polygon points={points} fill="none" stroke="black" strokeOpacity={0.5} strokeWidth={3} />
      <polygon points={points} fill="none" stroke="white" strokeWidth={1} strokeDasharray="6 4" />
      <line x1={topMid.x} y1={topMid.y} x2={rotateHandle.x} y2={rotateHandle.y} stroke="white" strokeWidth={1} />
      {corners.map((c, i) => (
        <circle
          key={i}
          cx={c.x}
          cy={c.y}
          r={HANDLE_RADIUS}
          fill="white"
          stroke="black"
          strokeOpacity={0.6}
          style={{ pointerEvents: interactive, cursor: i % 2 === 0 ? 'nwse-resize' : 'nesw-resize' }}
          data-testid={`gizmo-scale-${i}`}
          data-mode="scale"
          {...handlers}
        />
      ))}
      <circle
        cx={rotateHandle.x}
        cy={rotateHandle.y}
        r={HANDLE_RADIUS}
        fill="rgb(var(--mdui-color-primary))"
        stroke="white"
        style={{ pointerEvents: interactive, cursor: 'grab' }}
        data-testid="gizmo-rotate"
        data-mode="rotate"
        {...handlers}
      />
    </svg>
  )
}
