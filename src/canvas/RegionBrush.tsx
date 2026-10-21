import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { docToScreen, screenToDoc, type Point } from '@/algo/geometry'
import type { RegionMask } from '@/focus/regions'
import { currentRegionMask } from '@/focus/service'
import { useFusion } from '@/state/fusion'
import { REGION_COLORS, regionColor, useRegionTool } from '@/state/regions'
import { useApp } from '@/state/store'
import { useView3dShown } from '@/state/view3d'

/** 区域着色的不透明度：正在编辑的区域与其他区域 */
const ACTIVE_ALPHA = 0.55
const OTHER_ALPHA = 0.25

/** 区域遮罩着色成一张图：后面的区域覆盖前面的，与合成时一致 */
function tint(mask: RegionMask, active: number): ImageData {
  const { width, height, masks } = mask
  const img = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    let rest = 1
    const rgba = [0, 0, 0, 0]
    for (let k = masks.length - 1; k >= 0; k--) {
      const w = masks[k][i] * rest
      rest *= 1 - masks[k][i]
      const a = w * (k === active ? ACTIVE_ALPHA : OTHER_ALPHA)
      for (let c = 0; c < 3; c++) rgba[c] += REGION_COLORS[k % REGION_COLORS.length][c] * a
      rgba[3] += a
    }
    if (rgba[3] <= 0) continue
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = rgba[c] / rgba[3]
    img.data[i * 4 + 3] = rgba[3] * 255
  }
  return img
}

/** 摆放步骤的遮挡区域画笔：选用遮挡工具并选中区域时在画布上涂抹（一笔一次撤销），并用颜色标出各区域。 */
export function RegionBrush({ passThrough }: { passThrough: boolean }) {
  const doc = useApp((s) => s.doc)
  const view = useApp((s) => s.view)
  const step = useApp((s) => s.step)
  const { active, tool, size } = useRegionTool()
  const regionTool = useFusion((s) => s.tool === 'region')
  const view3d = useView3dShown()
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokeRef = useRef<{ id: number; points: number[] } | null>(null)
  const [stroke, setStroke] = useState<number[] | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)

  const regions = doc.focus.occlusion.regions
  const index = regions.findIndex((r) => r.id === active)
  const background = doc.background
  const visible = !!background && step === 'place' && regionTool && index >= 0 && !view3d
  const mask = visible ? currentRegionMask(doc) : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !mask) return
    canvas.width = mask.width
    canvas.height = mask.height
    canvas.getContext('2d')?.putImageData(tint(mask, index), 0, 0)
  }, [mask, index])

  if (!visible) return null

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
    useApp.getState().addRegionStroke(regions[index].id, { erase: tool === 'eraser', radius, points: s.points })
  }

  const tl = docToScreen(view, { x: 0, y: 0 })
  const br = docToScreen(view, { x: background.width, y: background.height })
  const path = stroke && stroke.map((v, i) => (i % 2 === 0 ? `${i ? 'L' : 'M'} ${view.panX + v * view.zoom}` : `${view.panY + v * view.zoom}`)).join(' ')
  const color = tool === 'eraser' ? 'rgba(255, 255, 255, 0.5)' : regionColor(index, 0.6)
  const at = cursor && docToScreen(view, cursor)

  return (
    <>
      {mask && (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute"
          style={{ left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y }}
          data-testid="region-overlay"
        />
      )}
      <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="region-brush">
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
          data-testid="region-canvas"
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
