import { useId, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, docToScreen, screenToDoc, type Point, type Size, type ViewTransform } from '@/algo/geometry'
import { groundGrid, groundPoint, horizonLine, orientationFromHorizon, solveLines } from '@/camera/geometry'
import type { CameraDoc, CameraLines } from '@/camera/model'
import { characterGround } from '@/fusion/placement'
import { useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'

/** 地平线的颜色 */
const HORIZON = 'rgb(252, 211, 77)'
/** 两组平行线的颜色 */
const PAIR_COLORS = { first: 'rgb(251, 146, 60)', second: 'rgb(96, 165, 250)' } as const
const PAIRS = ['first', 'second'] as const
type Pair = (typeof PAIRS)[number]
/** 地平线两端控制点的位置（画面宽度的比例） */
const HANDLE_X = [0.15, 0.85] as const
const HANDLE_R = 7

type Drag =
  | { id: number; kind: 'horizon'; which: 0 | 1 | 'both'; handles: [Point, Point]; startY: number }
  | { id: number; kind: 'line'; pair: Pair; segment: 0 | 1; end: 0 | 1; offset: Point }

/** 地平线上横坐标为 x 的点（文档坐标） */
function horizonAt(c: CameraDoc, size: Size, x: number): Point {
  const h = horizonLine(c, size)
  return { x, y: h.point.y + (h.dir.y * (x - h.point.x)) / h.dir.x }
}

/** 网格的中心：画面下部的中央；那里不在地面上时取地平线以下的一点 */
function gridAnchor(c: CameraDoc, size: Size): Point {
  const p = { x: size.width / 2, y: size.height * 0.8 }
  if (groundPoint(c, size, p)) return p
  const h = horizonLine(c, size)
  return { x: h.point.x + h.normal.x * 0.25 * size.height, y: h.point.y + h.normal.y * 0.25 * size.height }
}

/** 穿过 a、b 的长直线（屏幕坐标），用于画地平线和平行线的延长线 */
function extend(a: Point, b: Point, length: number): [Point, Point] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const d = { x: ((b.x - a.x) / len) * length, y: ((b.y - a.y) / len) * length }
  return [
    { x: a.x - d.x, y: a.y - d.y },
    { x: b.x + d.x, y: b.y + d.y },
  ]
}

/** 地面网格：间距 1 m，向地平线方向逐渐淡出，只画在画面范围内 */
export function GroundGrid({ camera, size, view, anchor }: { camera: CameraDoc; size: Size; view: ViewTransform; anchor?: Point }) {
  const id = useId()
  const tl = docToScreen(view, { x: 0, y: 0 })
  const br = docToScreen(view, { x: size.width, y: size.height })
  const lines = groundGrid(camera, size, anchor ?? gridAnchor(camera, size))
  const h = horizonLine(camera, size)
  const from = docToScreen(view, h.point)
  const fade = 0.4 * size.height * view.zoom
  const to = { x: from.x + h.normal.x * fade, y: from.y + h.normal.y * fade }
  const toScreen = (p: Point) => docToScreen(view, p)
  return (
    <g data-testid="camera-grid" clipPath={`url(#${id}-clip)`}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect x={tl.x} y={tl.y} width={br.x - tl.x} height={br.y - tl.y} />
        </clipPath>
        <linearGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="1" stopColor="white" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id={`${id}-shade`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
          <stop offset="0" stopColor="black" stopOpacity="0" />
          <stop offset="1" stopColor="black" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {(['shade', 'fade'] as const).map((layer) => (
        <g key={layer} stroke={`url(#${id}-${layer})`} strokeWidth={layer === 'shade' ? 2.5 : 1}>
          {lines.map((l, i) => {
            const a = toScreen(l.a)
            const b = toScreen(l.b)
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          })}
        </g>
      ))}
    </g>
  )
}

/** 立绘步骤可选的地面网格：以接地点为中心（接地点不在地面上时取默认位置），并画出地平线 */
export function CharacterGrid() {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const showGrid = useFusion((s) => s.showGrid)
  const info = useCharacterInfo(doc)
  const bg = doc.background
  if (!bg || step !== 'character' || !showGrid) return null
  const foot = doc.character ? characterGround(doc, bg, info?.bbox) : null
  const anchor = foot && groundPoint(doc.camera, bg, foot) ? foot : undefined
  const handles = HANDLE_X.map((k) => docToScreen(view, horizonAt(doc.camera, bg, k * bg.width)))
  const [h0, h1] = extend(handles[0], handles[1], 3 * Math.max(bg.width, bg.height) * view.zoom)
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="character-grid">
      <GroundGrid camera={doc.camera} size={bg} view={view} anchor={anchor} />
      <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke={HORIZON} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="8 6" />
    </svg>
  )
}

/**
 * 相机步骤的画布控件：地平线方式拖动地平线（两端的圆点改变高度和倾斜，线本身上下平移），
 * 平行线方式拖动两组线的端点并实时求解；两种方式都叠加地面网格。
 */
export function CameraGizmo({ passThrough }: { passThrough: boolean }) {
  const background = useApp((s) => s.doc.background)
  const camera = useApp((s) => s.doc.camera)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)

  if (!background || step !== 'camera') return null

  const toScreen = (p: Point) => docToScreen(view, p)
  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const interactive = passThrough ? 'none' : 'auto'
  const reach = 3 * Math.max(background.width, background.height) * view.zoom

  const begin = (e: ReactPointerEvent<SVGElement>, drag: Drag) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    dragRef.current = drag
  }

  const beginHorizon = (e: ReactPointerEvent<SVGElement>, which: 0 | 1 | 'both') => {
    const handles = HANDLE_X.map((k) => horizonAt(camera, background, k * background.width)) as [Point, Point]
    begin(e, { id: e.pointerId, kind: 'horizon', which, handles, startY: toDoc(e).y })
  }

  const beginLine = (e: ReactPointerEvent<SVGElement>, pair: Pair, segment: 0 | 1, end: 0 | 1, at: Point) => {
    const p = toDoc(e)
    begin(e, { id: e.pointerId, kind: 'line', pair, segment, end, offset: { x: at.x - p.x, y: at.y - p.y } })
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    const s = useApp.getState()
    const { background: bg, camera: c } = s.doc
    if (!bg) return
    const p = toDoc(e)
    if (d.kind === 'horizon') {
      // 控制点只上下移动；拖动线本身时两端一起移动
      const dy = p.y - d.startY
      const [a, b] = d.handles.map((h, i) => (d.which === 'both' || d.which === i ? { x: h.x, y: h.y + dy } : h))
      s.updateCamera(orientationFromHorizon(a, b, bg, c))
      return
    }
    if (!c.lines) return
    const q = { x: clamp((p.x + d.offset.x) / bg.width, -1, 2), y: clamp((p.y + d.offset.y) / bg.height, -1, 2) }
    const pair = c.lines[d.pair].map((seg, i) => (i === d.segment ? seg.map((v, j) => (j === d.end ? q : v)) : seg)) as CameraLines[Pair]
    const lines = { ...c.lines, [d.pair]: pair }
    // 不能求解时只更新线段，保持上一个可用的结果
    const solved = solveLines(lines, bg)
    s.updateCamera({ lines, ...(solved.ok ? solved.camera : {}) })
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end }
  const handles = HANDLE_X.map((k) => toScreen(horizonAt(camera, background, k * background.width)))
  const [h0, h1] = extend(handles[0], handles[1], reach)
  const lineMode = camera.method === 'lines' && camera.lines

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="camera-gizmo">
      <GroundGrid camera={camera} size={background} view={view} />
      <g data-testid="horizon">
        <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke="rgba(0,0,0,0.5)" strokeWidth={3} />
        <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke={HORIZON} strokeWidth={1.5} strokeDasharray={lineMode ? '8 6' : undefined} />
        {!lineMode && (
          <>
            {/* 较宽的透明线便于拾取 */}
            <line
              x1={h0.x}
              y1={h0.y}
              x2={h1.x}
              y2={h1.y}
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: interactive, cursor: 'ns-resize' }}
              onPointerDown={(e) => beginHorizon(e, 'both')}
              {...handlers}
              data-testid="horizon-line"
            />
            {handles.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={HANDLE_R}
                fill={HORIZON}
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={1.5}
                style={{ pointerEvents: interactive, cursor: 'ns-resize' }}
                onPointerDown={(e) => beginHorizon(e, i as 0 | 1)}
                {...handlers}
                data-testid={`horizon-handle-${i}`}
              />
            ))}
          </>
        )}
      </g>
      {lineMode &&
        PAIRS.map((pair) =>
          lineMode[pair].map((seg, i) => {
            const [a, b] = seg.map((v) => ({ x: v.x * background.width, y: v.y * background.height }))
            const [sa, sb] = [toScreen(a), toScreen(b)]
            const [e0, e1] = extend(sa, sb, reach)
            const color = PAIR_COLORS[pair]
            return (
              <g key={`${pair}-${i}`} data-testid={`camera-line-${pair}-${i}`}>
                <line x1={e0.x} y1={e0.y} x2={e1.x} y2={e1.y} stroke={color} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="4 6" />
                <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="rgba(0,0,0,0.5)" strokeWidth={4} />
                <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={color} strokeWidth={2} />
                {[a, b].map((p, j) => {
                  const sp = toScreen(p)
                  return (
                    <circle
                      key={j}
                      cx={sp.x}
                      cy={sp.y}
                      r={HANDLE_R}
                      fill={color}
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth={1.5}
                      style={{ pointerEvents: interactive, cursor: 'move' }}
                      onPointerDown={(e) => beginLine(e, pair, i as 0 | 1, j as 0 | 1, p)}
                      {...handlers}
                      data-testid={`camera-handle-${pair}-${i}-${j}`}
                    />
                  )
                })}
              </g>
            )
          }),
        )}
    </svg>
  )
}
