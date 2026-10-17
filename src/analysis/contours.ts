/**
 * 估计器 C：遮挡轮廓法（Nillius & Eklundh 2001；Lopez-Moreno et al. 2010；docs/Plan.md §3.2）。
 *
 * 在深度不连续处，前景一侧的表面法线几乎落在像平面内，方向为指向背景的梯度反方向。
 * 对这些像素拟合 I = a + u·nx + v·ny，(u, v) 的方向即光在像平面内的方位。
 */
import { robustLeastSquares } from '@/algo/linalg'
import { gaussianBlur } from '@/algo/raster'
import { sample, type Scene } from './scene'

export interface ContourEstimate {
  /** 像平面内的方位角（弧度，y 向上，0 为右侧，逆时针为正） */
  angle: number
  /** 明暗调制幅度 |(u, v)| / a */
  strength: number
  confidence: number
  samples: number
}

/** 深度梯度（每像素）超过该值才算不连续 */
const EDGE_GRADIENT = 0.02
/** 沿梯度方向两侧 3 px 的深度差下限 */
const EDGE_JUMP = 0.06
/** 前景采样点到边缘的距离（像素） */
const INSET = 2.5
const MAX_SAMPLES = 6000

export function estimateContours(scene: Scene): ContourEstimate | null {
  const { width: w, height: h, luma, sky, clipped } = scene
  const depth = gaussianBlur(scene.depth, w, h, 1)
  const picked: { nx: number; ny: number; v: number }[] = []
  const stride = Math.max(1, Math.floor((w * h) / 200_000))
  for (let y = 4; y < h - 4; y++)
    for (let x = 4; x < w - 4; x += stride) {
      const i = y * w + x
      const gx = (depth[i + 1] - depth[i - 1]) / 2
      const gy = (depth[i + w] - depth[i - w]) / 2
      const g = Math.hypot(gx, gy)
      if (g < EDGE_GRADIENT) continue
      // 单位梯度指向更近（逆深度更大）的一侧，即前景
      const ux = gx / g
      const uy = gy / g
      const px = x + 0.5
      const py = y + 0.5
      const near = sample(depth, w, h, px + 3 * ux, py + 3 * uy)
      const far = sample(depth, w, h, px - 3 * ux, py - 3 * uy)
      if (near - far < EDGE_JUMP) continue
      const fx = px + INSET * ux
      const fy = py + INSET * uy
      const fi = Math.min(h - 1, Math.max(0, Math.floor(fy))) * w + Math.min(w - 1, Math.max(0, Math.floor(fx)))
      if (sky[fi] > 0.3 || clipped[fi]) continue
      // 前景外法线 = -梯度；换成 y 向上
      picked.push({ nx: -ux, ny: uy, v: sample(luma, w, h, fx, fy) })
    }
  if (picked.length < 60) return null

  const step = Math.max(1, Math.ceil(picked.length / MAX_SAMPLES))
  const s = picked.filter((_, i) => i % step === 0)
  const m = s.length
  const rows = new Float64Array(m * 3)
  const y = new Float64Array(m)
  s.forEach((p, i) => {
    rows.set([1, p.nx, p.ny], i * 3)
    y[i] = p.v
  })
  const fit = robustLeastSquares(rows, y, new Float64Array(m).fill(1), 3)
  if (!fit) return null
  const [a, u, v] = fit.beta
  if (a <= 1e-4) return null
  const strength = Math.hypot(u, v) / a

  // 法线方向的覆盖：全部朝同一侧时无法区分光照与反照率变化
  let mx = 0
  let my = 0
  for (const p of s) {
    mx += p.nx
    my += p.ny
  }
  const resultant = Math.hypot(mx, my) / m
  const coverage = 1 - resultant * resultant
  const confidence = Math.min(0.7, Math.min(1, strength / 0.6) * coverage * (0.5 + 0.5 * fit.r2) * Math.min(1, m / 300))
  return { angle: Math.atan2(v, u), strength, confidence, samples: m }
}
