import { useRef, useState, type PointerEvent as ReactPointerEvent, type SVGProps } from 'react'
import { clamp, docToScreen, screenToDoc, type Point, type Size } from '@/algo/geometry'
import { groundPoint, horizonLine, orientationFromHorizon, solveLines } from '@/camera/geometry'
import { AXIS_COLORS, dragOrigin, grabHeight, yawToward } from '@/camera/guides'
import type { CameraDoc, CameraLines } from '@/camera/model'
import { characterGround } from '@/fusion/placement'
import { guideOrigin, useCameraGuide } from '@/state/cameraGuide'
import { useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { GuideLayer, type GuideTarget } from './CameraGuide'
import { Loupe, type LoupeFocus } from './Loupe'

/** 地平线的颜色 */
const HORIZON = 'rgb(252, 211, 77)'
const PAIRS = ['first', 'second'] as const
/** 平行线按所沿的轴取色：第一组沿红轴，第二组沿蓝轴或竖直的绿轴 */
const pairColor = (pair: Pair, lines: CameraLines) => (pair === 'first' ? AXIS_COLORS.x : lines.secondAxis === 'vertical' ? AXIS_COLORS.y : AXIS_COLORS.z)
type Pair = (typeof PAIRS)[number]
/** 旋转参考形状时按住 Shift 的步进 */
const SNAP = Math.PI / 12
/** 地平线两端控制点的位置（画面宽度的比例） */
const HANDLE_X = [0.15, 0.85] as const
const HANDLE_R = 7
/** 相机步骤中暗化照片的程度 */
const DIM = 0.45

/** 空心的准星控制点：圆环加中心的小点，不挡住要对准的位置 */
function Crosshair({ at, color, ...rest }: { at: Point; color: string } & SVGProps<SVGCircleElement>) {
  return (
    <>
      <circle cx={at.x} cy={at.y} r={HANDLE_R} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} pointerEvents="none" />
      <circle cx={at.x} cy={at.y} r={HANDLE_R} fill="none" stroke={color} strokeWidth={2} pointerEvents="none" />
      <circle cx={at.x} cy={at.y} r={1.5} fill={color} pointerEvents="none" />
      {/* 拾取区域比圆环略大 */}
      <circle cx={at.x} cy={at.y} r={HANDLE_R + 3} fill="transparent" {...rest} />
    </>
  )
}

type Drag =
  | { id: number; kind: 'horizon'; which: 0 | 1 | 'both'; handles: [Point, Point]; startY: number }
  | { id: number; kind: 'line'; pair: Pair; segment: 0 | 1; end: 0 | 1; offset: Point }
  | { id: number; kind: 'guide'; origin: Point; height: number; start: Point }
  | { id: number; kind: 'rotate'; axis: 'x' | 'z'; origin: Point }

/** 地平线上横坐标为 x 的点（文档坐标） */
function horizonAt(c: CameraDoc, size: Size, x: number): Point {
  const h = horizonLine(c, size)
  return { x, y: h.point.y + (h.dir.y * (x - h.point.x)) / h.dir.x }
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
  const origin = foot && groundPoint(doc.camera, bg, foot) ? foot : guideOrigin(doc, null)!
  const handles = HANDLE_X.map((k) => docToScreen(view, horizonAt(doc.camera, bg, k * bg.width)))
  const [h0, h1] = extend(handles[0], handles[1], 3 * Math.max(bg.width, bg.height) * view.zoom)
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="character-grid">
      <GuideLayer camera={doc.camera} size={bg} view={view} kind="ground" origin={origin} boxSize={1} />
      <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke={HORIZON} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="8 6" />
    </svg>
  )
}

/**
 * 相机步骤的画布控件：地平线方式拖动地平线（两端的圆点改变高度和倾斜，线本身上下平移），
 * 平行线方式拖动两组线的端点并实时求解；两种方式都叠加可拖动的参考形状。
 */
export function CameraGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const guide = useCameraGuide()
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [focus, setFocus] = useState<LoupeFocus | null>(null)

  const { background, camera } = doc
  if (!background || step !== 'camera') return null
  const origin = guideOrigin(doc, guide.origin)!

  const toScreen = (p: Point) => docToScreen(view, p)
  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const interactive = passThrough ? 'none' : 'auto'
  const reach = 3 * Math.max(background.width, background.height) * view.zoom
  const span = 2 * Math.max(background.width, background.height)

  /** 放大镜的内容：拖动的控制点和它所在的线 */
  const focusOn = (at: Point, line?: [Point, Point], color = HORIZON) => {
    const lines = line ? [{ a: extend(line[0], line[1], span)[0], b: extend(line[0], line[1], span)[1], color }] : []
    setFocus({ at, lines })
  }

  const begin = (e: ReactPointerEvent<SVGElement>, drag: Drag) => {
    if (e.button !== 0) return false
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    // 移动参考形状不改变文档，不进撤销记录
    if (drag.kind !== 'guide') useApp.getState().beginGesture()
    dragRef.current = drag
    return true
  }

  const beginGuide = (e: ReactPointerEvent<SVGElement>, target: GuideTarget) => {
    if (target === 'x' || target === 'z') return begin(e, { id: e.pointerId, kind: 'rotate', axis: target, origin })
    const p = toDoc(e)
    const height = target === 'origin' ? 0 : grabHeight(camera, background, guide.kind, origin, p, guide.boxSize)
    if (begin(e, { id: e.pointerId, kind: 'guide', origin, height, start: target === 'origin' ? origin : p }) && target === 'origin') focusOn(origin)
  }

  const beginHorizon = (e: ReactPointerEvent<SVGElement>, which: 0 | 1 | 'both') => {
    const handles = HANDLE_X.map((k) => horizonAt(camera, background, k * background.width)) as [Point, Point]
    const p = toDoc(e)
    if (begin(e, { id: e.pointerId, kind: 'horizon', which, handles, startY: p.y })) focusOn(which === 'both' ? horizonAt(camera, background, p.x) : handles[which], handles)
  }

  const beginLine = (e: ReactPointerEvent<SVGElement>, pair: Pair, segment: 0 | 1, end: 0 | 1, at: Point) => {
    const p = toDoc(e)
    const seg = camera.lines![pair][segment].map((v) => ({ x: v.x * background.width, y: v.y * background.height })) as [Point, Point]
    if (begin(e, { id: e.pointerId, kind: 'line', pair, segment, end, offset: { x: at.x - p.x, y: at.y - p.y } })) focusOn(at, seg, pairColor(pair, camera.lines!))
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    const s = useApp.getState()
    const { background: bg, camera: c } = s.doc
    if (!bg) return
    const p = toDoc(e)
    if (d.kind === 'guide') {
      const moved = dragOrigin(c, bg, d.origin, d.height, d.start, p)
      if (moved) useCameraGuide.getState().setOrigin(bg.id, moved)
      if (moved && focus) focusOn(moved)
      return
    }
    if (d.kind === 'rotate') {
      const yaw = yawToward(c, bg, d.origin, p, d.axis)
      if (yaw !== null) s.updateCamera({ yaw: e.shiftKey ? SNAP * Math.round(yaw / SNAP) : yaw })
      return
    }
    if (d.kind === 'horizon') {
      // 控制点只上下移动；拖动线本身时两端一起移动
      const dy = p.y - d.startY
      const [a, b] = d.handles.map((h, i) => (d.which === 'both' || d.which === i ? { x: h.x, y: h.y + dy } : h))
      s.updateCamera(orientationFromHorizon(a, b, bg, c))
      const next = useApp.getState().doc.camera
      focusOn(horizonAt(next, bg, d.which === 'both' ? p.x : d.handles[d.which].x), [horizonAt(next, bg, a.x), horizonAt(next, bg, b.x)])
      return
    }
    if (!c.lines) return
    const q = { x: clamp((p.x + d.offset.x) / bg.width, -1, 2), y: clamp((p.y + d.offset.y) / bg.height, -1, 2) }
    const pair = c.lines[d.pair].map((seg, i) => (i === d.segment ? seg.map((v, j) => (j === d.end ? q : v)) : seg)) as CameraLines[Pair]
    const lines = { ...c.lines, [d.pair]: pair }
    // 不能求解时只更新线段，保持上一个可用的结果
    const solved = solveLines(lines, bg)
    s.updateCamera({ lines, ...(solved.ok ? solved.camera : {}) })
    const seg = pair[d.segment].map((v) => ({ x: v.x * bg.width, y: v.y * bg.height })) as [Point, Point]
    focusOn(seg[d.end], seg, pairColor(d.pair, lines))
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    dragRef.current = null
    setFocus(null)
    if (d.kind !== 'guide') useApp.getState().endGesture()
  }

  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end }
  const handles = HANDLE_X.map((k) => toScreen(horizonAt(camera, background, k * background.width)))
  const [h0, h1] = extend(handles[0], handles[1], reach)
  const lineMode = camera.method === 'lines' && camera.lines

  const tl = toScreen({ x: 0, y: 0 })
  const br = toScreen({ x: background.width, y: background.height })
  return (
    <>
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="camera-gizmo">
      {guide.dim && <rect x={tl.x} y={tl.y} width={br.x - tl.x} height={br.y - tl.y} fill="black" fillOpacity={DIM} data-testid="camera-dim" />}
      <GuideLayer
        camera={camera}
        size={background}
        view={view}
        kind={guide.kind}
        origin={origin}
        boxSize={guide.boxSize}
        onGrab={beginGuide}
        rotatable={camera.method === 'horizon'}
        handlers={handlers}
        passThrough={passThrough}
      />
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
              <Crosshair
                key={i}
                at={p}
                color={HORIZON}
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
            const color = pairColor(pair, lineMode)
            return (
              <g key={`${pair}-${i}`} data-testid={`camera-line-${pair}-${i}`}>
                <line x1={e0.x} y1={e0.y} x2={e1.x} y2={e1.y} stroke={color} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="4 6" />
                <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="rgba(0,0,0,0.5)" strokeWidth={4} />
                <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={color} strokeWidth={2} />
                {[a, b].map((p, j) => {
                  return (
                    <Crosshair
                      key={j}
                      at={toScreen(p)}
                      color={color}
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
    {focus && <Loupe assetId={background.id} view={view} focus={focus} />}
    </>
  )
}
