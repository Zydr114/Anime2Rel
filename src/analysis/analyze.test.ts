import { describe, expect, it } from 'vitest'
import { angleBetween, fromAngles, pixelToRay, toAngles } from '@/algo/camera'
import { evalSh } from '@/algo/sh'
import { analyze } from './analyze'
import { SKY_LIGHT_DIRECTION } from './fuse'
import { renderScene, type SyntheticLight } from './synthetic'

const W = 256
const H = 192
const DEG = Math.PI / 180

function run(light: SyntheticLight) {
  const s = renderScene(W, H, light)
  return analyze(s.rgba, W, H, s.depth, s.sky, 60)
}

describe('analyze', () => {
  it('finds an off-screen sun from shading, contours and the sky gradient', () => {
    const sun = fromAngles(-40 * DEG, 35 * DEG)
    const r = run({ direction: sun, color: [0.9, 0.85, 0.75], ambient: [0.12, 0.14, 0.18] })
    expect(r.diffuse).toBe(false)
    const main = r.candidates[0]
    expect(main.type).toBe('directional')
    expect(main.sources).toEqual(expect.arrayContaining(['B', 'C']))
    expect(angleBetween(main.direction, sun) / DEG).toBeLessThan(15)
    expect(Math.abs(toAngles(main.direction).azimuth - toAngles(sun).azimuth) / DEG).toBeLessThan(10)
    // 环境光去掉了主光，但仍为正
    expect(evalSh(Float64Array.from(r.ambient), [0, 0, 1]).every((v) => v > 0)).toBe(true)
  })

  it('locates a visible sun as a directional light through its pixel', () => {
    const at = { x: 0.72 * W, y: 0.12 * H }
    const sun = pixelToRay(at, { width: W, height: H }, 60)
    const r = run({ direction: sun, color: [0.9, 0.8, 0.65], ambient: [0.15, 0.17, 0.2], sunInView: true })
    const main = r.candidates[0]
    expect(main.sources).toContain('A')
    expect(angleBetween(main.direction, sun) / DEG).toBeLessThan(2)
    expect(main.intensity).toBeGreaterThan(0.05)
  })

  it('marks an overcast scene as diffuse with a soft sky light', () => {
    const r = run({ direction: null, color: [0, 0, 0], ambient: [0.1, 0.1, 0.1], skyLight: [0.5, 0.52, 0.55] })
    expect(r.diffuse).toBe(true)
    expect(r.candidates[0].direction).toEqual(SKY_LIGHT_DIRECTION)
    expect(r.candidates[0].softness).toBe(1)
  })

  it('reports a lamp in the foreground as a point light', () => {
    const lamp = { x: 0.3 * W, y: 0.55 * H, r: 3 }
    const r = run({ direction: null, color: [0, 0, 0], ambient: [0.03, 0.03, 0.04], lamp, night: true })
    expect(r.diffuse).toBe(false)
    const point = r.candidates.find((c) => c.type === 'point')!
    expect(point.position!.u * W).toBeCloseTo(lamp.x, 0)
    expect(point.position!.v * H).toBeCloseTo(lamp.y, 0)
    expect(point.color[2]).toBeLessThan(point.color[0])
  })
})
