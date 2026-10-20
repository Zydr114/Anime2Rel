import { useEffect, useRef } from 'react'
import { docToScreen, type Point, type ViewTransform } from '@/algo/geometry'
import { getAsset } from '@/state/assets'

/** 放大镜的直径（CSS 像素）与相对当前视图的放大倍数 */
const SIZE = 150
const ZOOM = 3
/** 放大镜离控制点的距离 */
const GAP = 28

export interface LoupeFocus {
  /** 正在拖动的控制点（文档坐标） */
  at: Point
  /** 一起画出的线（文档坐标），颜色与画布上一致 */
  lines: { a: Point; b: Point; color: string }[]
}

/** 拖动控制点时在旁边显示放大的照片和十字准星，便于对准照片中的细节 */
export function Loupe({ assetId, view, focus }: { assetId: string; view: ViewTransform; focus: LoupeFocus }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { at, lines } = focus

  useEffect(() => {
    const canvas = ref.current
    const bitmap = getAsset(assetId)?.bitmap
    const ctx = canvas?.getContext('2d')
    if (!canvas || !bitmap || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvas.height = Math.round(SIZE * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#1c1b1a'
    ctx.fillRect(0, 0, SIZE, SIZE)
    // 文档坐标 → 放大镜坐标
    const k = ZOOM * view.zoom
    const span = SIZE / k
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, at.x - span / 2, at.y - span / 2, span, span, 0, 0, SIZE, SIZE)
    const map = (p: Point) => [(p.x - at.x) * k + SIZE / 2, (p.y - at.y) * k + SIZE / 2] as const
    ctx.lineCap = 'round'
    for (const l of lines) {
      ctx.beginPath()
      ctx.moveTo(...map(l.a))
      ctx.lineTo(...map(l.b))
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.strokeStyle = l.color
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
    // 十字准星，中心留空，不挡住要对准的像素
    const c = SIZE / 2
    for (const [width, color] of [
      [3, 'rgba(0,0,0,0.6)'],
      [1, 'white'],
    ] as const) {
      ctx.beginPath()
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        ctx.moveTo(c + dx * 5, c + dy * 5)
        ctx.lineTo(c + dx * 18, c + dy * 18)
      }
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.stroke()
    }
  }, [assetId, at, lines, view.zoom])

  const p = docToScreen(view, at)
  const left = p.x - SIZE - GAP < 8 ? p.x + GAP : p.x - SIZE - GAP
  const top = p.y - SIZE - GAP < 8 ? p.y + GAP : p.y - SIZE - GAP
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute rounded-full border-2 border-white/80 shadow-lg"
      style={{ left, top, width: SIZE, height: SIZE }}
      data-testid="camera-loupe"
    />
  )
}
