import { describe, expect, it } from 'vitest'
import { snapEdges, transitionBand } from './edgeSnap'
import { gaussianBlur, resizeBilinear } from './raster'

function noise(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 引导图在 x = edge 处由深红变浅灰，带少量噪声；深度由低分辨率阶跃放大并模糊得到 */
function scene(w: number, h: number, edge: number, shift: number) {
  const rnd = noise(5)
  const guide = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = (rnd() - 0.5) * 0.06
      guide.set(x >= edge ? [0.8 + n, 0.8 + n, 0.8 + n] : [0.5 + n, 0.05 + n, 0.05 + n], (y * w + x) * 3)
    }
  const lw = w / 4
  const lh = h / 4
  const low = Float32Array.from({ length: lw * lh }, (_, i) => {
    const x0 = (i % lw) * 4
    let s = 0
    for (let k = 0; k < 4; k++) s += x0 + k < edge + shift ? 1 : 0.2
    return s / 4
  })
  const depth = gaussianBlur(resizeBilinear(low, lw, lh, w, h), w, h, 1.5)
  return { guide, depth }
}

describe('snapEdges', () => {
  it.each([0, 2, 4])('snaps a soft depth edge misaligned by %i px onto the colour edge', (shift) => {
    const w = 96
    const h = 24
    const edge = 41
    const { guide, depth } = scene(w, h, edge, shift)
    const out = snapEdges(guide, depth, w, h)
    for (let y = 4; y < h - 4; y++) {
      for (let x = 0; x < w; x++) {
        expect(Math.abs(out[y * w + x] - (x < edge ? 1 : 0.2))).toBeLessThan(0.02)
      }
    }
  })

  it('leaves smooth gradients untouched', () => {
    const w = 64
    const h = 16
    const guide = new Float32Array(w * h * 3).fill(0.5)
    const depth = Float32Array.from({ length: w * h }, (_, i) => (i % w) / w / 4)
    expect(transitionBand(depth, w, h, 0.03).every((v) => v === 0)).toBe(true)
    expect(snapEdges(guide, depth, w, h)).toEqual(depth)
  })
})
