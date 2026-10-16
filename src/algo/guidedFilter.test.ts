import { describe, expect, it } from 'vitest'
import { applyGuided, guidedCoefficients, guidedFilter } from './guidedFilter'
import { boxMean, resizeBilinear } from './raster'

/** 引导图：x < edge 为深红，否则为浅灰 */
function stepGuide(w: number, h: number, edge: number) {
  const g = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const right = x >= edge
      g[i] = right ? 0.8 : 0.5
      g[i + 1] = right ? 0.8 : 0.05
      g[i + 2] = right ? 0.8 : 0.05
    }
  return g
}

describe('guided filter', () => {
  it('reduces to a box mean when the guide is flat', () => {
    const w = 16
    const h = 8
    const guide = new Float32Array(w * h * 3).fill(0.5)
    const p = Float32Array.from({ length: w * h }, (_, i) => (i % w) / w)
    const q = guidedFilter(guide, p, w, h, { radius: 2, eps: 1e-3 })
    const box = boxMean(boxMean(p, w, h, 2), w, h, 2)
    for (let i = 0; i < q.length; i++) expect(q[i]).toBeCloseTo(box[i], 4)
  })

  it('keeps an aligned edge sharp when coefficients are applied at a higher resolution', () => {
    // Fast Guided Filter：低分辨率求系数，双线性放大后与高分辨率引导图组合
    const w = 32
    const h = 16
    const guideLow = stepGuide(w, h, 16)
    const p = Float32Array.from({ length: w * h }, (_, i) => (i % w < 16 ? 0.9 : 0.1))
    const coef = guidedCoefficients(guideLow, p, w, h, { radius: 3, eps: 1e-3 })
    expect(applyGuided(coef, guideLow, w, h)).toEqual(guidedFilter(guideLow, p, w, h, { radius: 3, eps: 1e-3 }))
    const W = w * 4
    const H = h * 4
    const up = resizeBilinear(coef, w, h, W, H, 4)
    const q = applyGuided(up, stepGuide(W, H, 64), W, H)
    const row = 32 * W
    expect(q[row + 63]).toBeGreaterThan(0.8)
    expect(q[row + 64]).toBeLessThan(0.2)
  })
})
