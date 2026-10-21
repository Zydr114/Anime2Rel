import { useEffect, useRef } from 'react'
import { fitWithin } from '@/algo/geometry'
import { getAsset } from '@/state/assets'
import { cn } from './lib/cn'

/** 把已登记的图像资源画成缩略图；透明区域显示棋盘格。 */
export function BitmapThumb({ assetId, maxEdge = 160, className }: { assetId: string; maxEdge?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const asset = getAsset(assetId)
    if (!canvas || !asset) return
    const dpr = window.devicePixelRatio || 1
    const size = fitWithin(asset, maxEdge * dpr)
    canvas.width = size.width
    canvas.height = size.height
    canvas.style.width = `${size.width / dpr}px`
    canvas.style.height = `${size.height / dpr}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size.width, size.height)
    ctx.drawImage(asset.bitmap, 0, 0, size.width, size.height)
  }, [assetId, maxEdge])
  return (
    <canvas
      ref={ref}
      className={cn('rounded-lg', className)}
      style={{ background: 'repeating-conic-gradient(var(--a2r-checker-a) 0 25%, var(--a2r-checker-b) 0 50%) 0 0 / 12px 12px' }}
    />
  )
}
