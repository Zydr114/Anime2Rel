import { useId, type PointerEvent as ReactPointerEvent, type SVGProps } from 'react'
import { docToScreen, type Point, type Size, type ViewTransform } from '@/algo/geometry'
import { horizonLine } from '@/camera/geometry'
import { AXIS_COLORS, guideGeometry, type GuideKind } from '@/camera/guides'
import type { CameraDoc } from '@/camera/model'

export type GuideTarget = 'body' | 'origin' | 'x' | 'z'

interface Props {
  camera: CameraDoc
  size: Size
  view: ViewTransform
  kind: GuideKind
  origin: Point
  /** 网格和立方体的大小倍数 */
  scale: number
  /** 可以拖动时，按下形状、原点或红蓝箭头 */
  onGrab?: (e: ReactPointerEvent<SVGElement>, target: GuideTarget) => void
  /** 红蓝箭头可以拖动旋转 */
  rotatable?: boolean
  handlers?: Pick<SVGProps<SVGElement>, 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>
  passThrough?: boolean
}

/** 箭头的三角形（屏幕坐标） */
function arrowHead(from: Point, to: Point, size = 9): string {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const [dx, dy] = [(to.x - from.x) / len, (to.y - from.y) / len]
  const base = { x: to.x - dx * size, y: to.y - dy * size }
  return [to, { x: base.x - dy * size * 0.45, y: base.y + dx * size * 0.45 }, { x: base.x + dy * size * 0.45, y: base.y - dx * size * 0.45 }].map((p) => `${p.x},${p.y}`).join(' ')
}

/** 参考形状、原点和坐标轴；只画在画面范围内，地面网格向地平线方向淡出 */
export function GuideLayer({ camera, size, view, kind, origin, scale, onGrab, rotatable, handlers, passThrough }: Props) {
  const id = useId()
  const geo = guideGeometry(camera, size, kind, origin, scale)
  if (!geo) return null
  const s = (p: Point) => docToScreen(view, p)
  const tl = s({ x: 0, y: 0 })
  const br = s({ x: size.width, y: size.height })
  const h = horizonLine(camera, size)
  const from = s(h.point)
  const fade = 0.4 * size.height * view.zoom
  const to = { x: from.x + h.normal.x * fade, y: from.y + h.normal.y * fade }
  const interactive = onGrab && !passThrough ? 'auto' : 'none'
  const grab = (target: GuideTarget) => (onGrab ? { onPointerDown: (e: ReactPointerEvent<SVGElement>) => onGrab(e, target), ...handlers } : {})
  const points = (ps: Point[]) => ps.map((p) => s(p)).map((p) => `${p.x},${p.y}`).join(' ')
  const o = s(geo.axes.origin)
  const ground = kind === 'ground'
  return (
    <g data-testid="camera-guide" data-kind={kind}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect x={tl.x} y={tl.y} width={br.x - tl.x} height={br.y - tl.y} />
        </clipPath>
        {ground && (
          <>
            <linearGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="1" stopColor="white" stopOpacity="0.7" />
            </linearGradient>
            <linearGradient id={`${id}-shade`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
              <stop offset="0" stopColor="black" stopOpacity="0" />
              <stop offset="1" stopColor="black" stopOpacity="0.35" />
            </linearGradient>
          </>
        )}
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        {geo.hit.map((poly, i) => (
          <polygon key={i} points={points(poly)} fill="transparent" style={{ pointerEvents: interactive, cursor: 'move' }} {...grab('body')} data-testid="guide-body" />
        ))}
        {(['shade', 'line'] as const).map((layer) => (
          <g
            key={layer}
            pointerEvents="none"
            stroke={ground ? `url(#${id}-${layer === 'shade' ? 'shade' : 'fade'})` : layer === 'shade' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.85)'}
            strokeWidth={layer === 'shade' ? (ground ? 2.5 : 3) : ground ? 1 : 1.25}
          >
            {geo.lines.map((l, i) => {
              const [a, b] = [s(l.a), s(l.b)]
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            })}
          </g>
        ))}
      </g>
      {(['y', 'x', 'z'] as const).map((axis) => {
        const tip = geo.axes[axis]
        if (!tip) return null
        const t = s(tip)
        const color = AXIS_COLORS[axis]
        const handle = rotatable && axis !== 'y'
        return (
          <g key={axis} data-testid={`guide-axis-${axis}`}>
            <line x1={o.x} y1={o.y} x2={t.x} y2={t.y} stroke="rgba(0,0,0,0.5)" strokeWidth={4} pointerEvents="none" />
            <line x1={o.x} y1={o.y} x2={t.x} y2={t.y} stroke={color} strokeWidth={2} pointerEvents="none" />
            <polygon points={arrowHead(o, t)} fill={color} stroke="rgba(0,0,0,0.5)" strokeWidth={1} pointerEvents="none" />
            {handle && (
              <circle
                cx={t.x}
                cy={t.y}
                r={9}
                fill="transparent"
                style={{ pointerEvents: interactive, cursor: 'grab' }}
                {...grab(axis)}
                data-testid={`guide-rotate-${axis}`}
              />
            )}
          </g>
        )
      })}
      <circle cx={o.x} cy={o.y} r={5} fill="white" stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} style={{ pointerEvents: interactive, cursor: 'move' }} {...grab('origin')} data-testid="guide-origin" />
    </g>
  )
}
