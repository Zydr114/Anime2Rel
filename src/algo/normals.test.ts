import { describe, expect, it } from 'vitest'
import { DEFAULT_NORMAL_OPTIONS, depthToNormals, focalLength } from './normals'

const opts = { ...DEFAULT_NORMAL_OPTIONS, sigmas: [1.5] }

describe('depthToNormals', () => {
  it('gives the view axis for a fronto-parallel plane', () => {
    const w = 40
    const h = 30
    const { normal, confidence } = depthToNormals(new Float32Array(w * h).fill(0.5), w, h, opts)
    for (let i = 0; i < w * h; i++) {
      expect(normal[i * 3 + 2]).toBeCloseTo(1, 5)
      expect(confidence[i]).toBeCloseTo(1, 5)
    }
  })

  it('recovers an upward normal for a perspective ground plane', () => {
    // 相机高 1，地面 y = -1：图像下半部像素 py < 0 处深度 D = -f / py
    const w = 120
    const h = 90
    const f = focalLength(w, h, opts.fovDeg)
    const k = 0.02
    const depth = new Float32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const py = h / 2 - (y + 0.5)
        // 选择 d 使 1 / (d + β) ∝ D
        depth[y * w + x] = py < -2 ? (k * -py) / f * 100 - opts.shift : 0
      }
    const { normal } = depthToNormals(depth, w, h, opts)
    for (let y = h / 2 + 10; y < h - 4; y += 7)
      for (let x = 6; x < w - 6; x += 9) {
        const i = (y * w + x) * 3
        expect(normal[i + 1]).toBeGreaterThan(0.97)
      }
  })

  it('lowers confidence at depth discontinuities and inside the down-weight mask', () => {
    const w = 40
    const h = 20
    const depth = Float32Array.from({ length: w * h }, (_, i) => (i % w < 20 ? 0.9 : 0.05))
    const down = new Float32Array(w * h)
    down[5 * w + 5] = 1
    const { confidence } = depthToNormals(depth, w, h, opts, undefined, down)
    expect(confidence[10 * w + 20]).toBeLessThan(0.2)
    expect(confidence[10 * w + 5]).toBeGreaterThan(0.95)
    expect(confidence[5 * w + 5]).toBe(0)
  })
})
