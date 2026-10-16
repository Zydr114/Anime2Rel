import { describe, expect, it } from 'vitest'
import { boxMean, gaussianBlur, maskedGaussianBlur, quantiles, resizeBilinear } from './raster'

function random(n: number, seed = 1) {
  let s = seed
  return Float32Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  })
}

describe('resizeBilinear', () => {
  it('keeps constants and identity size', () => {
    const src = new Float32Array(12).fill(0.25)
    expect(Array.from(resizeBilinear(src, 4, 3, 9, 7))).toEqual(new Array(63).fill(0.25))
    const r = random(20)
    expect(resizeBilinear(r, 5, 4, 5, 4)).toEqual(r)
  })

  it('reproduces a linear ramp in the interior', () => {
    const src = Float32Array.from({ length: 8 }, (_, i) => i)
    const up = resizeBilinear(src, 8, 1, 16, 1)
    // 目标像素中心 x' 对应源坐标 (x'+0.5)/2-0.5
    for (let x = 2; x < 14; x++) expect(up[x]).toBeCloseTo((x + 0.5) / 2 - 0.5, 5)
  })

  it('handles interleaved channels', () => {
    const src = Float32Array.from([1, 10, 3, 30])
    const up = resizeBilinear(src, 2, 1, 2, 1, 2)
    expect(Array.from(up)).toEqual([1, 10, 3, 30])
  })
})

describe('boxMean', () => {
  it('matches a naive implementation, including borders', () => {
    const w = 13
    const h = 9
    const r = 3
    const src = random(w * h, 7)
    const fast = boxMean(src, w, h, r)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        let n = 0
        for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++)
          for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
            s += src[j * w + i]
            n++
          }
        expect(fast[y * w + x]).toBeCloseTo(s / n, 5)
      }
    }
  })

  it('works when the radius exceeds the image', () => {
    const src = Float32Array.from([1, 2, 3, 4])
    expect(Array.from(boxMean(src, 2, 2, 10))).toEqual([2.5, 2.5, 2.5, 2.5])
  })
})

describe('gaussianBlur', () => {
  it('preserves constants and the mean of a symmetric impulse', () => {
    const c = gaussianBlur(new Float32Array(100).fill(3), 10, 10, 2)
    for (const v of c) expect(v).toBeCloseTo(3, 5)
    const imp = new Float32Array(21 * 21)
    imp[10 * 21 + 10] = 1
    const b = gaussianBlur(imp, 21, 21, 1.5)
    expect(b.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 4)
    expect(b[10 * 21 + 9]).toBeCloseTo(b[10 * 21 + 11], 6)
  })

  it('does not leak values from outside the mask', () => {
    const w = 20
    const src = Float32Array.from({ length: w }, (_, x) => (x < 10 ? 1 : 100))
    const mask = Float32Array.from({ length: w }, (_, x) => (x < 10 ? 1 : 0))
    const b = maskedGaussianBlur(src, mask, w, 1, 3)
    for (let x = 0; x < 10; x++) expect(b[x]).toBeCloseTo(1, 5)
  })
})

describe('quantiles', () => {
  it('interpolates between ranks and honours the mask', () => {
    const v = Float32Array.from([5, 1, 4, 2, 3])
    expect(quantiles(v, [0, 0.5, 1])).toEqual([1, 3, 5])
    expect(quantiles(v, [0.25])![0]).toBeCloseTo(2)
    expect(quantiles(v, [0, 1], [1, 0, 1, 0, 0])).toEqual([4, 5])
    expect(quantiles(v, [0.5], [0, 0, 0, 0, 0])).toBeNull()
  })
})
