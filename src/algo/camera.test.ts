import { describe, expect, it } from 'vitest'
import { angleBetween, fromAngles, pixelToRay, rayToPixel, toAngles, unproject } from './camera'
import { kelvinToRgb } from './kelvin'

describe('camera', () => {
  const size = { width: 800, height: 600 }

  it('round-trips pixels through rays', () => {
    const p = { x: 123, y: 45 }
    const ray = pixelToRay(p, size, 60)
    expect(ray[2]).toBeLessThan(0)
    const q = rayToPixel(ray, size, 60)!
    expect(q.x).toBeCloseTo(p.x)
    expect(q.y).toBeCloseTo(p.y)
    expect(rayToPixel([0, 0, 1], size, 60)).toBeNull()
  })

  it('places nearer points closer to the camera', () => {
    const near = unproject({ x: 400, y: 300 }, 0.9, size, 60)
    const far = unproject({ x: 400, y: 300 }, 0.1, size, 60)
    expect(near[2]).toBeGreaterThan(far[2])
  })

  it('converts angles', () => {
    const d = fromAngles(-Math.PI / 4, Math.PI / 6)
    const { azimuth, elevation } = toAngles(d)
    expect(azimuth).toBeCloseTo(-Math.PI / 4)
    expect(elevation).toBeCloseTo(Math.PI / 6)
    expect(angleBetween(fromAngles(0, 0), [0, 0, 1])).toBeCloseTo(0)
  })
})

describe('kelvinToRgb', () => {
  it('goes from warm to cool', () => {
    const warm = kelvinToRgb(2000)
    const neutral = kelvinToRgb(6500)
    const cool = kelvinToRgb(12000)
    expect(warm[0]).toBe(1)
    expect(warm[2]).toBeLessThan(0.2)
    expect(Math.min(...neutral)).toBeGreaterThan(0.85)
    expect(cool[2]).toBe(1)
    expect(cool[0]).toBeLessThan(0.85)
  })
})
