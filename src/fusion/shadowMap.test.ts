import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/algo/sh'
import { boxSegment, lightUV, occupancyCorners, penumbraRadius, shadowMapParams, texelRay } from './shadowMap'

const size = { width: 1000, height: 800 }
const focal = 900
// 立在 5 米外的人物：画面上 300–700 × 200–700，距离 4.8–5.4 米
const corners = occupancyCorners([300, 200, 700, 700], size, focal, 4.8, 5.4)
const inside = (uvs: number) => uvs >= 0 && uvs <= 1

describe('shadow map', () => {
  it('covers every corner of the occupied box for a sun and a lamp', () => {
    const sun = shadowMapParams({ point: false, vector: [0.5, 0.6, -0.62] }, corners)!
    const lamp = shadowMapParams({ point: true, vector: [3, 2, -2] }, corners)!
    for (const p of [sun, lamp])
      for (const c of corners) {
        const [u, v, s] = lightUV(p, c)
        expect(inside(u) && inside(v) && inside(s)).toBe(true)
      }
  })

  it('maps texel rays back onto their own texel', () => {
    for (const light of [
      { point: false, vector: [0, 0.7, 0.71] as Vec3 },
      { point: true, vector: [-2, 3, -1] as Vec3 },
    ]) {
      const p = shadowMapParams(light, corners)!
      const { origin, dir } = texelRay(p, 0.3, 0.6)
      const [t0, t1] = boxSegment(origin, dir, p.boxMin, p.boxMax)
      expect(t1).toBeGreaterThan(t0)
      const t = (t0 + t1) / 2
      const x: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]
      const [u, v, s] = lightUV(p, x)
      expect(u).toBeCloseTo(0.3, 6)
      expect(v).toBeCloseTo(0.6, 6)
      // 沿光线的参数就是 s
      expect(s * p.range[1] + p.range[0]).toBeCloseTo(t, 6)
    }
  })

  it('sees a camera-facing slab edge-on under side light', () => {
    // 正面来光时，贴图平面上的范围是人物的宽和高；侧光时宽度只剩厚度
    const front = shadowMapParams({ point: false, vector: [0, 0, 1] }, occupancyCorners([480, 200, 520, 700], size, focal, 5, 5.3))!
    const side = shadowMapParams({ point: false, vector: [1, 0, 0] }, occupancyCorners([480, 200, 520, 700], size, focal, 5, 5.3))!
    const width = (p: NonNullable<typeof front>, c: Vec3[]) => {
      const us = c.map((x) => lightUV(p, x)[0] * p.rect[2])
      return Math.max(...us) - Math.min(...us)
    }
    const slab = occupancyCorners([480, 200, 520, 700], size, focal, 5, 5.3)
    expect(width(side, slab)).toBeGreaterThan(0.28)
    expect(width(side, slab)).toBeLessThan(0.36)
    expect(width(front, slab)).toBeLessThan(0.3)
  })

  it('refuses a lamp inside the occupied box', () => {
    expect(shadowMapParams({ point: true, vector: [0, 0, -5] }, corners)).toBeNull()
  })

  it('widens the penumbra with the distance to the blocker', () => {
    const p = shadowMapParams({ point: false, vector: [0.3, 0.8, 0.5] }, corners)!
    expect(penumbraRadius(p, 5, 5, 0.1)).toBe(0)
    expect(penumbraRadius(p, 6, 5, 0.1)).toBeGreaterThan(penumbraRadius(p, 5.5, 5, 0.1))
    expect(penumbraRadius(p, 4, 5, 0.1)).toBe(0)
  })
})
