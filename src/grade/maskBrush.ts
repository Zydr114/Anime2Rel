/**
 * 局部调整的画笔蒙版（docs/Plan.md §3.7 M8.8b）：与遮挡区域相同，在背景的缩小图（长边不超过 1024 px）上栅格化笔画，按需吸附到背景的边缘。
 * 8 项打包在两张 RGBA8 中，第 i 项在第 i >> 2 张的第 i & 3 个通道；不是画笔形状的项为 0。
 */
import type { Size } from '@/algo/geometry'
import type { BrushStroke } from '@/focus/model'
import { maskSize, strokeCoverage } from '@/focus/regions'
import { snapStats } from '@/focus/service'
import { assetPixels } from '@/lighting/sampling'
import type { DocState } from '@/state/store'
import { hasBrush, MAX_MASKS, type LocalMask } from './mask'

export interface BrushMasks extends Size {
  /** 两张 RGBA8，首行在上 */
  data: readonly [Uint8Array, Uint8Array]
}

/** 参与计算的笔画，以及是否吸附边缘；不是画笔形状（或没画过）的项为 null */
type Source = { strokes: readonly BrushStroke[]; snap: boolean } | null

const coverageCache = new WeakMap<readonly BrushStroke[], { key: string; mask: Float32Array }>()
let cache: { key: string; sources: Source[]; result: BrushMasks } | null = null

const sameSources = (a: readonly Source[], b: readonly Source[]) => a.length === b.length && a.every((s, i) => s?.strokes === b[i]?.strokes && s?.snap === b[i]?.snap)

const source = (m: LocalMask): Source => (m.shape === 'brush' && hasBrush(m) ? { strokes: m.strokes, snap: m.snap } : null)

/** 当前的画笔蒙版；没有画过的画笔形状时为 null。只在笔画、吸附开关或背景变化时重新打包，每项的覆盖度按笔画列表缓存 */
export function currentBrushMasks(doc: DocState): BrushMasks | null {
  const bg = doc.background
  const sources = doc.masks.slice(0, MAX_MASKS).map(source)
  if (!bg || sources.every((s) => !s)) return null
  const guide = assetPixels(bg.id)
  const key = `${bg.id}|${!!guide}`
  if (cache?.key === key && sameSources(cache.sources, sources)) return cache.result
  const size = maskSize(bg, guide)
  const n = size.width * size.height
  const data = [new Uint8Array(n * 4), new Uint8Array(n * 4)] as const
  sources.forEach((s, i) => {
    if (!s) return
    const snap = s.snap && !!guide
    const k = `${key}|${snap}`
    let coverage = coverageCache.get(s.strokes)
    if (coverage?.key !== k) {
      coverage = { key: k, mask: strokeCoverage(s.strokes, bg, size, snap ? snapStats(bg.id, guide!) : null) }
      coverageCache.set(s.strokes, coverage)
    }
    const target = data[i >> 2]
    const c = i & 3
    for (let j = 0; j < n; j++) target[j * 4 + c] = Math.round(coverage.mask[j] * 255)
  })
  const result = { ...size, data }
  cache = { key, sources, result }
  return result
}
