import { useMemo } from 'react'
import type { RegionMask } from '@/focus/regions'
import { currentRegionMask } from '@/focus/service'
import { useFusion } from '@/state/fusion'
import { REGION_COLORS, regionColor, useRegionTool } from '@/state/regions'
import { useApp } from '@/state/store'
import { useView3dShown } from '@/state/view3d'
import { StrokeBrush } from './StrokeBrush'

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
  const step = useApp((s) => s.step)
  const { active, tool, size } = useRegionTool()
  const regionTool = useFusion((s) => s.tool === 'region')
  const view3d = useView3dShown()

  const regions = doc.focus.occlusion.regions
  const index = regions.findIndex((r) => r.id === active)
  const background = doc.background
  const visible = !!background && step === 'place' && regionTool && index >= 0 && !view3d
  const mask = visible ? currentRegionMask(doc) : null
  const overlay = useMemo(() => mask && tint(mask, index), [mask, index])

  if (!visible) return null
  return (
    <StrokeBrush
      passThrough={passThrough}
      doc={background}
      size={size}
      tool={tool}
      color={regionColor(index, 0.6)}
      overlay={overlay}
      onStroke={(stroke) => useApp.getState().addRegionStroke(regions[index].id, stroke)}
      testId="region"
    />
  )
}
