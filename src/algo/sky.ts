/**
 * 天空遮罩（docs/Plan.md §3.1）：逆深度接近 0、纹理少、位于画面上部的连通区域，
 * 再用引导滤波把二值遮罩贴合到原图边缘。
 */
import { guidedFilter } from './guidedFilter'
import { boxMean } from './raster'

export interface SkyOptions {
  /** 逆深度低于该值才可能是天空 */
  maxDepth: number
  /** 5×5 窗口亮度标准差低于该值才算“纹理少” */
  maxTexture: number
  /** 不接触上边缘的区域，需重心位于上方该比例内且面积足够大 */
  upperFraction: number
  minAreaFraction: number
  /** 引导滤波细化参数 */
  refineRadius: number
  refineEps: number
}

export const DEFAULT_SKY_OPTIONS: SkyOptions = {
  maxDepth: 0.1,
  maxTexture: 0.05,
  upperFraction: 0.45,
  minAreaFraction: 0.005,
  refineRadius: 6,
  refineEps: 1e-3,
}

/** 4 邻接连通域标记，返回标签图（0 为背景）和每个标签的统计。 */
export function labelComponents(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h)
  const stats: { area: number; sumY: number; touchesTop: boolean }[] = [{ area: 0, sumY: 0, touchesTop: false }]
  const stack = new Int32Array(w * h)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const label = stats.length
    const s = { area: 0, sumY: 0, touchesTop: false }
    stats.push(s)
    let sp = 0
    const visit = (j: number) => {
      if (mask[j] && !labels[j]) {
        labels[j] = label
        stack[sp++] = j
      }
    }
    visit(start)
    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      s.area++
      s.sumY += y
      if (y === 0) s.touchesTop = true
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (y > 0) visit(i - w)
      if (y < h - 1) visit(i + w)
    }
  }
  return { labels, stats }
}

/**
 * @param depth 归一化逆深度 [0,1]（引导分辨率）
 * @param guide 引导图 RGB [0,1]（同分辨率）
 * @returns 软遮罩 [0,1]
 */
export function skyMask(depth: Float32Array, guide: Float32Array, w: number, h: number, options: SkyOptions = DEFAULT_SKY_OPTIONS): Float32Array {
  const n = w * h
  const lum = new Float32Array(n)
  const lum2 = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * guide[i * 3] + 0.7152 * guide[i * 3 + 1] + 0.0722 * guide[i * 3 + 2]
    lum[i] = l
    lum2[i] = l * l
  }
  const m = boxMean(lum, w, h, 2)
  const m2 = boxMean(lum2, w, h, 2)
  const candidate = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const std = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]))
    candidate[i] = depth[i] <= options.maxDepth && std <= options.maxTexture ? 1 : 0
  }

  const { labels, stats } = labelComponents(candidate, w, h)
  const keep = stats.map((s) => s.area > 0 && (s.touchesTop || (s.area >= options.minAreaFraction * n && s.sumY / s.area < options.upperFraction * h)))
  const hard = new Float32Array(n)
  let any = false
  for (let i = 0; i < n; i++) {
    if (keep[labels[i]]) {
      hard[i] = 1
      any = true
    }
  }
  if (!any) return hard

  const soft = guidedFilter(guide, hard, w, h, { radius: options.refineRadius, eps: options.refineEps })
  for (let i = 0; i < n; i++) {
    // 明显较近的像素不可能是天空，防止细化时向前景渗出
    const v = depth[i] > options.maxDepth * 2 ? 0 : soft[i]
    soft[i] = Math.min(1, Math.max(0, v))
  }
  return soft
}
