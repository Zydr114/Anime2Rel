import { describe, expect, it } from 'vitest'
import { boxFilter, guideStats, SMOOTH_RADIUS, snapToEdges } from './regions'

describe('region edge snapping', () => {
  it('box filter averages over the window clipped to the image', () => {
    const out = boxFilter([1, 2, 3, 4], 4, 1, 1)
    expect(Array.from(out)).toEqual([1.5, 2, 3, 3.5])
  })

  // 引导图左暗右亮，边缘在 x = 32；带噪声，检验吸附不被纹理带偏
  const W = 64
  const guide = { width: W, height: W, data: new Uint8ClampedArray(W * W * 4) }
  for (let i = 0; i < W * W; i++) guide.data.fill((i % W < 32 ? 50 : 200) + ((i * 7919) % 21) - 10, i * 4, i * 4 + 3)
  const stats = guideStats(guide, SMOOTH_RADIUS)
  const stroke = (edge: number) => Float32Array.from({ length: W * W }, (_, i) => (i % W < edge ? 1 : 0))

  it('moves a stroke edge that overshoots or falls short onto the image edge', () => {
    for (const edge of [27, 37]) {
      const q = snapToEdges(stats, stroke(edge), 6)
      const row = (x: number) => q[32 * W + x]
      expect(row(29)).toBeGreaterThan(0.9)
      expect(row(30)).toBeGreaterThan(0.9)
      expect(row(33)).toBeLessThan(0.1)
      expect(row(35)).toBeLessThan(0.1)
    }
  })

  it('keeps the stroke where the edge is farther than the snapping band', () => {
    const q = snapToEdges(stats, stroke(44), 4)
    expect(q[32 * W + 38]).toBeGreaterThan(0.9)
    expect(q[32 * W + 50]).toBeLessThan(0.1)
  })
})
