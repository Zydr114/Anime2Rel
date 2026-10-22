import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { docToScreen, screenToDoc, type Point, type Size } from '@/algo/geometry'
import type { BrushStroke } from '@/focus/model'
import type { BrushTool } from '@/state/regions'
import { useApp } from '@/state/store'

/**
 * 在文档上涂抹的画笔（遮挡区域、局部调整的画笔蒙版共用）：按下到抬起为一笔，交给 onStroke（一笔一次撤销）；
 * 下面叠加一张着色后的覆盖度图，覆盖整个文档。
 */
export function StrokeBrush(props: {
  passThrough: boolean
  doc: Size
  /** 画笔直径（屏幕像素） */
  size: number
  tool: BrushTool
  /** 笔画预览的颜色 */
  color: string
  /** 着色后的覆盖度，null 为不显示 */
  overlay: ImageData | null
  onStroke: (stroke: BrushStroke) => void
  /** 测试 id 的前缀：<prefix>-overlay、<prefix>-brush、<prefix>-canvas */
  testId: string
}) {
  const { passThrough, doc, size, tool, overlay, testId } = props
  const view = useApp((s) => s.view)
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokeRef = useRef<{ id: number; points: number[] } | null>(null)
  const [stroke, setStroke] = useState<number[] | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !overlay) return
    canvas.width = overlay.width
    canvas.height = overlay.height
    canvas.getContext('2d')?.putImageData(overlay, 0, 0)
  }, [overlay])

  const radius = size / 2 / view.zoom
  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const p = toDoc(e)
    strokeRef.current = { id: e.pointerId, points: [p.x, p.y] }
    setStroke([p.x, p.y])
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const p = toDoc(e)
    setCursor(p)
    const s = strokeRef.current
    if (s?.id !== e.pointerId) return
    // 间距小于半径的 1/4 时不加点，笔画不会因为指针事件密集而过长
    const n = s.points.length
    if (Math.hypot(p.x - s.points[n - 2], p.y - s.points[n - 1]) < radius / 4) return
    s.points.push(p.x, p.y)
    setStroke([...s.points])
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    const s = strokeRef.current
    if (s?.id !== e.pointerId) return
    strokeRef.current = null
    setStroke(null)
    props.onStroke({ erase: tool === 'eraser', radius, points: s.points })
  }

  const tl = docToScreen(view, { x: 0, y: 0 })
  const br = docToScreen(view, { x: doc.width, y: doc.height })
  const path = stroke && stroke.map((v, i) => (i % 2 === 0 ? `${i ? 'L' : 'M'} ${view.panX + v * view.zoom}` : `${view.panY + v * view.zoom}`)).join(' ')
  const color = tool === 'eraser' ? 'rgba(255, 255, 255, 0.5)' : props.color
  const at = cursor && docToScreen(view, cursor)

  return (
    <>
      {overlay && (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute"
          style={{ left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y }}
          data-testid={`${testId}-overlay`}
        />
      )}
      <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid={`${testId}-brush`}>
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
          data-testid={`${testId}-canvas`}
        />
        {path && <path d={path} fill="none" stroke={color} strokeWidth={size} strokeLinecap="round" strokeLinejoin="round" />}
        {path && stroke.length === 2 && <circle cx={view.panX + stroke[0] * view.zoom} cy={view.panY + stroke[1] * view.zoom} r={size / 2} fill={color} />}
        {at && !passThrough && (
          <g>
            <circle cx={at.x} cy={at.y} r={size / 2} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
            <circle cx={at.x} cy={at.y} r={size / 2} fill="none" stroke="white" strokeWidth={1.5} strokeDasharray={tool === 'eraser' ? '4 3' : undefined} />
          </g>
        )}
      </svg>
    </>
  )
}
