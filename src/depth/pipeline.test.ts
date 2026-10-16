import { describe, expect, it } from 'vitest'
import { guideSize, modelInputSize, normalizeDepth, NEUTRAL_GRAY, postprocess, toGuide, toModelInput } from './pipeline'

describe('modelInputSize', () => {
  it('scales the short side to 518 and rounds the long side to a multiple of 14', () => {
    expect(modelInputSize(3072, 4096)).toEqual({ width: 518, height: 686 })
    expect(modelInputSize(4096, 3072)).toEqual({ width: 686, height: 518 })
    expect(modelInputSize(300, 300)).toEqual({ width: 518, height: 518 })
    expect(modelInputSize(1920, 1080)).toEqual({ width: 924, height: 518 })
  })

  it('caps very wide images at 3:1', () => {
    const s = modelInputSize(6000, 1000)
    expect(s.width).toBe(1554)
    expect(s.height % 14).toBe(0)
    expect(s.height).toBeLessThan(518)
  })
})

describe('guideSize', () => {
  it('limits the long edge without upscaling', () => {
    expect(guideSize(3072, 4096)).toEqual({ width: 768, height: 1024 })
    expect(guideSize(640, 480)).toEqual({ width: 640, height: 480 })
  })
})

describe('toGuide / toModelInput', () => {
  it('composites characters over neutral gray and lays out NCHW', () => {
    const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 0])
    const bg = toGuide(rgba, 'background')
    expect(Array.from(bg.alpha)).toEqual([1, 1])
    expect(bg.guide[4]).toBeCloseTo(1)
    const ch = toGuide(rgba, 'character')
    expect(Array.from(ch.alpha)).toEqual([1, 0])
    expect(ch.guide[3]).toBeCloseTo(NEUTRAL_GRAY / 255)
    expect(ch.guide[4]).toBeCloseTo(NEUTRAL_GRAY / 255)
    const t = toModelInput(ch.guide, { width: 2, height: 1 })
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229)
    expect(t[2]).toBeCloseTo((0 - 0.456) / 0.224)
  })
})

describe('normalizeDepth', () => {
  it('maps the 1st and 99th percentiles to 0 and 1', () => {
    const raw = Float32Array.from({ length: 1001 }, (_, i) => i)
    const n = normalizeDepth(raw)
    expect(n[10]).toBeCloseTo(0, 5)
    expect(n[990]).toBeCloseTo(1, 5)
    expect(n[0]).toBe(0)
    expect(n[1000]).toBe(1)
  })

  it('only counts opaque pixels for characters', () => {
    const raw = Float32Array.from([100, 100, 0, 1, 2])
    const alpha = Float32Array.from([0, 0, 1, 1, 1])
    const n = normalizeDepth(raw, alpha)
    expect(n[2]).toBeCloseTo(0, 1)
    expect(n[4]).toBeCloseTo(1, 1)
  })
})

describe('postprocess', () => {
  it('produces maps of the guide size with finite values', () => {
    const model = { width: 28, height: 14 }
    const raw = Float32Array.from({ length: 28 * 14 }, (_, i) => Math.floor(i / 28))
    const size = { width: 56, height: 28 }
    const { guide, alpha } = toGuide(new Uint8ClampedArray(56 * 28 * 4).fill(200), 'background')
    const out = postprocess('background', raw, model, undefined, { size, guide, alpha })
    expect(out.depth.length).toBe(56 * 28)
    expect(out.coef.length).toBe(56 * 28 * 4)
    expect(out.normal.length).toBe(56 * 28 * 4)
    expect(out.sky?.length).toBe(56 * 28)
    expect(out.depth.every((v) => v >= 0 && v <= 1)).toBe(true)
    // 越往下越近
    expect(out.depth[27 * 56 + 10]).toBeGreaterThan(out.depth[10])
  })
})
