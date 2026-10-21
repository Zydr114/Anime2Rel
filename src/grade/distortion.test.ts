import { describe, expect, it } from 'vitest'
import { DISTORTION_SCALE, distortionReach, distortionZoom, distortUV, undistortUV } from './distortion'

const size = { width: 1600, height: 900 }

describe('lens distortion', () => {
  it('fills the frame: every boundary point maps inside, and the tightest one touches the edge', () => {
    for (const amount of [-1, -0.4, 0.3, 1]) {
      const a = amount * DISTORTION_SCALE
      const z = distortionZoom(a, size)
      let edge = 0
      for (let i = 0; i <= 200; i++) {
        const t = i / 200
        for (const uv of [{ x: 0, y: t }, { x: 1, y: t }, { x: t, y: 0 }, { x: t, y: 1 }]) {
          const s = distortUV(uv, a, z, size)
          const out = Math.max(Math.abs(s.x - 0.5), Math.abs(s.y - 0.5))
          expect(out).toBeLessThanOrEqual(0.5 + 1e-9)
          edge = Math.max(edge, out)
        }
      }
      expect(edge).toBeCloseTo(0.5, 4)
    }
  })

  it('is the identity without distortion and the inverse round-trips', () => {
    expect(distortionZoom(0, size)).toBe(1)
    expect(distortUV({ x: 0.2, y: 0.9 }, 0, 1, size)).toEqual({ x: 0.2, y: 0.9 })
    expect(distortionReach(0, 1, size)).toBe(0)
    for (const amount of [-1, 0.5, 1]) {
      const a = amount * DISTORTION_SCALE
      const z = distortionZoom(a, size)
      for (const uv of [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.8 }, { x: 0, y: 0 }, { x: 0.7, y: 0.3 }]) {
        const back = undistortUV(distortUV(uv, a, z, size), a, z, size)
        expect(back.x).toBeCloseTo(uv.x, 9)
        expect(back.y).toBeCloseTo(uv.y, 9)
      }
    }
  })

  it('bounds the displacement of every pixel', () => {
    for (const amount of [-1, 1]) {
      const a = amount * DISTORTION_SCALE
      const z = distortionZoom(a, size)
      const reach = distortionReach(a, z, size)
      let max = 0
      for (let i = 0; i <= 40; i++)
        for (let j = 0; j <= 40; j++) {
          const uv = { x: i / 40, y: j / 40 }
          const s = distortUV(uv, a, z, size)
          max = Math.max(max, Math.hypot((s.x - uv.x) * size.width, (s.y - uv.y) * size.height) / size.width)
        }
      expect(max).toBeLessThanOrEqual(reach + 1e-4)
      expect(max).toBeGreaterThan(reach * 0.95)
    }
  })
})
