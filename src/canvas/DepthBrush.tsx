import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import { characterUV } from '@/fusion/placement'
import { t } from '@/i18n'
import { beginDepthStroke, endDepthStroke, extendDepthStroke, strokeRadius, useDepthBrush } from '@/state/depthEdit'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { useView3d } from '@/state/view3d'
import { notify } from '@/app/notify'

/** 立绘步骤的深度画笔（二维）：在立绘上涂抹修正深度，一笔一次撤销。画面上的伪彩色由引擎叠加 */
export function DepthBrush({ passThrough }: { passThrough: boolean }) {
  const step = useApp((s) => s.step)
  const view = useApp((s) => s.view)
  const background = useApp((s) => s.doc.background)
  const hasCharacter = useApp((s) => !!s.doc.character)
  const active = useFusion((s) => s.tool === 'depth')
  const open3d = useView3d((s) => s.open)
  const size = useDepthBrush((s) => s.size)
  const svgRef = useRef<SVGSVGElement>(null)
  const strokeRef = useRef<{ id: number; last: Point } | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)

  if (!background || !hasCharacter || step !== 'character' || !active || open3d) return null

  const toScreen = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const uvAt = (screen: Point) => characterUV(useApp.getState().doc, screenToDoc(useApp.getState().view, screen)).point

  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const screen = toScreen(e)
    const { doc, view } = useApp.getState()
    const p = screenToDoc(view, screen)
    if (!beginDepthStroke(characterUV(doc, p).point, strokeRadius(doc, p, size / 2 / view.zoom))) {
      notify(t.depthEdit.notReady)
      return
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    strokeRef.current = { id: e.pointerId, last: screen }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const screen = toScreen(e)
    setCursor(screenToDoc(useApp.getState().view, screen))
    const s = strokeRef.current
    if (s?.id !== e.pointerId) return
    // 屏幕上移动不到画笔直径的 1/8 时不加点
    if (Math.hypot(screen.x - s.last.x, screen.y - s.last.y) < size / 8) return
    s.last = screen
    extendDepthStroke(uvAt(screen))
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (strokeRef.current?.id !== e.pointerId) return
    strokeRef.current = null
    endDepthStroke()
  }

  const tl = docToScreen(view, { x: 0, y: 0 })
  const br = docToScreen(view, { x: background.width, y: background.height })
  const at = cursor && docToScreen(view, cursor)

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="depth-brush">
      <rect
        x={tl.x}
        y={tl.y}
        width={Math.max(0, br.x - tl.x)}
        height={Math.max(0, br.y - tl.y)}
        fill="transparent"
        style={{ pointerEvents: passThrough ? 'none' : 'auto', cursor: 'none' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => setCursor(null)}
        data-testid="depth-brush-canvas"
      />
      {at && !passThrough && (
        <g>
          <circle cx={at.x} cy={at.y} r={size / 2} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
          <circle cx={at.x} cy={at.y} r={size / 2} fill="none" stroke="white" strokeWidth={1.5} />
        </g>
      )}
    </svg>
  )
}
