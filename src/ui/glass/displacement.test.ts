import { describe, expect, it } from 'vitest'
import { displacementMap, edgeDistance, opticsFor, refractionOffset } from './displacement'

describe('liquid glass displacement map', () => {
  const shape = { width: 120, height: 80, radius: 24, exponent: 4 }
  const { data, scale } = displacementMap(shape)
  const at = (x: number, y: number) => Array.from(data.subarray((y * shape.width + x) * 4, (y * shape.width + x) * 4 + 3))

  it('samples from inside near the edges and leaves the middle untouched', () => {
    expect(scale).toBeGreaterThan(4)
    expect(at(60, 40)).toEqual([128, 128, 0])
    // 左边缘向右取样（R > 128），上边缘向下取样（G > 128），右下角两者都向内
    expect(at(2, 40)[0]).toBeGreaterThan(160)
    expect(at(60, 2)[1]).toBeGreaterThan(160)
    const [r, g] = at(112, 72)
    expect(r).toBeLessThan(128)
    expect(g).toBeLessThan(128)
    // 高光集中在外沿；上边朝向左上的光源，比右边亮
    expect(at(60, 0)[2]).toBeGreaterThan(at(60, 10)[2])
    expect(at(60, 0)[2]).toBeGreaterThan(at(119, 40)[2])
  })

  it('measures distance to a squircle corner and has no refraction at the very edge', () => {
    const r = 24
    const q = r / 2 ** 0.25
    const corner = edgeDistance(shape.width - r + q, shape.height - r + q, shape)
    expect(corner.t).toBeCloseTo(0, 6)
    expect(corner.nx).toBeCloseTo(Math.SQRT1_2, 6)
    const optics = opticsFor(shape.width, shape.height)
    expect(refractionOffset(0, optics)).toBe(0)
    expect(refractionOffset(optics.bezel, optics)).toBe(0)
  })
})
