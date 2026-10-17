/**
 * 估计器 A：可见光源检测（docs/Plan.md §3.2）。
 *
 * 候选区域有两个来源：亮度高于 max(P99.5, 0.9·Lmax) 的连通域，以及 log 亮度多尺度 DoG 的局部极大值
 * （用于找到没有过曝、但明显比周围亮的小光源）。再按过曝比例、紧致度、与外环的反差和面积打分。
 * 颜色取过曝区外环中未过曝的像素，因为过曝区本身只剩白色。
 */
import { labelRegions, outerRing, type Region } from '@/algo/blobs'
import { normalizeColor } from '@/algo/color'
import { fastGaussianBlur, quantiles } from '@/algo/raster'
import type { Vec3 } from '@/algo/sh'
import type { Scene } from './scene'

export interface VisibleLight {
  /** 质心（分析分辨率像素） */
  x: number
  y: number
  /** 等效半径（像素） */
  radius: number
  inSky: boolean
  /** 区域内逆深度的 75% 分位 */
  depth: number
  color: Vec3
  confidence: number
}

const DOG_SIGMAS = [1, 2, 4, 8]
/** DoG 响应下限（log 亮度）：约比周围亮 2.2 倍 */
const DOG_MIN = 0.8
const MAX_SEEDS = 24
const MIN_SCORE = 0.45

/** 多尺度 DoG 的局部极大值：返回像素索引与对应尺度，按响应从高到低排列。 */
function dogSeeds(scene: Scene, minLuma: number): { index: number; sigma: number }[] {
  const { width: w, height: h, luma } = scene
  const log = Float32Array.from(luma, (v) => Math.log(v + 1e-3))
  const blurred = DOG_SIGMAS.map((s) => fastGaussianBlur(log, w, h, s))
  const dogs = DOG_SIGMAS.slice(0, -1).map((_, k) => blurred[k].map((v, i) => v - blurred[k + 1][i]))
  const seeds: { index: number; sigma: number; value: number }[] = []
  for (let k = 0; k < dogs.length; k++) {
    const d = dogs[k]
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const v = d[i]
        if (v < DOG_MIN || luma[i] < minLuma) continue
        if ((k > 0 && dogs[k - 1][i] > v) || (k < dogs.length - 1 && dogs[k + 1][i] > v)) continue
        let isMax = true
        for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && d[i + dy * w + dx] > v) isMax = false
        if (isMax) seeds.push({ index: i, sigma: DOG_SIGMAS[k], value: v })
      }
  }
  return seeds.sort((a, b) => b.value - a.value).slice(0, MAX_SEEDS)
}

/** 从种子出发，把亮度不低于种子一半、且在 3σ 半径内的相连像素加入遮罩。 */
function growSeed(scene: Scene, mask: Uint8Array, seed: number, sigma: number): void {
  const { width: w, height: h, luma } = scene
  const sx = seed % w
  const sy = (seed - sx) / w
  const r2 = (3 * sigma) ** 2
  const floor = luma[seed] * 0.5
  const stack = [seed]
  mask[seed] = 1
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || (xx - sx) ** 2 + (yy - sy) ** 2 > r2) continue
      const j = yy * w + xx
      if (!mask[j] && luma[j] >= floor) {
        mask[j] = 1
        stack.push(j)
      }
    }
  }
}

function mean(values: Float32Array, idx: Int32Array): number {
  let s = 0
  for (const i of idx) s += values[i]
  return idx.length ? s / idx.length : 0
}

function scoreRegion(scene: Scene, region: Region, labels: Int32Array, median: number): VisibleLight | null {
  const { width: w, height: h, luma, clipped, sky, depth, linear } = scene
  const area = region.pixels.length
  if (area < 2) return null
  const areaFrac = area / (w * h)
  if (areaFrac > 0.12) return null
  const radius = Math.sqrt(area / Math.PI)
  const ring = outerRing(region, labels, w, h, Math.max(2, Math.round(radius * 0.6)))

  let clippedCount = 0
  for (const i of region.pixels) clippedCount += clipped[i]
  const clippedFraction = clippedCount / area
  const bw = region.maxX - region.minX + 1
  const bh = region.maxY - region.minY + 1
  const compactness = Math.min(1, area / (bw * bh) / (Math.PI / 4)) * (Math.min(bw, bh) / Math.max(bw, bh))
  const inner = mean(luma, region.pixels)
  const outer = ring.length ? mean(luma, ring) : inner
  const contrast = inner / Math.max(outer, 1e-4)

  let score = 0.4 * clippedFraction + 0.3 * compactness + 0.3 * Math.min(1, Math.max(0, (contrast - 1) / 2))
  if (areaFrac > 0.04) score *= Math.max(0, 1 - (areaFrac - 0.04) / 0.08)
  if (inner < 4 * median) score *= 0.3

  const skyness = Math.max(mean(sky, region.pixels), mean(sky, ring))
  const depths = Float32Array.from(region.pixels, (i) => depth[i])
  const d75 = quantiles(depths, [0.75])![0]
  const inSky = skyness > 0.5 || d75 < 0.08
  // 天空里没有过曝的亮区多半是云
  if (inSky && clippedFraction < 0.3) return null
  if (score < MIN_SCORE) return null

  // 颜色：外环中未过曝、且足够亮的像素（光晕）；没有时退回区域平均色
  const sum = [0, 0, 0]
  let count = 0
  for (const i of ring) {
    if (clipped[i] || luma[i] < 0.3 * inner) continue
    for (let c = 0; c < 3; c++) sum[c] += linear[i * 3 + c]
    count++
  }
  if (count < 3) {
    for (const i of region.pixels) for (let c = 0; c < 3; c++) sum[c] += linear[i * 3 + c]
  }
  return { x: region.cx, y: region.cy, radius, inSky, depth: d75, color: normalizeColor(sum), confidence: Math.min(1, score) }
}

export function detectVisibleLights(scene: Scene, max = 4): VisibleLight[] {
  const { width: w, height: h, luma } = scene
  let lmax = 0
  for (const v of luma) lmax = Math.max(lmax, v)
  const [median, p995] = quantiles(luma, [0.5, 0.995])!
  const threshold = Math.max(p995, 0.9 * lmax)
  const mask = Uint8Array.from(luma, (v) => (v >= threshold && v > 0 ? 1 : 0))
  for (const s of dogSeeds(scene, 4 * median)) if (!mask[s.index]) growSeed(scene, mask, s.index, s.sigma)

  const { labels, regions } = labelRegions(mask, w, h)
  const found = regions.map((r) => scoreRegion(scene, r, labels, median)).filter((v): v is VisibleLight => v !== null)
  found.sort((a, b) => b.confidence - a.confidence)
  // 去掉与更高分候选重叠的区域
  const kept: VisibleLight[] = []
  for (const f of found) {
    if (kept.some((k) => Math.hypot(k.x - f.x, k.y - f.y) < k.radius + f.radius)) continue
    kept.push(f)
    if (kept.length >= max) break
  }
  return kept
}
