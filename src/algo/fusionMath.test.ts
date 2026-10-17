import { describe, expect, it } from 'vitest'
import { adaptationMatrix, mat3Inverse, mat3Mul, mat3Vec, IDENTITY3 } from './cat'
import { evalCurve, monotoneCurve } from './curve'
import { distanceTransform } from './edt'
import { kelvinToRgb } from './kelvin'
import { linearToOklab, oklabToLinear } from './oklab'

describe('oklab', () => {
  it('maps white to L = 1 with no chroma and round-trips', () => {
    const [L, a, b] = linearToOklab(1, 1, 1)
    expect(L).toBeCloseTo(1, 4)
    expect(Math.hypot(a, b)).toBeLessThan(1e-4)
    for (const c of [[0.2, 0.5, 0.8], [0.9, 0.1, 0.05], [0.01, 0.02, 0.03]]) {
      const back = oklabToLinear(...linearToOklab(c[0], c[1], c[2]))
      back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 5))
    }
  })
})

describe('adaptationMatrix', () => {
  it('maps the source white to the destination white and keeps luminance', () => {
    expect(adaptationMatrix([1, 1, 1], [1, 1, 1]).every((v, i) => Math.abs(v - IDENTITY3[i]) < 1e-6)).toBe(true)
    const warm = kelvinToRgb(3200)
    const m = adaptationMatrix([1, 1, 1], warm)
    const out = mat3Vec(m, [1, 1, 1])
    const k = out[1] / warm[1]
    out.forEach((v, i) => expect(v / k).toBeCloseTo(warm[i], 3))
    expect(0.2126729 * out[0] + 0.7151522 * out[1] + 0.072175 * out[2]).toBeCloseTo(1, 3)
    expect(mat3Mul(m, mat3Inverse(m)).every((v, i) => Math.abs(v - IDENTITY3[i]) < 1e-9)).toBe(true)
  })
})

describe('monotoneCurve', () => {
  it('passes through the points, stays monotone and extends linearly', () => {
    const c = monotoneCurve([0.1, 0.5, 0.9], [0.05, 0.3, 0.95])
    expect(evalCurve(c, 0.1)).toBeCloseTo(0.05)
    expect(evalCurve(c, 0.5)).toBeCloseTo(0.3)
    expect(evalCurve(c, 0.9)).toBeCloseTo(0.95)
    let prev = -Infinity
    for (let x = -0.2; x <= 1.2; x += 0.01) {
      const y = evalCurve(c, x)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = y
    }
  })
})

describe('distanceTransform', () => {
  it('matches brute force', () => {
    const w = 23
    const h = 17
    const mask = Array.from({ length: w * h }, (_, i) => ((i * 7919) % 13 < 11 ? 1 : 0))
    const d = distanceTransform(mask, w, h)
    for (let i = 0; i < w * h; i++) {
      let best = Infinity
      for (let j = 0; j < w * h; j++) if (!mask[j]) best = Math.min(best, Math.hypot((i % w) - (j % w), Math.floor(i / w) - Math.floor(j / w)))
      expect(d[i]).toBeCloseTo(best, 4)
    }
    expect(distanceTransform([1, 1, 1, 1], 2, 2)[0]).toBe(Infinity)
  })
})
