import { useRef, useState, type PointerEvent as ReactPointerEvent, type SVGProps } from 'react'
import { clamp, docToScreen, screenToDoc, type Point, type Size } from '@/algo/geometry'
import { groundPoint, heightAbove, horizonLine, orientationFromHorizon, pointAbove, solveLines } from '@/camera/geometry'
import { AXIS_COLORS, dragOrigin, grabHeight, ROD_HEIGHT, yawToward } from '@/camera/guides'
import { cross } from '@/camera/vec'
import type { CameraDoc, CameraLines } from '@/camera/model'
import { characterGround } from '@/fusion/placement'
import { t } from '@/i18n'
import { guideOrigin, guideRod, useCameraGuide } from '@/state/cameraGuide'
import { useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { GuideLayer, type GuideTarget } from './CameraGuide'
import { Loupe, type LoupeFocus } from './Loupe'

/** 视平线的颜色 */
const HORIZON = 'rgb(252, 211, 77)'
const PAIRS = ['first', 'second'] as const
/** 平行线按所沿的轴取色：第一组沿红轴，第二组沿蓝轴或竖直的绿轴 */
const pairColor = (pair: Pair, lines: CameraLines) => (pair === 'first' ? AXIS_COLORS.x : lines.secondAxis === 'vertical' ? AXIS_COLORS.y : AXIS_COLORS.z)
type Pair = (typeof PAIRS)[number]
/** 旋转参考形状时按住 Shift 的步进 */
const SNAP = Math.PI / 12
/** 视平线两端控制点的位置（画面宽度的比例） */
const HANDLE_X = [0.15, 0.85] as const
const HANDLE_R = 7
/** 相机步骤中暗化照片的程度 */
const DIM = 0.45
/** 测量杆的颜色和最小高度（米） */
const ROD = 'rgb(250, 250, 250)'
const ROD_MIN = 0.05
/** 消失点离画面中心超过长边的这个倍数时不标出 */
const VP_LIMIT = 20

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
  | { id: number; kind: 'rod'; part: 'foot' | 'top' | 'body'; foot: Point; meters: number; offset: Point }

/** 只改变界面状态、不进撤销记录的拖动 */
const undoable = (d: Drag) => d.kind !== 'guide' && d.kind !== 'rod'

/** 视平线上横坐标为 x 的点（文档坐标） */
function horizonAt(c: CameraDoc, size: Size, x: number): Point {
  const h = horizonLine(c, size)
  return { x, y: h.point.y + (h.dir.y * (x - h.point.x)) / h.dir.x }
}

/** 穿过 a、b 的长直线（屏幕坐标），用于画视平线和平行线的延长线 */
function extend(a: Point, b: Point, length: number): [Point, Point] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const d = { x: ((b.x - a.x) / len) * length, y: ((b.y - a.y) / len) * length }
  return [
    { x: a.x - d.x, y: a.y - d.y },
    { x: b.x + d.x, y: b.y + d.y },
  ]
}

/** 两条直线 ab、cd 的交点（屏幕坐标）；交点离 near 超过 limit 时当作平行，为 null */
function meet([a, b]: Point[], [c, d]: Point[], near: Point, limit: number): Point | null {
  const v = cross(cross([a.x, a.y, 1], [b.x, b.y, 1]), cross([c.x, c.y, 1], [d.x, d.y, 1]))
  if (v[2] === 0) return null
  const p = { x: v[0] / v[2], y: v[1] / v[2] }
  return Math.hypot(p.x - near.x, p.y - near.y) <= limit ? p : null
}

/** 视平线旁的标签：写在右侧控制点的左边、天空一侧（左侧默认放着测量杆） */
function HorizonLabel({ from, to }: { from: Point; to: Point }) {
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
  return (
    <text
      transform={`translate(${to.x} ${to.y}) rotate(${angle}) translate(-14 -7)`}
      textAnchor="end"
      fill={HORIZON}
      stroke="rgba(0,0,0,0.7)"
      strokeWidth={3}
      paintOrder="stroke"
      fontSize={12}
      fontWeight={600}
      pointerEvents="none"
      data-testid="horizon-label"
    >
      {t.camera.horizonLabel}
    </text>
  )
}

/** 立绘步骤可选的参考形状：原点在立绘的接地点（不在地面上时取默认位置），并画出视平线 */
export function CharacterGuide() {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const showGuide = useFusion((s) => s.showGuide)
  const { kind, boxSize } = useCameraGuide()
  const info = useCharacterInfo(doc)
  const bg = doc.background
  if (!bg || step !== 'character' || !showGuide || kind === 'none') return null
  const foot = doc.character ? characterGround(doc, bg, info?.bbox) : null
  const origin = foot && groundPoint(doc.camera, bg, foot) ? foot : guideOrigin(doc, null)!
  const handles = HANDLE_X.map((k) => docToScreen(view, horizonAt(doc.camera, bg, k * bg.width)))
  const [h0, h1] = extend(handles[0], handles[1], 3 * Math.max(bg.width, bg.height) * view.zoom)
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="character-guide">
      <GuideLayer camera={doc.camera} size={bg} view={view} kind={kind} origin={origin} boxSize={boxSize} />
      <line x1={h0.x} y1={h0.y} x2={h1.x} y2={h1.y} stroke={HORIZON} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="8 6" />
      <HorizonLabel from={handles[0]} to={handles[1]} />
    </svg>
  )
}

/**
 * 相机步骤的画布控件：视平线方式拖动视平线（两端的圆点改变高度和倾斜，线本身上下平移），
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
  const rod = guideRod(doc, guide.rod)!
  const rodMeters = heightAbove(camera, background, rod.foot, rod.top)
  const rodTop = pointAbove(camera, background, rod.foot, Math.max(rodMeters ?? 0, ROD_MIN)) ?? rod.top

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
    if (undoable(drag)) useApp.getState().beginGesture()
    dragRef.current = drag
    return true
  }

  const beginGuide = (e: ReactPointerEvent<SVGElement>, target: GuideTarget) => {
    if (target === 'x' || target === 'z') return begin(e, { id: e.pointerId, kind: 'rotate', axis: target, origin })
    const p = toDoc(e)
    const height = target === 'origin' ? 0 : grabHeight(camera, background, guide.kind, origin, p, guide.boxSize)
    if (begin(e, { id: e.pointerId, kind: 'guide', origin, height, start: target === 'origin' ? origin : p }) && target === 'origin') focusOn(origin)
  }

  const beginRod = (e: ReactPointerEvent<SVGElement>, part: 'foot' | 'top' | 'body') => {
    const p = toDoc(e)
    const at = part === 'top' ? rodTop : rod.foot
    const drag: Drag = { id: e.pointerId, kind: 'rod', part, foot: rod.foot, meters: rodMeters ?? ROD_HEIGHT, offset: { x: at.x - p.x, y: at.y - p.y } }
    if (begin(e, drag)) focusOn(at, [rod.foot, rodTop], ROD)
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
    if (d.kind === 'rod') {
      const q = { x: p.x + d.offset.x, y: p.y + d.offset.y }
      // 移动时高度不变；拖动顶端时沿竖直方向改变高度
      const foot = d.part === 'top' ? d.foot : q
      const meters = d.part === 'top' ? heightAbove(c, bg, d.foot, q) : d.meters
      const top = meters !== null && groundPoint(c, bg, foot) ? pointAbove(c, bg, foot, Math.max(meters, ROD_MIN)) : null
      if (!top) return
      useCameraGuide.getState().setRod(bg.id, foot, top)
      focusOn(d.part === 'top' ? top : foot, [foot, top], ROD)
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
    if (undoable(d)) useApp.getState().endGesture()
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
        <HorizonLabel from={handles[0]} to={handles[1]} />
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
      {/* 测量杆画在视平线之上：顶端常在视平线附近，小的控制点优先拾取 */}
      <MeasuringRod
        foot={toScreen(rod.foot)}
        top={toScreen(rodTop)}
        meters={rodMeters}
        interactive={interactive}
        onGrab={beginRod}
        handlers={handlers}
      />
      {lineMode &&
        PAIRS.map((pair) => {
          const color = pairColor(pair, lineMode)
          const segs = lineMode[pair].map((seg) => seg.map((v) => ({ x: v.x * background.width, y: v.y * background.height })))
          const screen = segs.map((seg) => seg.map(toScreen))
          const center = toScreen({ x: background.width / 2, y: background.height / 2 })
          const vp = meet(screen[0], screen[1], center, VP_LIMIT * Math.max(background.width, background.height) * view.zoom)
          return (
            <g key={pair}>
              {screen.map(([sa, sb], i) => {
                // 延长线至少画到消失点
                const length = vp ? Math.max(reach, Math.hypot(vp.x - sa.x, vp.y - sa.y), Math.hypot(vp.x - sb.x, vp.y - sb.y)) : reach
                const [e0, e1] = extend(sa, sb, length)
                return (
                  <g key={i} data-testid={`camera-line-${pair}-${i}`}>
                    <line x1={e0.x} y1={e0.y} x2={e1.x} y2={e1.y} stroke={color} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="4 6" />
                    <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="rgba(0,0,0,0.5)" strokeWidth={4} />
                    <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={color} strokeWidth={2} />
                    {segs[i].map((p, j) => (
                      <Crosshair
                        key={j}
                        at={screen[i][j]}
                        color={color}
                        style={{ pointerEvents: interactive, cursor: 'move' }}
                        onPointerDown={(e) => beginLine(e, pair, i as 0 | 1, j as 0 | 1, p)}
                        {...handlers}
                        data-testid={`camera-handle-${pair}-${i}-${j}`}
                      />
                    ))}
                  </g>
                )
              })}
              {vp && (
                <g pointerEvents="none" data-testid={`camera-vp-${pair}`}>
                  <circle cx={vp.x} cy={vp.y} r={5} fill={color} stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />
                  <text x={vp.x + 9} y={vp.y - 7} fill={color} stroke="rgba(0,0,0,0.7)" strokeWidth={3} paintOrder="stroke" fontSize={12} fontWeight={600}>
                    {t.camera.vanishingPoint}
                  </text>
                </g>
              )}
            </g>
          )
        })}
    </svg>
    {focus && <Loupe assetId={background.id} view={view} focus={focus} />}
    </>
  )
}

/** 测量杆：竖直的杆，旁边标出高度。拖动底端或杆身在地面上移动，拖动顶端改变高度 */
function MeasuringRod({
  foot,
  top,
  meters,
  interactive,
  onGrab,
  handlers,
}: {
  foot: Point
  top: Point
  meters: number | null
  interactive: 'none' | 'auto'
  onGrab: (e: ReactPointerEvent<SVGElement>, part: 'foot' | 'top' | 'body') => void
  handlers: Pick<SVGProps<SVGElement>, 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>
}) {
  const len = Math.hypot(top.x - foot.x, top.y - foot.y) || 1
  // 两端的短横线垂直于杆
  const n = { x: (-(top.y - foot.y) / len) * 6, y: ((top.x - foot.x) / len) * 6 }
  const tick = (p: Point) => `M${p.x - n.x},${p.y - n.y}L${p.x + n.x},${p.y + n.y}`
  const path = `M${foot.x},${foot.y}L${top.x},${top.y}${tick(foot)}${tick(top)}`
  return (
    <g data-testid="camera-rod">
      <path d={path} stroke="rgba(0,0,0,0.55)" strokeWidth={4.5} fill="none" strokeLinecap="round" pointerEvents="none" />
      <path d={path} stroke={ROD} strokeWidth={2} fill="none" strokeLinecap="round" pointerEvents="none" />
      <line
        x1={foot.x}
        y1={foot.y}
        x2={top.x}
        y2={top.y}
        stroke="transparent"
        strokeWidth={14}
        style={{ pointerEvents: interactive, cursor: 'move' }}
        onPointerDown={(e) => onGrab(e, 'body')}
        {...handlers}
        data-testid="rod-body"
      />
      <Crosshair at={foot} color={ROD} style={{ pointerEvents: interactive, cursor: 'move' }} onPointerDown={(e) => onGrab(e, 'foot')} {...handlers} data-testid="rod-foot" />
      <Crosshair at={top} color={ROD} style={{ pointerEvents: interactive, cursor: 'ns-resize' }} onPointerDown={(e) => onGrab(e, 'top')} {...handlers} data-testid="rod-top" />
      <text x={top.x + 12} y={top.y + 4} fill="white" stroke="rgba(0,0,0,0.7)" strokeWidth={3} paintOrder="stroke" fontSize={13} fontWeight={600} pointerEvents="none" data-testid="rod-label">
        {meters === null ? '—' : `${meters.toFixed(2)} m`}
      </text>
    </g>
  )
}
