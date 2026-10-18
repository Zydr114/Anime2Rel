import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, docToLayerUV, docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import type { FocusTarget } from '@/focus/model'
import { focusPoint } from '@/focus/params'
import { pickAlpha } from '@/lighting/sampling'
import { useFusion } from '@/state/fusion'
import { useApp, type DocState } from '@/state/store'

/** 对焦框半边长（屏幕像素） */
const BOX = 18
/** 对焦框四角线段长度 */
const CORNER = 7
/** 立绘 alpha 超过此值时点击视为点在立绘上 */
const HIT_ALPHA = 0.5

/** 文档坐标处的对焦目标：点在立绘不透明处时对焦到立绘的该处，否则对焦到背景 */
function targetAt(doc: DocState, p: Point): FocusTarget | null {
  const bg = doc.background
  if (!bg) return null
  const ch = doc.character
  if (ch) {
    const uv = docToLayerUV(doc.charTransform, ch, p)
    if (pickAlpha(ch.id, uv) > HIT_ALPHA) return { kind: 'character', u: uv.x, v: uv.y }
  }
  return { kind: 'background', x: clamp(p.x, 0, bg.width), y: clamp(p.y, 0, bg.height) }
}

/** 景深步骤的画布控件：在文档上点击或拖动选择对焦点，并标出当前焦点。 */
export function FocusGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const info = useFusion((s) => (s.character && s.character.id === doc.character?.id ? s.character.info : undefined))
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<number | null>(null)

  const background = doc.background
  if (!background || step !== 'focus') return null

  const setTarget = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const s = useApp.getState()
    const target = targetAt(s.doc, screenToDoc(s.view, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
    if (target) s.setFocus({ target })
  }

  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    dragRef.current = e.pointerId
    setTarget(e)
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current === e.pointerId) setTarget(e)
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  const tl = docToScreen(view, { x: 0, y: 0 })
  const br = docToScreen(view, { x: background.width, y: background.height })
  const point = focusPoint(doc, info)
  const at = point && docToScreen(view, point)
  const auto = !doc.focus.target

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="focus-gizmo">
      <rect
        x={tl.x}
        y={tl.y}
        width={Math.max(0, br.x - tl.x)}
        height={Math.max(0, br.y - tl.y)}
        fill="transparent"
        style={{ pointerEvents: passThrough ? 'none' : 'auto', cursor: 'crosshair' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        data-testid="focus-overlay"
      />
      {at && (
        <g transform={`translate(${at.x} ${at.y})`} data-testid="focus-marker" data-kind={doc.focus.target?.kind ?? 'auto'}>
          {[1, -1].map((sx) =>
            [1, -1].map((sy) => {
              const d = `M ${sx * BOX} ${sy * (BOX - CORNER)} L ${sx * BOX} ${sy * BOX} L ${sx * (BOX - CORNER)} ${sy * BOX}`
              return (
                <g key={`${sx}${sy}`}>
                  <path d={d} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} strokeLinecap="round" />
                  <path d={d} fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" />
                </g>
              )
            }),
          )}
          <circle r={2.5} fill="white" stroke="rgba(0,0,0,0.6)" strokeWidth={1} opacity={auto ? 0.6 : 1} />
        </g>
      )}
    </svg>
  )
}
