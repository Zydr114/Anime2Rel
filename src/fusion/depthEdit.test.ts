import { describe, expect, it } from 'vitest'
import { DepthEditRasterizer, sampleEdit, type DepthEditBase, type DepthStroke } from './depthEdit'

const W = 64
const H = 128
/** 原深度是一个凸起，右半边透明 */
const base: DepthEditBase = {
  width: W,
  height: H,
  depth: Float32Array.from({ length: W * H }, (_, i) => 0.5 + 0.3 * Math.exp(-((((i % W) - 16) / 6) ** 2 + ((Math.floor(i / W) - 64) / 6) ** 2))),
  alpha: Float32Array.from({ length: W * H }, (_, i) => (i % W < 32 ? 1 : 0)),
}
/** 横穿 (16, 64) 的一笔，半径 8 像素 */
const across = (mode: DepthStroke['mode'], strength = 1): DepthStroke => ({ mode, radius: 8 / H, strength, hardness: 0.5, points: [4 / W, 64.5 / H, 28 / W, 64.5 / H] })
const at = (raster: { width: number; height: number; delta: Float32Array }, x: number, y: number) => sampleEdit(raster, (x + 0.5) / W, (y + 0.5) / H)

describe('depth edit', () => {
  it('pushes, pulls, restores and smooths', () => {
    const pull = new DepthEditRasterizer().rasterize([across('pull', 0.5)], base)
    expect(at(pull, 16, 64)).toBeCloseTo(0.1, 2)
    expect(at(pull, 16, 80)).toBe(0)
    const push = new DepthEditRasterizer().rasterize([across('push')], base)
    expect(at(push, 16, 64)).toBeCloseTo(-0.2, 2)
    expect(Math.abs(at(new DepthEditRasterizer().rasterize([across('pull'), across('restore')], base), 16, 64))).toBeLessThan(0.02)
    // 平滑压低凸起的顶部
    const smooth = new DepthEditRasterizer().rasterize([across('smooth')], base)
    expect(at(smooth, 16, 64)).toBeLessThan(-0.05)
    expect(smooth.delta.every((v, i) => v === 0 || i % W < 32)).toBe(true)
  })

  it('continues a stroke being painted and matches painting from scratch', () => {
    const r = new DepthEditRasterizer()
    const full = across('pull').points
    const first: DepthStroke = { ...across('pull'), points: full.slice(0, 2) }
    const strokes: DepthStroke[] = []
    // 一笔逐点加长，接着画第二笔，再撤销第二笔
    for (let n = 2; n <= full.length; n += 2) r.rasterize([{ ...first, points: full.slice(0, n) }], base)
    const painted = { ...first, points: full }
    strokes.push(painted, across('smooth'))
    const both = r.rasterize(strokes, base)
    expect(Array.from(both.delta)).toEqual(Array.from(new DepthEditRasterizer().rasterize(strokes, base).delta))
    expect(Array.from(r.rasterize([painted], base).delta)).toEqual(Array.from(new DepthEditRasterizer().rasterize([painted], base).delta))
  })
})
