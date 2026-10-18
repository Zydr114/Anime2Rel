import { describe, expect, it } from 'vitest'
import { linearToOklab } from '@/algo/oklab'
import { LUMA } from './color'
import { applySplitToning, applyWheels, creativeParams, hueDirection } from './creative'
import { DEFAULT_CREATIVE, type CreativeGrade } from './model'

const withWheels = (wheels: Partial<CreativeGrade['wheels']>): CreativeGrade => ({ ...DEFAULT_CREATIVE, wheels: { ...DEFAULT_CREATIVE.wheels, ...wheels } })

describe('creative grading', () => {
  it('is identity when neutral', () => {
    const p = creativeParams(DEFAULT_CREATIVE)
    expect(p.active).toBe(false)
    applyWheels([0.1, 0.5, 0.9], p).forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.5, 0.9][i], 6))
    applySplitToning([0.02, 0.3, 0.7], p).forEach((v, i) => expect(v).toBeCloseTo([0.02, 0.3, 0.7][i], 5))
  })

  it('hue directions carry no luminance', () => {
    for (let h = 0; h < 360; h += 30) {
      const d = hueDirection(h)
      expect(d[0] * LUMA[0] + d[1] * LUMA[1] + d[2] * LUMA[2]).toBeCloseTo(0, 6)
      expect(Math.max(...d.map(Math.abs))).toBeCloseTo(1, 6)
    }
    const warm = hueDirection(60)
    expect(warm[0]).toBeGreaterThan(warm[2])
  })

  it('lift raises black and keeps white; gain scales white', () => {
    const lift = creativeParams(withWheels({ lift: { hue: 0, amount: 0, luma: 1 } }))
    expect(applyWheels([0, 0, 0], lift)[1]).toBeGreaterThan(0.1)
    expect(applyWheels([1, 1, 1], lift)[1]).toBeCloseTo(1, 6)
    const gain = creativeParams(withWheels({ gain: { hue: 0, amount: 0, luma: -1 } }))
    expect(applyWheels([1, 1, 1], gain)[1]).toBeCloseTo(2 ** -0.5, 6)
    expect(applyWheels([0, 0, 0], gain)[1]).toBe(0)
  })

  it('split toning tints shadows towards the chosen hue without changing lightness', () => {
    const p = creativeParams({ ...DEFAULT_CREATIVE, split: { ...DEFAULT_CREATIVE.split, shadow: { hue: 230, amount: 1 } } })
    const dark: [number, number, number] = [0.05, 0.05, 0.05]
    const [L0] = linearToOklab(...dark)
    const [L, a, b] = linearToOklab(...applySplitToning(dark, p))
    expect(L).toBeCloseTo(L0, 4)
    const hue = (Math.atan2(b, a) * 180) / Math.PI + 360
    expect(hue % 360).toBeCloseTo(230, 0)
    const white = applySplitToning([1, 1, 1], p)
    white.forEach((v) => expect(v).toBeCloseTo(1, 2))
  })
})
