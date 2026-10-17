import { describe, expect, it } from 'vitest'
import { unproject } from '@/algo/camera'
import { newLightAt } from './model'
import { effectiveLight } from './preview'

describe('effectiveLight', () => {
  const size = { width: 800, height: 600 }

  it('points a point light from the ball towards its 2.5D position and attenuates it', () => {
    const at = unproject({ x: 400, y: 300 }, 0.5, size, 60)
    const left = newLightAt({ x: 100, y: 300 }, size, 60, { depth: 0.5, sky: 0 }, 1)
    const near = effectiveLight(left, at, size, 60)
    expect(near.direction[0]).toBeLessThan(-0.9)
    const far = effectiveLight({ ...left, position: { x: -2000, y: 300, depth: 0.5 } }, at, size, 60)
    expect(far.color[0]).toBeLessThan(near.color[0])
  })

  it('creates directional lights in the sky along the camera ray', () => {
    const sun = newLightAt({ x: 600, y: 50 }, size, 60, { depth: 0, sky: 1 })
    expect(sun.type).toBe('directional')
    expect(sun.direction[0]).toBeGreaterThan(0)
    expect(sun.direction[1]).toBeGreaterThan(0)
    expect(sun.direction[2]).toBeLessThan(0)
  })
})
