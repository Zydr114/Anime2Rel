import { describe, expect, it } from 'vitest'
import { labelComponents, skyMask } from './sky'

function noise(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 上方 40% 是平滑的亮天空（逆深度 0），下方是有纹理的地面，左下角有一块平滑但很近的暗区 */
function scene(w: number, h: number) {
  const rnd = noise(3)
  const guide = new Float32Array(w * h * 3)
  const depth = new Float32Array(w * h)
  const horizon = Math.round(h * 0.4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (y < horizon) {
        const v = 0.7 + 0.2 * (y / horizon)
        guide.set([v * 0.8, v * 0.9, v], i * 3)
        depth[i] = 0
      } else if (x < w * 0.2 && y > h * 0.8) {
        guide.set([0.1, 0.1, 0.1], i * 3)
        depth[i] = 0.9
      } else {
        const t = 0.3 + 0.4 * rnd()
        guide.set([t, t * 0.9, t * 0.7], i * 3)
        depth[i] = 0.3 + (0.7 * (y - horizon)) / (h - horizon)
      }
    }
  return { guide, depth, horizon }
}

describe('skyMask', () => {
  it('selects the smooth, distant region at the top', () => {
    const w = 80
    const h = 60
    const { guide, depth, horizon } = scene(w, h)
    const m = skyMask(depth, guide, w, h)
    const mean = (y0: number, y1: number) => {
      let s = 0
      for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) s += m[y * w + x]
      return s / ((y1 - y0) * w)
    }
    expect(mean(0, horizon - 3)).toBeGreaterThan(0.95)
    expect(mean(horizon + 3, h)).toBeLessThan(0.02)
  })

  it('returns an empty mask when nothing qualifies', () => {
    const w = 30
    const h = 20
    const guide = new Float32Array(w * h * 3).fill(0.5)
    const depth = new Float32Array(w * h).fill(0.6)
    expect(skyMask(depth, guide, w, h).every((v) => v === 0)).toBe(true)
  })
})

describe('labelComponents', () => {
  it('labels 4-connected regions and records whether they touch the top', () => {
    // 1 1 0 1
    // 0 1 0 1
    // 1 0 0 0
    const mask = Uint8Array.from([1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0])
    const { labels, stats } = labelComponents(mask, 4, 3)
    expect(stats.length).toBe(4)
    expect(labels[0]).toBe(labels[5])
    expect(labels[3]).toBe(labels[7])
    expect(labels[8]).not.toBe(labels[0])
    expect(stats[labels[8]].touchesTop).toBe(false)
    expect(stats[labels[0]]).toMatchObject({ area: 3, touchesTop: true })
  })
})
