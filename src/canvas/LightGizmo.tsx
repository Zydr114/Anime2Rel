import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { pixelToRay, rayToPixel } from '@/algo/camera'
import { linearToHex } from '@/algo/color'
import { docToScreen, screenToDoc, type Point, type Size } from '@/algo/geometry'
import { notify } from '@/app/notify'
import { t } from '@/i18n'
import { MAX_LIGHTS, newLightAt, type Light } from '@/lighting/model'
import { pickColor, sampleDepth } from '@/lighting/sampling'
import { getDepthResult } from '@/state/depth'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'

const HANDLE = 9
/** 方向光投影落在文档外这个比例以内时仍画在投影处，可以拖动；更远时画在画面边缘 */
const INSIDE_MARGIN = 0.1
/** 边缘指示器离文档边缘的距离（屏幕像素） */
const EDGE_INSET = 22

type Placement = { kind: 'point' | 'directional'; at: Point } | { kind: 'edge'; at: Point; angle: number } | null

/** 光源在屏幕上的位置：点光源在其位置；方向光在投影处，投影不在画面附近时在画面边缘，用箭头指示光的来向。 */
function placement(light: Light, doc: Size, fovDeg: number, toScreen: (p: Point) => Point): Placement {
  if (light.type === 'point') return { kind: 'point', at: toScreen(light.position) }
  const p = rayToPixel(light.direction, doc, fovDeg)
  const mx = doc.width * INSIDE_MARGIN
  const my = doc.height * INSIDE_MARGIN
  if (p && p.x >= -mx && p.x <= doc.width + mx && p.y >= -my && p.y <= doc.height + my) return { kind: 'directional', at: toScreen(p) }
  // 画面内方向（屏幕 y 向下）：从画面中心沿该方向找到与文档边框（内缩）的交点
  const dx = light.direction[0]
  const dy = -light.direction[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-3) return null
  const tl = toScreen({ x: 0, y: 0 })
  const br = toScreen({ x: doc.width, y: doc.height })
  const cx = (tl.x + br.x) / 2
  const cy = (tl.y + br.y) / 2
  const hw = Math.max(1, (br.x - tl.x) / 2 - EDGE_INSET)
  const hh = Math.max(1, (br.y - tl.y) / 2 - EDGE_INSET)
  const k = Math.min(hw / Math.abs(dx / len || 1e-9), hh / Math.abs(dy / len || 1e-9))
  return { kind: 'edge', at: { x: cx + (dx / len) * k, y: cy + (dy / len) * k }, angle: Math.atan2(dy, dx) }
}

interface Drag {
  id: number
  light: string
}

/** 光源步骤的画布控件：拖动点光源和画面内的方向光；添加光源、吸管工具的点击层。 */
export function LightGizmo({ passThrough }: { passThrough: boolean }) {
  const background = useApp((s) => s.doc.background)
  const lighting = useApp((s) => s.doc.lighting)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const selected = useLighting((s) => s.selected)
  const tool = useLighting((s) => s.tool)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)

  if (!background || step !== 'light') return null

  const toScreen = (p: Point) => docToScreen(view, p)
  const toDoc = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return screenToDoc(useApp.getState().view, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const interactive = passThrough ? 'none' : 'auto'

  const begin = (e: ReactPointerEvent<SVGElement>, light: Light, draggable: boolean) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useLighting.getState().select(light.id)
    if (!draggable) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    useApp.getState().beginGesture()
    dragRef.current = { id: e.pointerId, light: light.id }
  }

  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const s = useApp.getState()
    const bg = s.doc.background
    const light = s.doc.lighting.lights.find((l) => l.id === d.light)
    if (!bg || !light) return
    const p = toDoc(e)
    if (light.type === 'point') {
      const q = { x: Math.min(bg.width, Math.max(0, p.x)), y: Math.min(bg.height, Math.max(0, p.y)) }
      s.updateLight(light.id, { position: { ...q, depth: sampleDepth(getDepthResult(bg.id), q, bg).depth } })
    } else {
      s.updateLight(light.id, { direction: pixelToRay(p, bg, s.doc.lighting.fovDeg) })
    }
  }

  const end = (e: ReactPointerEvent<SVGElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    useApp.getState().endGesture()
  }

  // 添加 / 吸管：只在文档范围内响应点击，文档外仍可拖动平移
  const onToolClick = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const s = useApp.getState()
    const bg = s.doc.background
    if (!bg) return
    const p = toDoc(e)
    const l = useLighting.getState()
    if (l.tool === 'add') {
      const light = newLightAt(p, bg, s.doc.lighting.fovDeg, sampleDepth(getDepthResult(bg.id), p, bg))
      if (s.addLight(light)) l.select(light.id)
      else notify(t.light.full(MAX_LIGHTS))
    } else if (l.tool === 'pick' && l.selected) {
      const color = pickColor(bg.id, p, bg)
      if (color) s.updateLight(l.selected, { color, kelvin: null })
    }
    l.setTool('select')
  }

  const tl = toScreen({ x: 0, y: 0 })
  const br = toScreen({ x: background.width, y: background.height })
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end }

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="light-gizmo">
      {lighting.lights.map((light) => {
        const place = placement(light, background, lighting.fovDeg, toScreen)
        if (!place) return null
        const active = light.id === selected
        const color = linearToHex(light.color)
        const r = active ? HANDLE + 2 : HANDLE
        const common = {
          'data-testid': `light-handle-${light.id}`,
          'data-kind': place.kind,
          opacity: light.enabled ? 1 : 0.45,
          style: { pointerEvents: interactive, cursor: place.kind === 'edge' ? 'pointer' : 'move' } as const,
          onPointerDown: (e: ReactPointerEvent<SVGElement>) => begin(e, light, place.kind !== 'edge'),
          ...handlers,
        }
        const stroke = active ? 'white' : 'rgba(0,0,0,0.7)'
        if (place.kind === 'edge') {
          // 箭头指向画面中心，表示光从这一侧照进来
          const deg = (place.angle * 180) / Math.PI + 180
          return (
            <g key={light.id} transform={`translate(${place.at.x} ${place.at.y})`} {...common}>
              <circle r={r} fill={color} stroke={stroke} strokeWidth={active ? 2.5 : 1.5} />
              <path d={`M ${r + 3} -5 L ${r + 11} 0 L ${r + 3} 5 Z`} transform={`rotate(${deg})`} fill={color} stroke={stroke} strokeWidth={1} />
            </g>
          )
        }
        return (
          <g key={light.id} transform={`translate(${place.at.x} ${place.at.y})`} {...common}>
            {active && <circle r={r + 10} fill="none" stroke="white" strokeOpacity={0.5} strokeDasharray="4 3" />}
            {place.kind === 'directional' &&
              Array.from({ length: 8 }, (_, i) => {
                const a = (i * Math.PI) / 4
                return <line key={i} x1={Math.cos(a) * (r + 2)} y1={Math.sin(a) * (r + 2)} x2={Math.cos(a) * (r + 7)} y2={Math.sin(a) * (r + 7)} stroke={color} strokeWidth={2} strokeLinecap="round" />
              })}
            {place.kind === 'point' && <circle r={r + 5} fill={color} fillOpacity={0.25} />}
            <circle r={r} fill={color} stroke={stroke} strokeWidth={active ? 2.5 : 1.5} />
          </g>
        )
      })}
      {tool !== 'select' && (
        <rect
          x={tl.x}
          y={tl.y}
          width={Math.max(0, br.x - tl.x)}
          height={Math.max(0, br.y - tl.y)}
          fill="transparent"
          style={{ pointerEvents: interactive, cursor: tool === 'add' ? 'copy' : 'crosshair' }}
          onPointerDown={onToolClick}
          data-testid="light-tool-overlay"
        />
      )}
    </svg>
  )
}
