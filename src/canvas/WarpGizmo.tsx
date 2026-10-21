import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { docToLayerUV, docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import { characterOutline, layerUVToDoc } from '@/fusion/placement'
import { gridPoints, moveCorner, moveGridPoint, resetCorner, resetGridPoint, UNIT_CORNERS, warpPoint, type CharWarp } from '@/fusion/warp'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { useView3dShown } from '@/state/view3d'

const HANDLE = 6
/** 网格线在相邻两个控制点之间的采样数 */
const LINE_STEPS = 12

/** 网格变形的内部网格线（原立绘 UV），外框由轮廓画出 */
function gridLines(n: number): Point[][] {
  const steps = (n - 1) * LINE_STEPS
  const lines: Point[][] = []
  for (let k = 1; k < n - 1; k++) {
    const t = k / (n - 1)
    lines.push(Array.from({ length: steps + 1 }, (_, s) => ({ x: s / steps, y: t })))
    lines.push(Array.from({ length: steps + 1 }, (_, s) => ({ x: t, y: s / steps })))
  }
  return lines
}

const pointsAttr = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(' ')

/**
 * 立绘变形控件（摆放步骤选用变形工具时）：四角透视拖动变形后立绘的四个角，网格变形拖动各控制点。双击控制点复位。
 * 拖动得到不可用的变形（四角交叉、越过地平线、超出范围）时保持上一个可用的状态。
 */
export function WarpGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const tool = useFusion((s) => s.tool)
  const view3d = useView3dShown()
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: number; index: number; offset: Point } | null>(null)

  const { character, charWarp: warp } = doc
  if (!character || step !== 'place' || (tool !== 'perspective' && tool !== 'mesh') || view3d) return null

  const perspective = tool === 'perspective'
  const screen = (uv: Point) => docToScreen(view, layerUVToDoc(doc, uv))
  const nodes = perspective ? UNIT_CORNERS : gridPoints(warp.grid)
  // 控制点在变形后的位置（立绘 UV）
  const handles = nodes.map((p) => warpPoint(warp, p))
  const outline = pointsAttr(characterOutline(doc).map((p) => docToScreen(view, p)))
  const lines = perspective ? [] : gridLines(warp.grid).map((l) => pointsAttr(l.map((p) => screen(warpPoint(warp, p)))))

  const toLayer = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const s = useApp.getState()
    return docToLayerUV(s.doc.charTransform, character, screenToDoc(s.view, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
  }

  const edit = (w: CharWarp, index: number, target: Point) => (perspective ? moveCorner(w, index, target) : moveGridPoint(w, index, target))

  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    const index = Number((e.currentTarget as SVGElement).dataset.index)
    // 记录按下处与控制点的偏移，拖动开始时控制点不跳动
    const p = toLayer(e)
    const h = handles[index]
    dragRef.current = { id: e.pointerId, index, offset: { x: h.x - p.x, y: h.y - p.y } }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    const p = toLayer(e)
    const s = useApp.getState()
    const next = edit(s.doc.charWarp, d.index, { x: p.x + d.offset.x, y: p.y + d.offset.y })
    if (next) s.setCharWarp(next)
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  const reset = (index: number) => {
    const s = useApp.getState()
    const next = (perspective ? resetCorner : resetGridPoint)(s.doc.charWarp, index)
    if (next) s.setCharWarp(next)
  }

  const interactive = passThrough ? 'none' : 'auto'

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="warp-gizmo" data-tool={tool}>
      {lines.map((l, i) => (
        <g key={i}>
          <polyline points={l} fill="none" stroke="black" strokeOpacity={0.35} strokeWidth={2.5} />
          <polyline points={l} fill="none" stroke="white" strokeOpacity={0.7} strokeWidth={1} />
        </g>
      ))}
      <polygon points={outline} fill="none" stroke="black" strokeOpacity={0.5} strokeWidth={3} />
      <polygon points={outline} fill="none" stroke="white" strokeWidth={1} strokeDasharray="6 4" />
      {handles.map((uv, i) => {
        const c = screen(uv)
        const props = {
          style: { pointerEvents: interactive, cursor: 'move' },
          'data-index': i,
          'data-testid': `warp-handle-${i}`,
          onPointerDown: down,
          onPointerMove: move,
          onPointerUp: end,
          onPointerCancel: end,
          onDoubleClick: () => reset(i),
        } as const
        return perspective ? (
          <rect key={i} x={c.x - HANDLE} y={c.y - HANDLE} width={2 * HANDLE} height={2 * HANDLE} fill="white" stroke="black" strokeOpacity={0.6} {...props} />
        ) : (
          <circle key={i} cx={c.x} cy={c.y} r={HANDLE - 1} fill="white" stroke="black" strokeOpacity={0.6} {...props} />
        )
      })}
    </svg>
  )
}
