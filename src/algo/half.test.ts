import { describe, expect, it } from 'vitest'
import { fromHalf, toHalf, toHalfArray } from './half'

describe('toHalf', () => {
  it('encodes exact values', () => {
    expect(toHalf(0)).toBe(0)
    expect(toHalf(-0)).toBe(0x8000)
    expect(toHalf(1)).toBe(0x3c00)
    expect(toHalf(-2)).toBe(0xc000)
    expect(toHalf(0.5)).toBe(0x3800)
    expect(toHalf(65504)).toBe(0x7bff)
    expect(toHalf(2 ** -24)).toBe(0x0001)
  })

  it('handles overflow, underflow and NaN', () => {
    expect(toHalf(1e6)).toBe(0x7c00)
    expect(toHalf(-1e6)).toBe(0xfc00)
    expect(toHalf(1e-10)).toBe(0)
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true)
  })

  it('round-trips within half precision', () => {
    const values = [0.1, 0.333, 3.14159, -7.25, 1234.5, 0.000123, 1e-6]
    for (const v of values) {
      const r = fromHalf(toHalf(v))
      expect(Math.abs(r - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -25))
    }
    expect(Array.from(toHalfArray(Float32Array.from([1, 0.5])))).toEqual([0x3c00, 0x3800])
  })
})
