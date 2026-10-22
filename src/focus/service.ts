/** 主线程侧的景深参数换算：从当前文档、深度结果和融合 Worker 的立绘信息得到着色器参数。 */
import { assetPixels } from '@/lighting/sampling'
import { getDepthResult } from '@/state/depth'
import { currentDepthEdit } from '@/state/depthEdit'
import { characterInfo } from '@/state/fusion'
import type { DocState } from '@/state/store'
import type { BrushStroke, OcclusionRegion } from './model'
import { focusParams, type FocusInputs, type FocusParams } from './params'
import { guideStats, maskSize, packMasks, regionCoverage, SMOOTH_RADIUS, type Guide, type GuideStats, type RegionMask } from './regions'

export function focusInputs(doc: DocState): FocusInputs {
  return {
    doc,
    background: getDepthResult(doc.background?.id),
    character: getDepthResult(doc.character?.id),
    info: characterInfo(doc),
    edit: currentDepthEdit(doc),
  }
}

/** 没有背景时返回 null */
export function currentFocusParams(doc: DocState): FocusParams | null {
  return doc.background ? focusParams(focusInputs(doc)) : null
}

// 区域遮罩只在笔画、背景或吸附开关变化时重算；每个区域的覆盖度按笔画列表缓存，改一个区域不重算其他区域
const coverageCache = new WeakMap<readonly BrushStroke[], { key: string; mask: Float32Array }>()
let statsCache: { key: string; stats: GuideStats } | null = null
let maskCache: { regions: readonly OcclusionRegion[]; key: string; mask: RegionMask } | null = null

/** 背景缩小图在 SMOOTH_RADIUS 下的统计量（边缘吸附用），按背景缓存一份，遮挡区域与局部调整的画笔蒙版共用 */
export function snapStats(backgroundId: string, guide: Guide): GuideStats {
  if (statsCache?.key !== backgroundId) statsCache = { key: backgroundId, stats: guideStats(guide, SMOOTH_RADIUS) }
  return statsCache.stats
}

/** 当前的遮挡区域遮罩；没有画过任何区域时为 null */
export function currentRegionMask(doc: DocState): RegionMask | null {
  const bg = doc.background
  const { regions, snap } = doc.focus.occlusion
  if (!bg || regions.every((r) => r.strokes.length === 0)) return null
  const guide = assetPixels(bg.id)
  const key = `${bg.id}|${snap && !!guide}`
  if (maskCache?.regions === regions && maskCache.key === key) return maskCache.mask
  const size = maskSize(bg, guide)
  const stats = snap && guide ? snapStats(bg.id, guide) : null
  const masks = regions.map((region) => {
    const cached = coverageCache.get(region.strokes)
    if (cached?.key === key) return cached.mask
    const mask = regionCoverage(region, bg, size, stats)
    coverageCache.set(region.strokes, { key, mask })
    return mask
  })
  const mask = packMasks(masks, size)
  maskCache = { regions, key, mask }
  return mask
}
