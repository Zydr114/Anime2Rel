import { describe, expect, it } from 'vitest'
import { pixelToRay } from '@/algo/camera'
import { DEFAULT_LIGHTING, newDirectionalLight, type Light } from '@/lighting/model'
import { DEFAULT_POST, postParams, raysLight } from './post'

const size = { width: 800, height: 600 }

describe('raysLight', () => {
  it('projects lights in front of the camera and prefers the strongest directional light', () => {
    const behind = { ...newDirectionalLight(2), direction: [0, 0.5, 0.866] } as Light
    const sun = { ...newDirectionalLight(0.5), direction: pixelToRay({ x: 600, y: 90 }, size, 60) }
    const lamp: Light = { ...newDirectionalLight(3), type: 'point', position: { x: 200, y: 300, depth: 0.5 } }
    const lighting = { ...DEFAULT_LIGHTING, lights: [lamp, behind, sun] }
    const auto = raysLight(lighting, null, size)
    expect(auto?.light).toBe(sun)
    expect(auto!.uv.x).toBeCloseTo(0.75, 6)
    expect(auto!.uv.y).toBeCloseTo(0.15, 6)
    expect(raysLight(lighting, lamp.id, size)?.uv).toEqual({ x: 0.25, y: 0.5 })
    expect(raysLight(lighting, behind.id, size)).toBeNull()
    expect(raysLight({ ...lighting, lights: [behind] }, null, size)).toBeNull()
  })
})

describe('postParams', () => {
  it('is inactive by default and disables rays without a usable light', () => {
    expect(postParams(DEFAULT_POST, DEFAULT_LIGHTING, size).active).toBe(false)
    const p = postParams({ ...DEFAULT_POST, rays: { ...DEFAULT_POST.rays, intensity: 0.5 } }, DEFAULT_LIGHTING, size)
    expect(p.active).toBe(true)
    expect(p.rays).toBe(0)
  })
})
