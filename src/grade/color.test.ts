import { describe, expect, it } from 'vitest'
import { mat3Vec } from '@/algo/cat'
import { adjustPixel, applyContrast, applyWhitesBlacks, CURVE_SIZE, curveLut, HIGHLIGHTS_STOPS, HSL_CENTERS, hslWeights, MID_GRAY, sampleCurve, toneShift, whiteBalanceMatrix } from './color'
import { DEFAULT_ADJUST, IDENTITY_CURVE } from './model'
import { adjustParams } from './params'

describe('whiteBalanceMatrix', () => {
  it('is identity at neutral and keeps white luminance', () => {
    expect(whiteBalanceMatrix(0, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    const warm = mat3Vec(whiteBalanceMatrix(0.5, 0), [1, 1, 1])
    expect(warm[0]).toBeGreaterThan(1)
    expect(warm[2]).toBeLessThan(1)
    expect(0.2126 * warm[0] + 0.7152 * warm[1] + 0.0722 * warm[2]).toBeCloseTo(1, 2)
    const magenta = mat3Vec(whiteBalanceMatrix(0, 0.5), [1, 1, 1])
    expect(magenta[1]).toBeLessThan(Math.min(magenta[0], magenta[2]))
  })
})

describe('applyContrast', () => {
  it('keeps mid gray and white fixed and stays monotone', () => {
    for (const contrast of [-1, -0.4, 0.6, 1]) {
      expect(applyContrast(MID_GRAY, contrast)).toBeCloseTo(MID_GRAY, 6)
      expect(applyContrast(1, contrast)).toBeCloseTo(1, 6)
      let prev = 0
      for (let i = 1; i <= 200; i++) {
        // 对比度满格时白点以上的斜率为 0
        const v = applyContrast(2 ** (-12 + i * 0.07), contrast)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    }
    expect(applyContrast(0.5, 1)).toBeGreaterThan(0.5)
    expect(applyContrast(0.05, 1)).toBeLessThan(0.05)
  })

  it('whites and blacks stay monotone', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const v = applyWhitesBlacks(i / 100, -1, 1)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })
})

describe('toneShift', () => {
  it('lifts shadows and pulls highlights while keeping the base mapping monotone', () => {
    expect(toneShift(-3, 1, 0)).toBeGreaterThan(1)
    expect(toneShift(1, 1, 0)).toBe(0)
    expect(toneShift(2, 0, -1)).toBeCloseTo(-HIGHLIGHTS_STOPS, 6)
    expect(toneShift(-2, 0, -1)).toBe(0)
    for (const [shadows, highlights] of [[1, -1], [-1, 1], [1, 1], [-1, -1]]) {
      let prev = -Infinity
      for (let b = -10; b <= 4; b += 0.01) {
        const v = b + toneShift(b, shadows, highlights)
        expect(v).toBeGreaterThan(prev)
        prev = v
      }
    }
  })
})

describe('hslWeights', () => {
  it('sums to one and peaks at each band centre', () => {
    for (let h = 0; h < 360; h += 3.7) expect(hslWeights(h).reduce((a, b) => a + b)).toBeCloseTo(1, 6)
    HSL_CENTERS.forEach((c, i) => expect(hslWeights(c)[i]).toBeCloseTo(1, 6))
  })
})

describe('curveLut', () => {
  it('is identity for straight curves and applies master before channels', () => {
    const lut = curveLut({ master: IDENTITY_CURVE, r: IDENTITY_CURVE, g: IDENTITY_CURVE, b: IDENTITY_CURVE })
    for (const e of [0, 0.13, 0.5, 0.97, 1.3]) expect(sampleCurve(lut, e, 1)).toBeCloseTo(e, 4)
    const lifted = curveLut({ master: [[0, 0.2], [1, 1]], r: [[0, 0], [0.6, 0.3], [1, 1]], g: IDENTITY_CURVE, b: IDENTITY_CURVE })
    expect(lifted.data[1]).toBeCloseTo(0.2, 4)
    expect(lifted.data[0]).toBeLessThan(0.2)
    expect(lifted.data[(CURVE_SIZE - 1) * 4]).toBeCloseTo(1, 4)
  })
})

describe('adjustPixel', () => {
  it('returns the input when everything is neutral', () => {
    const p = adjustParams(DEFAULT_ADJUST)
    expect(p.active).toBe(false)
    for (const c of [[0.2, 0.5, 0.8], [0.9, 0.1, 0.05], [2, 1.5, 0.3]] as const) {
      adjustPixel([...c], p).forEach((v, i) => expect(v).toBeCloseTo(c[i], 4))
    }
  })

  it('exposure doubles linear values per stop', () => {
    const out = adjustPixel([0.1, 0.2, 0.3], adjustParams({ ...DEFAULT_ADJUST, exposure: 1 }))
    out.forEach((v, i) => expect(v).toBeCloseTo([0.2, 0.4, 0.6][i], 4))
  })

  it('negative saturation removes chroma', () => {
    const [r, g, b] = adjustPixel([0.8, 0.2, 0.1], adjustParams({ ...DEFAULT_ADJUST, saturation: -1 }))
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(1e-3)
  })
})
