import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import { horizonLine } from '@/camera/geometry'
import { waterActive } from '@/focus/model'
import { characterBox, characterGround, characterUV } from '@/fusion/placement'
import { useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { useView3dShown } from '@/state/view3d'

/** 接地点标记的半宽（屏幕像素） */
const HALF = 14

/** 水线的颜色 */
const WATER = 'rgb(125, 211, 252)'

/**
 * 立绘与景深步骤的接地点控件：拖动设置立绘脚下（或水线处）的接地点，双击恢复自动。水体遮挡开启时同时画出整条水线。立绘变形时只显示不响应。
 * 标记和水线都与标定的地平线平行。
 */
export function GroundGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const view3d = useView3dShown()
  const warping = useFusion((s) => s.tool !== 'transform') && step === 'character'
  const bbox = useCharacterInfo(doc)?.bbox
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: number; offset: Point } | null>(null)

  const { background, character } = doc
  if (!background || !character || (step !== 'character' && step !== 'focus') || view3d) return null

  const ground = characterGround(doc, background, bbox)
  const at = docToScreen(view, ground)
  const manual = doc.fusion.ground !== null
  const { dir } = horizonLine(doc.camera, background)
  const angle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI
  // 水线沿地平线方向横跨立绘不透明区域，两端各多出一点
  const ts = characterBox(doc, bbox).map((p) => {
    const q = docToScreen(view, p)
    return (q.x - at.x) * dir.x + (q.y - at.y) * dir.y
  })
  const along = (t: number) => ({ x: at.x + dir.x * t, y: at.y + dir.y * t })
  const water = waterActive(doc.focus) && { a: along(Math.min(...ts) - HALF), b: along(Math.max(...ts) + HALF) }

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
    // 接地点记录在原立绘的坐标中，拖到变形后的立绘之外时取外框上最近的点
    const { point } = characterUV(s.doc, { x: p.x + d.offset.x, y: p.y + d.offset.y })
    s.setCharGround({ u: clamp(point.x, 0, 1), v: clamp(point.y, 0, 1) })
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="ground-gizmo">
      {water && (
        <g data-testid="waterline">
          <line x1={water.a.x} y1={water.a.y} x2={water.b.x} y2={water.b.y} stroke="rgba(0,0,0,0.5)" strokeWidth={3} />
          <line x1={water.a.x} y1={water.a.y} x2={water.b.x} y2={water.b.y} stroke={WATER} strokeWidth={1.5} strokeDasharray="6 4" />
        </g>
      )}
      <g
        transform={`translate(${at.x} ${at.y}) rotate(${angle})`}
        style={{ pointerEvents: passThrough || warping ? 'none' : 'auto', cursor: 'move' }}
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
