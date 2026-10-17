/**
 * 估计器 D：天空梯度（docs/Plan.md §3.2），以及阴天判定用的天空统计。
 *
 * 太阳附近的天空更亮。对天空像素拟合 log 亮度的线性平面，水平斜率指出太阳在左侧还是右侧。
 * 竖直方向的斜率还受“越靠近地平线越亮”的影响，只在它朝上时采用。
 */
import { normalizeColor } from '@/algo/kelvin'
import { robustLeastSquares } from '@/algo/linalg'
import type { Vec3 } from '@/algo/sh'
import type { Scene } from './scene'

export interface SkyStats {
  /** 天空占画面的比例 */
  fraction: number
  /** 天空线性亮度的变异系数（标准差 / 均值） */
  variation: number
  /** 天空平均线性亮度 */
  luma: number
  /** 天空平均颜色（最大分量为 1） */
  color: Vec3
}

export interface SkyGradientEstimate {
  /** 像平面内的方位角（弧度，y 向上，0 为右侧） */
  angle: number
  confidence: number
}

export function skyStats(scene: Scene): SkyStats {
  const n = scene.width * scene.height
  let total = 0
  for (const s of scene.sky) total += s
  const mask = scene.skyCore
  let count = 0
  let sum = 0
  let sum2 = 0
  const rgb = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const l = scene.luma[i]
    count++
    sum += l
    sum2 += l * l
    for (let c = 0; c < 3; c++) rgb[c] += scene.linear[i * 3 + c]
  }
  const m = count ? sum / count : 0
  const variation = count && m > 1e-6 ? Math.sqrt(Math.max(0, sum2 / count - m * m)) / m : 0
  return { fraction: total / n, variation, luma: m, color: count ? normalizeColor(rgb) : [1, 1, 1] }
}

export function estimateSkyGradient(scene: Scene): SkyGradientEstimate | null {
  const { width: w, height: h, luma } = scene
  const mask = scene.skyCore
  const long = Math.max(w, h)
  const idx: number[] = []
  const stride = Math.max(1, Math.floor((w * h) / 15_000))
  for (let i = 0; i < mask.length; i += stride) if (mask[i]) idx.push(i)
  const fraction = (idx.length * stride) / (w * h)
  if (fraction < 0.03 || idx.length < 100) return null

  const m = idx.length
  const rows = new Float64Array(m * 3)
  const y = new Float64Array(m)
  let minX = Infinity
  let maxX = -Infinity
  idx.forEach((i, k) => {
    const px = i % w
    const py = (i - px) / w
    const X = (px + 0.5 - w / 2) / long
    const Y = (h / 2 - py - 0.5) / long
    rows.set([1, X, Y], k * 3)
    y[k] = Math.log(luma[i] + 1e-4)
    minX = Math.min(minX, X)
    maxX = Math.max(maxX, X)
  })
  // 天空只占很窄的一条时，水平斜率不可靠
  if (maxX - minX < 0.25) return null
  const fit = robustLeastSquares(rows, y, new Float64Array(m).fill(1), 3)
  if (!fit) return null
  const gx = fit.beta[1]
  const gy = fit.beta[2]
  if (Math.abs(gx) < 1e-3) return null
  // 竖直分量至少取水平分量的 0.6 倍（太阳在地平线以上约 30°）
  const vy = Math.max(gy, 0.6 * Math.abs(gx))
  const confidence = 0.6 * Math.min(1, Math.abs(gx) / 0.5) * Math.min(1, fraction / 0.15) * (0.5 + 0.5 * fit.r2)
  return { angle: Math.atan2(vy, gx), confidence }
}
