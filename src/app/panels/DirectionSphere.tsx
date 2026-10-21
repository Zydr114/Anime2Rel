import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { linearToHex, linearToSrgb } from '@/algo/color'
import { shade } from '@/algo/shading'
import type { Vec3 } from '@/algo/sh'
import { fromGround, toGround } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import type { Light } from '@/lighting/model'
import type { BallPreview } from '@/lighting/preview'

const SIZE = 184
const RADIUS = 80
const HANDLE = 7

interface Props {
  /** 球按地面摆正：横线是地平线，上方是天空 */
  camera: Pick<CameraDoc, 'pitch' | 'roll'>
  lights: Light[]
  preview: BallPreview | null
  selected: string | null
  onSelect: (id: string) => void
  /** 拖动方向光：phase 为 start/end 时开始/结束一次连续操作 */
  onDirection: (id: string, direction: Vec3, phase: 'start' | 'move' | 'end') => void
}

/** 球面上 (x, y)（y 向上）→ 单位方向，z 的符号沿用 hemisphere；超出圆盘时贴到边缘。 */
function directionAt(x: number, y: number, hemisphere: number): Vec3 {
  const r = Math.hypot(x, y)
  if (r >= 1) return [x / r, y / r, 0]
  return [x, y, hemisphere * Math.sqrt(1 - r * r)]
}

/**
 * 光照方向球：按灰球预览的光照着色的球面，方向光显示为可拖动的圆点（空心表示背光），
 * 点光源显示为它在灰球处的方向（菱形，不可拖动）。
 * 球按地面摆正（docs/Plan.md §3.7 M8.6a）：从水平方向看过去，与相机的俯仰和倾斜无关；球面上的 (x, y, z) 是地面坐标系的分量。
 */
export function DirectionSphere({ camera, lights, preview, selected, onSelect, onDirection }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: number; light: string; hemisphere: number } | null>(null)

  const { pitch, roll } = camera
  // 球面着色与画布上的灰球一致，只是转到了地面坐标系
  useEffect(() => {
    const orientation = { pitch, roll }
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const px = Math.round(RADIUS * 2 * dpr)
    canvas.width = px
    canvas.height = px
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(px, px)
    const ambient = preview?.ambient ?? new Float64Array(27)
    const shadeLights = preview?.lights ?? []
    for (let j = 0; j < px; j++)
      for (let i = 0; i < px; i++) {
        const x = ((i + 0.5) / px) * 2 - 1
        const y = 1 - ((j + 0.5) / px) * 2
        const r2 = x * x + y * y
        if (r2 > 1) continue
        const c = shade(fromGround(orientation, [x, y, Math.sqrt(1 - r2)]), ambient, shadeLights)
        const o = (j * px + i) * 4
        img.data[o] = Math.round(linearToSrgb(c[0]) * 255)
        img.data[o + 1] = Math.round(linearToSrgb(c[1]) * 255)
        img.data[o + 2] = Math.round(linearToSrgb(c[2]) * 255)
        // 边缘 1 px 抗锯齿
        img.data[o + 3] = Math.round(Math.min(1, (1 - Math.sqrt(r2)) * px * 0.5) * 255)
      }
    ctx.putImageData(img, 0, 0)
  }, [preview, pitch, roll])

  const toSphere = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left - SIZE / 2) / RADIUS, y: (SIZE / 2 - (e.clientY - rect.top)) / RADIUS }
  }

  const begin = (e: ReactPointerEvent<SVGElement>, light: Light) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    svgRef.current!.setPointerCapture(e.pointerId)
    onSelect(light.id)
    const hemisphere = toGround(camera, light.direction)[2] < 0 ? -1 : 1
    dragRef.current = { id: e.pointerId, light: light.id, hemisphere }
    onDirection(light.id, light.direction, 'start')
    return hemisphere
  }

  // 在球面空白处按下：把选中的方向光移到该点并继续拖动
  const onBackground = (e: ReactPointerEvent<SVGSVGElement>) => {
    const light = lights.find((l) => l.id === selected && l.type === 'directional')
    if (!light) return
    const hemisphere = begin(e, light)
    if (hemisphere === undefined) return
    const p = toSphere(e)
    onDirection(light.id, fromGround(camera, directionAt(p.x, p.y, hemisphere)), 'move')
  }

  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const p = toSphere(e)
    onDirection(d.light, fromGround(camera, directionAt(p.x, p.y, d.hemisphere)), 'move')
  }

  const end = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    const l = lights.find((x) => x.id === d.light)
    if (l) onDirection(d.light, l.direction, 'end')
  }

  const at = (v: Vec3) => ({ x: SIZE / 2 + v[0] * RADIUS, y: SIZE / 2 - v[1] * RADIUS })
  const pointMarkers = preview
    ? preview.ids.map((id, i) => ({ light: lights.find((l) => l.id === id), d: toGround(camera, preview.lights[i].direction) })).filter((m) => m.light?.type === 'point')
    : []

  return (
    <div className="relative mx-auto" style={{ width: SIZE, height: SIZE }}>
      <canvas ref={canvasRef} className="absolute" style={{ left: SIZE / 2 - RADIUS, top: SIZE / 2 - RADIUS, width: RADIUS * 2, height: RADIUS * 2 }} />
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        className="absolute inset-0 touch-none overflow-visible text-on-surface"
        onPointerDown={onBackground}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        data-testid="light-sphere"
      >
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} />
        <line x1={SIZE / 2 - RADIUS} y1={SIZE / 2} x2={SIZE / 2 + RADIUS} y2={SIZE / 2} stroke="currentColor" strokeOpacity={0.12} />
        <line x1={SIZE / 2} y1={SIZE / 2 - RADIUS} x2={SIZE / 2} y2={SIZE / 2 + RADIUS} stroke="currentColor" strokeOpacity={0.12} />
        {pointMarkers.map(({ light, d }) => {
          const p = at(d)
          const s = light!.id === selected ? HANDLE : HANDLE - 2
          return (
            <rect
              key={light!.id}
              x={p.x - s / 2}
              y={p.y - s / 2}
              width={s}
              height={s}
              transform={`rotate(45 ${p.x} ${p.y})`}
              fill={linearToHex(light!.color)}
              stroke={light!.id === selected ? 'white' : 'black'}
              strokeOpacity={0.8}
              opacity={d[2] < 0 ? 0.5 : 1}
              onPointerDown={(e) => {
                e.stopPropagation()
                onSelect(light!.id)
              }}
            />
          )
        })}
        {lights
          .filter((l) => l.type === 'directional')
          .map((l) => {
            const g = toGround(camera, l.direction)
            const p = at(g)
            const active = l.id === selected
            const back = g[2] < 0
            const color = linearToHex(l.color)
            return (
              <circle
                key={l.id}
                cx={p.x}
                cy={p.y}
                r={active ? HANDLE + 1 : HANDLE - 1}
                fill={back ? 'rgba(0,0,0,0.35)' : color}
                stroke={back ? color : active ? 'white' : 'black'}
                strokeWidth={back || active ? 2.5 : 1}
                opacity={l.enabled ? 1 : 0.45}
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => begin(e, l)}
                data-testid={`light-sphere-handle-${l.id}`}
              />
            )
          })}
      </svg>
    </div>
  )
}
