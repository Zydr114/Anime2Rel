import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { linearToHex } from '@/algo/color'
import type { Point } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { add, dot } from '@/camera/vec'
import { planeHit, snapDirection, sphereDirection } from '@/scene3d/drag'
import { lampFromWorld, type LightLayout } from '@/scene3d/layout'
import { directionToCamera, projectToScreen, screenRay, type Projection } from '@/scene3d/space'
import { useDepth } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { currentScene, useView3d } from '@/state/view3d'

const HANDLE = 9
/** 太阳拖动时按住 Shift 的步进 */
const SNAP = (15 * Math.PI) / 180
/** 按住 Alt 拖动灯时，每像素沿视线移动距离的比例 */
const DEPTH_SPEED = 0.005
/** 灯的投影圈的半径（参考距离的比例） */
const FOOT = 0.03
const SEGMENTS = 96

interface Drag {
  id: number
  light: string
  /** 光源在屏幕上的位置减去按下的位置，拖动时光源保持在光标的相对位置 */
  offset: Point
  /** 灯：所在的平面经过 anchor；按住 Alt 时沿视点到 anchor 的方向移动 */
  anchor: Vec3
  anchorY: number
  alt: boolean
  /** 太阳：在球面靠近视点的一侧 */
  near: boolean
}

/** 视点前方的部分线段投影到屏幕；整段在视点后方时为 null */
function segment(p: Projection, a: Vec3, b: Vec3): [Point, Point] | null {
  const near = 1e-4
  const za = -dot(add(a, p.position, -1), p.back)
  const zb = -dot(add(b, p.position, -1), p.back)
  if (za < near && zb < near) return null
  const lerp = (u: Vec3, v: Vec3, k: number): Vec3 => add(u, add(v, u, -1), k)
  const a2 = za < near ? lerp(a, b, (near - za) / (zb - za)) : a
  const b2 = zb < near ? lerp(b, a, (near - zb) / (za - zb)) : b
  const pa = projectToScreen(p, a2)
  const pb = projectToScreen(p, b2)
  return pa && pb ? [pa, pb] : null
}

/** 折线（世界坐标）的 SVG 路径，视点后方的部分省略 */
function path(p: Projection, points: Vec3[], closed = false): string {
  let d = ''
  const n = closed ? points.length : points.length - 1
  for (let i = 0; i < n; i++) {
    const s = segment(p, points[i], points[(i + 1) % points.length])
    if (s) d += `M${s[0].x.toFixed(1)} ${s[0].y.toFixed(1)}L${s[1].x.toFixed(1)} ${s[1].y.toFixed(1)}`
  }
  return d
}

/** 水平的圆（世界坐标） */
function circle(center: Vec3, radius: number): Vec3[] {
  return Array.from({ length: SEGMENTS }, (_, i) => {
    const a = (i / SEGMENTS) * 2 * Math.PI
    return [center[0] + radius * Math.cos(a), center[1], center[2] + radius * Math.sin(a)] as Vec3
  })
}

/** 3D 视图中的光源控件：太阳在球面上，灯有落到地面的投影线；拖动改变方向或位置，选中与面板同步 */
export function View3DLights() {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const lights = useApp((s) => s.doc.lighting.lights)
  const selected = useLighting((s) => s.selected)
  // 以下状态变化时场景布局或投影随之变化，需要重画
  useApp((s) => s.doc)
  useApp((s) => s.view)
  useApp((s) => s.viewport)
  useView3d((s) => s.view)
  useDepth((s) => s.resultsVersion)
  useFusion((s) => s.character)
  useFusion((s) => s.warped)

  const scene = currentScene()
  if (!scene) return null
  const { layout, projection: p } = scene

  const local = (e: ReactPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const begin = (e: ReactPointerEvent<SVGElement>, l: LightLayout, at: Point) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useLighting.getState().select(l.id)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    const s = local(e)
    const viewer = add(p.position, layout.target, -1)
    dragRef.current = {
      id: e.pointerId,
      light: l.id,
      offset: { x: at.x - s.x, y: at.y - s.y },
      anchor: l.position,
      anchorY: e.clientY,
      alt: e.altKey,
      near: dot(add(l.position, layout.target, -1), viewer) >= 0,
    }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const scene = currentScene()
    const app = useApp.getState()
    const bg = app.doc.background
    const l = scene?.layout.lights.find((l) => l.id === d.light)
    if (!scene || !bg || !l) return
    const { layout, projection: p } = scene
    const pointer = local(e)
    const s = { x: pointer.x + d.offset.x, y: pointer.y + d.offset.y }
    if (l.type === 'directional') {
      const dir = sphereDirection(screenRay(p, s), layout.target, layout.sunRadius, d.near)
      app.updateLight(l.id, { direction: directionToCamera(app.doc.camera, e.shiftKey ? snapDirection(dir, SNAP) : dir) })
      return
    }
    // 按下或松开 Alt 时以当前位置为新的起点，灯不跳动
    if (e.altKey !== d.alt) {
      const at = projectToScreen(p, l.position)
      Object.assign(d, { alt: e.altKey, anchor: l.position, anchorY: e.clientY, offset: at ? { x: at.x - pointer.x, y: at.y - pointer.y } : d.offset })
      return
    }
    // Alt：沿视点到灯的方向前后移动，向上拖动时远离视点；屏幕上的位置不变
    const w = d.alt ? add(p.position, add(d.anchor, p.position, -1), Math.exp((e.clientY - d.anchorY) * -DEPTH_SPEED)) : planeHit(screenRay(p, s), d.anchor, p.back)
    const position = w && lampFromWorld(app.doc.camera, bg, layout.scale, w)
    if (position) app.updateLight(l.id, { position })
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  const guides: ReactNode[] = []
  const markers: ReactNode[] = []
  for (const l of layout.lights) {
    const at = projectToScreen(p, l.position)
    const light = lights.find((x) => x.id === l.id)
    if (!light) continue
    const active = l.id === selected
    const color = linearToHex(l.color)
    const opacity = l.enabled ? 1 : 0.45
    const stroke = active ? 'white' : 'rgba(0,0,0,0.7)'
    const r = active ? HANDLE + 2 : HANDLE

    if (l.type === 'point') {
      // 落到地面的投影线和投影圈，看出灯的高度和前后位置
      const foot: Vec3 = [l.position[0], 0, l.position[2]]
      guides.push(
        <g key={l.id} opacity={opacity * (active ? 0.9 : 0.55)} stroke={color} fill="none">
          <path d={path(p, [l.position, foot])} strokeWidth={1.5} strokeDasharray="4 4" />
          <path d={path(p, circle(foot, FOOT * layout.reference), true)} strokeWidth={1.5} />
        </g>,
      )
    } else if (active) {
      // 选中的太阳：球面的水平圈，光源落到水平圈所在平面的投影线，以及中心到投影的连线
      const flat: Vec3 = [l.position[0], layout.target[1], l.position[2]]
      guides.push(
        <g key={l.id} opacity={opacity * 0.7} stroke={color} fill="none">
          <path d={path(p, circle(layout.target, layout.sunRadius), true)} strokeWidth={1.2} />
          <path d={path(p, [l.position, flat])} strokeWidth={1.5} strokeDasharray="4 4" />
          <path d={path(p, [layout.target, flat])} strokeWidth={1} strokeOpacity={0.6} />
        </g>,
      )
    }
    if (!at) continue

    const common = {
      'data-testid': `view3d-light-${l.id}`,
      'data-kind': l.type,
      opacity,
      style: { cursor: 'move' } as const,
      onPointerDown: (e: ReactPointerEvent<SVGElement>) => begin(e, l, at),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
    }
    if (l.type === 'point') {
      markers.push(
        <g key={l.id} transform={`translate(${at.x} ${at.y})`} {...common}>
          {active && <circle r={r + 10} fill="none" stroke="white" strokeOpacity={0.5} strokeDasharray="4 3" />}
          <circle r={r + 5} fill={color} fillOpacity={0.25} />
          <rect x={-4} y={r - 2} width={8} height={6} rx={1.5} fill="#8a8a8a" stroke={stroke} strokeWidth={1} />
          <circle r={r} fill={color} stroke={stroke} strokeWidth={active ? 2.5 : 1.5} />
        </g>,
      )
      continue
    }
    // 太阳：箭头沿光线方向指向场景
    const toward = projectToScreen(p, add(l.position, l.direction, -0.2 * layout.sunRadius))
    const v = toward && { x: toward.x - at.x, y: toward.y - at.y }
    const len = v ? Math.hypot(v.x, v.y) : 0
    const deg = v ? (Math.atan2(v.y, v.x) * 180) / Math.PI : 0
    markers.push(
      <g key={l.id} transform={`translate(${at.x} ${at.y})`} {...common}>
        {active && <circle r={r + 10} fill="none" stroke="white" strokeOpacity={0.5} strokeDasharray="4 3" />}
        {len > 2 && (
          <g transform={`rotate(${deg})`} stroke={stroke} strokeWidth={1}>
            <line x1={r + 8} y1={0} x2={r + 30} y2={0} stroke={color} strokeWidth={3} strokeLinecap="round" />
            <path d={`M ${r + 28} -6 L ${r + 40} 0 L ${r + 28} 6 Z`} fill={color} />
          </g>
        )}
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i * Math.PI) / 4
          return <line key={i} x1={Math.cos(a) * (r + 2)} y1={Math.sin(a) * (r + 2)} x2={Math.cos(a) * (r + 7)} y2={Math.sin(a) * (r + 7)} stroke={color} strokeWidth={2} strokeLinecap="round" />
        })}
        <circle r={r} fill={color} stroke={stroke} strokeWidth={active ? 2.5 : 1.5} />
      </g>,
    )
  }

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="view3d-lights">
      <g>{guides}</g>
      <g style={{ pointerEvents: 'auto' }}>{markers}</g>
    </svg>
  )
}
