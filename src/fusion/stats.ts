/**
 * 立绘融合的统计量（docs/Plan.md §3.3 (1)(4)）：背景白点、局部影调与色度、立绘自身的统计、背景噪声。
 * 都在低分辨率数据上计算，供颜色匹配求参数。
 */
import { luminance } from '@/algo/cat'
import { nearestKelvin, kelvinToRgb } from '@/algo/kelvin'
import { normalizeColor } from '@/algo/color'
import { boxMean } from '@/algo/raster'
import type { Vec3 } from '@/algo/sh'

/** Oklab 统计：明度分位点、a/b 均值与协方差、色度 P90 */
export interface LabStats {
  /** L 的 P1 / P50 / P99 */
  quantiles: [number, number, number]
  /** a、b 均值 */
  mean: [number, number]
  /** a/b 协方差：aa、ab、bb */
  cov: [number, number, number]
  chromaP90: number
  /** 参与统计的总权重 */
  weight: number
}

const BINS = 1024
const L_MAX = 1.2
const C_MAX = 0.5

function histQuantile(hist: Float64Array, total: number, q: number, max: number): number {
  const target = q * total
  let acc = 0
  for (let i = 0; i < hist.length; i++) {
    const next = acc + hist[i]
    if (next >= target && hist[i] > 0) return ((i + (target - acc) / hist[i]) / hist.length) * max
    acc = next
  }
  return max
}

/** 加权统计；lab 为 Oklab 交错数组。总权重过小时返回 null。 */
export function labStats(lab: Float32Array, weights: ArrayLike<number>): LabStats | null {
  const n = lab.length / 3
  const hl = new Float64Array(BINS)
  const hc = new Float64Array(BINS)
  let sw = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    const L = lab[i * 3]
    const a = lab[i * 3 + 1]
    const b = lab[i * 3 + 2]
    hl[Math.min(BINS - 1, Math.max(0, Math.floor((L / L_MAX) * BINS)))] += w
    hc[Math.min(BINS - 1, Math.floor((Math.hypot(a, b) / C_MAX) * BINS))] += w
    sw += w
    sa += w * a
    sb += w * b
  }
  if (sw < 1e-6) return null
  const ma = sa / sw
  const mb = sb / sw
  let caa = 0
  let cab = 0
  let cbb = 0
  for (let i = 0; i < n; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    const da = lab[i * 3 + 1] - ma
    const db = lab[i * 3 + 2] - mb
    caa += w * da * da
    cab += w * da * db
    cbb += w * db * db
  }
  return {
    quantiles: [histQuantile(hl, sw, 0.01, L_MAX), histQuantile(hl, sw, 0.5, L_MAX), histQuantile(hl, sw, 0.99, L_MAX)],
    mean: [ma, mb],
    cov: [caa / sw, cab / sw, cbb / sw],
    chromaP90: histQuantile(hc, sw, 0.9, C_MAX),
    weight: sw,
  }
}

/**
 * 背景白点：Shades-of-Gray（Finlayson & Trezzi 2004，p 范数），排除过曝和天空。
 * 草地、墙面等大面积有色区域会把估计拉向它们的颜色，所以再向普朗克轨迹上最近的色温收拢 70%。
 * 返回线性 sRGB（最大分量为 1）。
 */
export function whitePoint(linear: Float32Array, mask: ArrayLike<number>, p = 6): Vec3 {
  const sum = [0, 0, 0]
  let count = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    for (let c = 0; c < 3; c++) sum[c] += linear[i * 3 + c] ** p
    count++
  }
  if (count === 0) return [1, 1, 1]
  const sog = normalizeColor(sum.map((s) => (s / count) ** (1 / p)))
  const locus = kelvinToRgb(nearestKelvin(sog, 2000, 12000))
  return normalizeColor(locus.map((v, c) => 0.7 * v + 0.3 * sog[c]))
}

/**
 * 噪声标准差（Immerkær 1996 的拉普拉斯差分核，取中位数绝对值以抵抗边缘），按通道返回，
 * 单位为 sRGB 编码值 [0,1]。只统计梯度较小的一半像素（平坦区域）。
 */
export function noiseSigma(rgb: Float32Array, w: number, h: number): Vec3 {
  const result: number[] = []
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) ch[i] = rgb[i * 3 + c]
    // 平坦程度在平滑后的图上判断，避免与像素级噪声本身相关而低估
    const smooth = boxMean(ch, w, h, 2)
    const resp: number[] = []
    const grad: number[] = []
    for (let y = 2; y < h - 2; y++)
      for (let x = 2; x < w - 2; x++) {
        const v = (dx: number, dy: number) => ch[(y + dy) * w + x + dx]
        const lap = v(-1, -1) - 2 * v(0, -1) + v(1, -1) - 2 * v(-1, 0) + 4 * v(0, 0) - 2 * v(1, 0) + v(-1, 1) - 2 * v(0, 1) + v(1, 1)
        const s = (dx: number, dy: number) => smooth[(y + dy) * w + x + dx]
        resp.push(Math.abs(lap))
        grad.push(Math.abs(s(2, 0) - s(-2, 0)) + Math.abs(s(0, 2) - s(0, -2)))
      }
    if (resp.length === 0) {
      result.push(0)
      continue
    }
    const order = grad.map((g, i) => [g, i]).sort((a, b) => a[0] - b[0])
    const flat = order.slice(0, Math.max(1, order.length >> 1)).map(([, i]) => resp[i])
    flat.sort((a, b) => a - b)
    // 白噪声经过该核后标准差放大 6 倍；|N(0,σ)| 的中位数为 0.6745σ
    result.push(flat[flat.length >> 1] / 0.6745 / 6)
  }
  return result as Vec3
}

/** 相对亮度（线性） */
export function meanLuminance(linear: Float32Array, weights: ArrayLike<number>): number {
  let s = 0
  let sw = 0
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    s += w * luminance([linear[i * 3], linear[i * 3 + 1], linear[i * 3 + 2]])
    sw += w
  }
  return sw > 0 ? s / sw : 0
}
