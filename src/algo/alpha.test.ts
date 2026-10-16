import { describe, expect, it } from 'vitest'
import { analyzeAlpha } from './alpha'

const make = (alphas: number[]) => {
  const a = new Uint8ClampedArray(alphas.length * 4)
  alphas.forEach((v, i) => (a[i * 4 + 3] = v))
  return a
}

describe('analyzeAlpha', () => {
  it('treats fully opaque images as having no transparency', () => {
    expect(analyzeAlpha(make(new Array(1000).fill(255))).hasTransparency).toBe(false)
  })

  it('detects transparent backgrounds', () => {
    const info = analyzeAlpha(make([...new Array(500).fill(0), ...new Array(500).fill(255)]))
    expect(info.transparentRatio).toBeCloseTo(0.5)
    expect(info.hasTransparency).toBe(true)
  })

  it('ignores a handful of stray translucent pixels', () => {
    expect(analyzeAlpha(make([...new Array(2).fill(100), ...new Array(998).fill(255)])).hasTransparency).toBe(false)
  })

  it('handles empty input', () => {
    expect(analyzeAlpha(new Uint8ClampedArray(0)).hasTransparency).toBe(false)
  })
})
