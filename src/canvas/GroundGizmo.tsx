import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, docToLayerUV, docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import { characterGround } from '@/fusion/placement'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'

/** 接地点标记的半宽（屏幕像素） */
const HALF = 14

/** 立绘与景深步骤的接地点控件：拖动设置立绘脚下（或水线处）的接地点，双击恢复自动。 */
export function GroundGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const bbox = useFusion((s) => (s.character && s.character.id === doc.character?.id ? s.character.info.bbox : undefined))
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: number; offset: Point } | null>(null)

  const { background, character } = doc
  if (!background || !character || (step !== 'character' && step !== 'focus')) return null

  const at = docToScreen(view, characterGround(doc, background, bbox))
  const manual = doc.fusion.ground !== null

  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    // 记录按下处与接地点的偏移，拖动开始时标记不跳动
    const p = toDoc(e)
    const g = characterGround(doc, background, bbox)
    dragRef.current = { id: e.pointerId, offset: { x: g.x - p.x, y: g.y - p.y } }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    const s = useApp.getState()
    const ch = s.doc.character
    if (d?.id !== e.pointerId || !ch) return
    const p = toDoc(e)
    const uv = docToLayerUV(s.doc.charTransform, ch, { x: p.x + d.offset.x, y: p.y + d.offset.y })
    s.setCharGround({ u: clamp(uv.x, 0, 1), v: clamp(uv.y, 0, 1) })
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="ground-gizmo">
      <g
        transform={`translate(${at.x} ${at.y})`}
        style={{ pointerEvents: passThrough ? 'none' : 'auto', cursor: 'move' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => useApp.getState().setCharGround(null)}
        data-testid="ground-handle"
        data-manual={manual}
      >
        {/* 较大的透明区域便于拾取 */}
        <rect x={-HALF - 4} y={-10} width={2 * HALF + 8} height={20} fill="transparent" />
        <line x1={-HALF} y1={0} x2={HALF} y2={0} stroke="rgba(0,0,0,0.6)" strokeWidth={4} strokeLinecap="round" />
        <line x1={-HALF} y1={0} x2={HALF} y2={0} stroke="white" strokeWidth={2} strokeLinecap="round" strokeDasharray={manual ? undefined : '4 3'} />
        <path d="M 0 -1 L -5 -8 L 5 -8 Z" fill="white" stroke="rgba(0,0,0,0.6)" strokeWidth={1} />
      </g>
    </svg>
  )
}
