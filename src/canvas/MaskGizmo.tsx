import { useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import type { EllipseShape, LinearShape, LocalMask } from '@/grade/mask'
import { currentBrushMasks, type BrushMasks } from '@/grade/maskBrush'
import { useGradeUi } from '@/state/grade'
import { useApp, type DocState } from '@/state/store'
import { StrokeBrush } from './StrokeBrush'

/** 控点的半径（屏幕像素）、旋转控点在椭圆外的距离 */
const HANDLE = 6
const ROTATE_GAP = 28
/** 画笔蒙版着色的颜色与不透明度 */
const BRUSH_COLOR: readonly [number, number, number] = [251, 146, 60]
const BRUSH_ALPHA = 0.5

/** 调色步骤“局部”页中选中的局部调整；不在这一页或没有选中时为 null */
function useSelectedMask(doc: DocState): { mask: LocalMask; index: number } | null {
  const step = useApp((s) => s.step)
  const tab = useGradeUi((s) => s.tab)
  const id = useGradeUi((s) => s.mask)
  if (!doc.background || step !== 'adjust' || tab !== 'local') return null
  const index = doc.masks.findIndex((m) => m.id === id)
  return index >= 0 ? { mask: doc.masks[index], index } : null
}

/** 拖动的一个控点：按下时开始一次撤销记录并调用 onBegin，移动时把指针与按下处的文档坐标交给 onDrag，抬起时结束 */
function Handle(props: { at: Point; passThrough: boolean; cursor: string; onBegin?: () => void; onDrag: (p: Point, from: Point) => void; testId: string; children?: ReactNode }) {
  const { at, passThrough, cursor, testId, children } = props
  const dragRef = useRef<{ id: number; from: Point } | null>(null)
  const toDoc = (e: ReactPointerEvent) => {
    const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    props.onBegin?.()
    dragRef.current = { id: e.pointerId, from: toDoc(e) }
  }
  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (d?.id === e.pointerId) props.onDrag(toDoc(e), d.from)
  }
  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }
  return (
    <g
      transform={`translate(${at.x} ${at.y})`}
      style={{ pointerEvents: passThrough ? 'none' : 'auto', cursor }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      data-testid={testId}
    >
      <circle r={HANDLE + 6} fill="transparent" />
      {children ?? <circle r={HANDLE} fill="white" stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />}
    </g>
  )
}

/** 带黑色描边的线，在任何背景上都看得清 */
function Line({ a, b, dashed }: { a: Point; b: Point; dashed?: boolean }) {
  return (
    <>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(0,0,0,0.5)" strokeWidth={3} />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="white" strokeWidth={1.5} strokeDasharray={dashed ? '6 4' : undefined} />
    </>
  )
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/**
 * 局部调整的画布控件（docs/Plan.md §3.7 M8.8b）：只在调色步骤的“局部”页中显示选中的一项。
 * 椭圆：拖动中心移动，拖动轴端的点改变半径，拖动外侧的点旋转，虚线内圈表示完全作用的范围。
 * 线性渐变：实线为起点线，虚线为终点线，拖动线上的点移动这条线，拖动中间的点整体移动。画笔形状在画布上涂抹。一次拖动、一笔都记一次撤销。
 */
export function MaskGizmo({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const selected = useSelectedMask(doc)
  if (!selected || !doc.background) return null
  const { mask, index } = selected
  if (mask.shape === 'ellipse') return <EllipseGizmo mask={mask} passThrough={passThrough} />
  if (mask.shape === 'linear') return <LinearGizmo mask={mask} passThrough={passThrough} />
  if (mask.shape === 'brush') return <MaskBrush doc={doc} mask={mask} index={index} passThrough={passThrough} />
  return null
}

function EllipseGizmo({ mask, passThrough }: { mask: LocalMask; passThrough: boolean }) {
  const view = useApp((s) => s.view)
  const e = mask.ellipse
  const set = (u: Partial<EllipseShape>) => useApp.getState().updateMaskPart(mask.id, 'ellipse', u)
  const current = () => useApp.getState().doc.masks.find((m) => m.id === mask.id)?.ellipse ?? e
  const u = { x: Math.cos(e.rotation), y: Math.sin(e.rotation) }
  const v = { x: -u.y, y: u.x }
  const c = docToScreen(view, e)
  const along = (d: Point, r: number) => ({ x: c.x + d.x * r * view.zoom, y: c.y + d.y * r * view.zoom })
  const deg = (e.rotation * 180) / Math.PI
  const inner = 1 - e.feather
  const rotateAt = { x: c.x - v.x * (e.ry * view.zoom + ROTATE_GAP), y: c.y - v.y * (e.ry * view.zoom + ROTATE_GAP) }
  const top = along(v, -e.ry)

  // 半径：拖动点到中心的距离在对应轴上的投影
  const radius = (axis: 'rx' | 'ry') => (p: Point) => {
    const s = current()
    const d = axis === 'rx' ? { x: Math.cos(s.rotation), y: Math.sin(s.rotation) } : { x: -Math.sin(s.rotation), y: Math.cos(s.rotation) }
    set({ [axis]: Math.max(1, Math.abs((p.x - s.x) * d.x + (p.y - s.y) * d.y)) })
  }
  const start = useRef<EllipseShape | null>(null)

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="mask-gizmo" data-shape="ellipse">
      <g transform={`rotate(${deg} ${c.x} ${c.y})`}>
        <ellipse cx={c.x} cy={c.y} rx={e.rx * view.zoom} ry={e.ry * view.zoom} fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth={3} />
        <ellipse cx={c.x} cy={c.y} rx={e.rx * view.zoom} ry={e.ry * view.zoom} fill="none" stroke="white" strokeWidth={1.5} />
        {inner > 0.01 && <ellipse cx={c.x} cy={c.y} rx={e.rx * inner * view.zoom} ry={e.ry * inner * view.zoom} fill="none" stroke="white" strokeOpacity={0.8} strokeWidth={1} strokeDasharray="5 4" />}
      </g>
      <Line a={top} b={rotateAt} />
      <Handle
        at={c}
        passThrough={passThrough}
        cursor="move"
        onBegin={() => (start.current = current())}
        onDrag={(p, from) => set({ x: start.current!.x + p.x - from.x, y: start.current!.y + p.y - from.y })}
        testId="mask-center"
      >
        <circle r={HANDLE} fill="rgba(0,0,0,0.35)" stroke="white" strokeWidth={1.5} />
        <circle r={1.5} fill="white" />
      </Handle>
      {([1, -1] as const).map((k) => (
        <Handle key={`rx${k}`} at={along(u, k * e.rx)} passThrough={passThrough} cursor="ew-resize" onDrag={radius('rx')} testId={`mask-rx${k > 0 ? '' : '-opposite'}`} />
      ))}
      {([1, -1] as const).map((k) => (
        <Handle key={`ry${k}`} at={along(v, k * e.ry)} passThrough={passThrough} cursor="ns-resize" onDrag={radius('ry')} testId={`mask-ry${k > 0 ? '' : '-opposite'}`} />
      ))}
      <Handle
        at={rotateAt}
        passThrough={passThrough}
        cursor="grab"
        onDrag={(p) => {
          const s = current()
          // 旋转控点在 −v 方向上：−v 的方向角 = 旋转 − 90°
          set({ rotation: wrapAngle(Math.atan2(p.y - s.y, p.x - s.x) + Math.PI / 2) })
        }}
        testId="mask-rotate"
      >
        <circle r={HANDLE} fill="rgba(0,0,0,0.35)" stroke="white" strokeWidth={1.5} />
      </Handle>
    </svg>
  )
}

function LinearGizmo({ mask, passThrough }: { mask: LocalMask; passThrough: boolean }) {
  const view = useApp((s) => s.view)
  const bg = useApp((s) => s.doc.background)!
  const l = mask.linear
  const set = (u: Partial<LinearShape>) => useApp.getState().updateMaskPart(mask.id, 'linear', u)
  const current = () => useApp.getState().doc.masks.find((m) => m.id === mask.id)?.linear ?? l
  const p0 = docToScreen(view, { x: l.x0, y: l.y0 })
  const p1 = docToScreen(view, { x: l.x1, y: l.y1 })
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y)
  const d = len > 1e-6 ? { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len } : { x: 0, y: -1 }
  const n = { x: -d.y, y: d.x }
  // 两条线横跨整个文档，在文档范围内裁剪
  const reach = Math.hypot(bg.width, bg.height) * view.zoom
  const across = (p: Point) => [
    { x: p.x - n.x * reach, y: p.y - n.y * reach },
    { x: p.x + n.x * reach, y: p.y + n.y * reach },
  ]
  const [a0, b0] = across(p0)
  const [a1, b1] = across(p1)
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  const tl = docToScreen(view, { x: 0, y: 0 })
  const start = useRef<LinearShape | null>(null)
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="mask-gizmo" data-shape="linear">
      <defs>
        <clipPath id="mask-linear-clip">
          <rect x={tl.x} y={tl.y} width={bg.width * view.zoom} height={bg.height * view.zoom} />
        </clipPath>
      </defs>
      <g clipPath="url(#mask-linear-clip)">
        <Line a={a0} b={b0} />
        <Line a={a1} b={b1} dashed />
      </g>
      <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="white" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 3" />
      <Handle at={p0} passThrough={passThrough} cursor="move" onDrag={(p) => set({ x0: p.x, y0: p.y })} testId="mask-start" />
      <Handle at={p1} passThrough={passThrough} cursor="move" onDrag={(p) => set({ x1: p.x, y1: p.y })} testId="mask-end" />
      <Handle
        at={mid}
        passThrough={passThrough}
        cursor="move"
        onBegin={() => (start.current = current())}
        onDrag={(p, from) => {
          const s = start.current!
          const dx = p.x - from.x
          const dy = p.y - from.y
          set({ x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy })
        }}
        testId="mask-middle"
      >
        <circle r={HANDLE} fill="rgba(0,0,0,0.35)" stroke="white" strokeWidth={1.5} />
        <circle r={1.5} fill="white" />
      </Handle>
    </svg>
  )
}

/** 第 index 项画笔蒙版的着色图 */
function tint(masks: BrushMasks, index: number): ImageData {
  const { width, height } = masks
  const src = masks.data[index >> 2]
  const c = index & 3
  const img = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    const a = src[i * 4 + c]
    if (!a) continue
    img.data.set([...BRUSH_COLOR, Math.round(a * BRUSH_ALPHA)], i * 4)
  }
  return img
}

function MaskBrush({ doc, mask, index, passThrough }: { doc: DocState; mask: LocalMask; index: number; passThrough: boolean }) {
  const tool = useGradeUi((s) => s.maskTool)
  const size = useGradeUi((s) => s.maskBrushSize)
  const masks = currentBrushMasks(doc)
  const overlay = useMemo(() => masks && tint(masks, index), [masks, index])
  return (
    <StrokeBrush
      passThrough={passThrough}
      doc={doc.background!}
      size={size}
      tool={tool}
      color={`rgba(${BRUSH_COLOR.join(', ')}, 0.6)`}
      overlay={overlay}
      onStroke={(stroke) => useApp.getState().addMaskStroke(mask.id, stroke)}
      testId="mask"
    />
  )
}
