import { describe, expect, it } from 'vitest'
import { pixelToRay } from '@/algo/camera'
import { DEFAULT_LIGHTING, newDirectionalLight, type Light } from '@/lighting/model'
import { flarePreset, FOLLOW_APERTURE, newFlareElement } from './flare'
import { DEFAULT_POST, postParams, raysLight } from './post'

const size = { width: 800, height: 600 }

describe('raysLight', () => {
  it('projects lights in front of the camera and prefers the strongest directional light', () => {
    const behind = { ...newDirectionalLight(2), direction: [0, 0.5, 0.866] } as Light
    const sun = { ...newDirectionalLight(0.5), direction: pixelToRay({ x: 600, y: 90 }, size, 60) }
    const lamp: Light = { ...newDirectionalLight(3), type: 'point', position: { x: 200, y: 300, depth: 0.5 } }
    const lighting = { ...DEFAULT_LIGHTING, lights: [lamp, behind, sun] }
    const auto = raysLight(lighting, null, size, 60)
    expect(auto?.light).toBe(sun)
    expect(auto!.uv.x).toBeCloseTo(0.75, 6)
    expect(auto!.uv.y).toBeCloseTo(0.15, 6)
    expect(raysLight(lighting, lamp.id, size, 60)?.uv).toEqual({ x: 0.25, y: 0.5 })
    expect(raysLight(lighting, behind.id, size, 60)).toBeNull()
    expect(raysLight({ ...lighting, lights: [behind] }, null, size, 60)).toBeNull()
  })
})

describe('postParams', () => {
  it('is inactive by default and disables rays without a usable light', () => {
    expect(postParams(DEFAULT_POST, DEFAULT_LIGHTING, size, 60).active).toBe(false)
    const p = postParams({ ...DEFAULT_POST, rays: { ...DEFAULT_POST.rays, intensity: 0.5, rim: 0.5 } }, DEFAULT_LIGHTING, size, 60)
    expect(p.active).toBe(true)
    expect(p.rays).toBe(0)
    expect(p.raysRim).toBe(0)
  })
})

describe('flare params', () => {
  const lamp = (x: number, y: number): Light => ({ ...newDirectionalLight(1), type: 'point', position: { x, y, depth: 0.5 } })
  const flare = (light: Light, elements = flarePreset('soft-sun')) =>
    postParams({ ...DEFAULT_POST, flare: { ...DEFAULT_POST.flare, enabled: true, elements } }, { ...DEFAULT_LIGHTING, lights: [light] }, size, 60, { blades: 6, rotation: 0.5 })

  it('fades out as the light leaves the frame', () => {
    const inside = flare(lamp(400, 300))
    expect(inside.flare).toBeGreaterThan(0)
    expect(inside.flareLight).toEqual({ x: 0.5, y: 0.5 })
    expect(inside.flareSky).toBe(false)
    // 画面外 0.1 个长边：淡出一半
    expect(flare(lamp(880, 300)).flare).toBeCloseTo(inside.flare / 2, 6)
    const far = flare(lamp(1200, 300))
    expect(far.flare).toBe(0)
    expect(far.flareCount).toBe(0)
  })

  it('packs elements and resolves ghosts that follow the aperture', () => {
    const elements = [newFlareElement({ type: 'ghost', sides: FOLLOW_APERTURE, rotation: 90, size: 0.1 }), newFlareElement({ type: 'streaks', sides: 5 })]
    const data = flare(lamp(400, 300), elements).flareElements
    expect([...data.subarray(0, 4)]).toEqual([4, 1.3, 0.1, 0.08].map(Math.fround))
    expect(data[7]).toBeCloseTo(Math.PI / 2 + 0.5, 6)
    expect(data[9]).toBe(6)
    // 只有鬼影使用边数
    expect(data[16]).toBe(2)
    expect(data[16 + 9]).toBe(0)
  })
})
