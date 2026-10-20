import { describe, expect, it } from 'vitest'
import type { DepthResult } from '@/depth/protocol'
import { initialDoc, type DocState } from '@/state/store'
import { bokehKernel, circleOfConfusion, occlusionMask, reliefDepth } from './dof'
import { DEFAULT_FOCUS } from './model'
import { focusDepth, focusParams } from './params'

/** 均匀深度或按函数生成的深度结果（只填景深用到的字段） */
function depthResult(width: number, height: number, f: (x: number, y: number) => number): DepthResult {
  const depth = Float32Array.from({ length: width * height }, (_, i) => f(i % width, Math.floor(i / width)))
  return { guideSize: { width, height }, depth, sky: null } as DepthResult
}

const asset = (id: string, width: number, height: number) => ({ id, name: id, width, height, sourceWidth: width, sourceHeight: height, hasTransparency: true })

describe('depth of field', () => {
  it('blurs in proportion to the inverse-depth difference outside the in-focus range', () => {
    expect(circleOfConfusion(0.52, 0.5, 0.01, 0.03)).toBe(0)
    expect(circleOfConfusion(0.9, 0.5, 0.01, 0.1)).toBeCloseTo(0.003)
    expect(circleOfConfusion(0.1, 0.5, 0.01, 0.1)).toBeCloseTo(-0.003)
  })

  it('puts the relief reference on the character plane and moves higher relief toward the camera', () => {
    expect(reliefDepth(0.4, 0.6, 0.6, 0.3)).toBeCloseTo(0.4)
    expect(reliefDepth(0.4, 0.9, 0.6, 0.3)).toBeGreaterThan(0.4)
    expect(reliefDepth(0.4, 0.2, 0.6, 0.3)).toBeLessThan(0.4)
  })

  it('occludes only background pixels that are nearer than the character by more than the tolerance', () => {
    expect(occlusionMask(0.5, 0.5, 0.05, 0.02)).toBe(0)
    expect(occlusionMask(0.55, 0.5, 0.05, 0.02)).toBeCloseTo(0.5)
    expect(occlusionMask(0.7, 0.5, 0.05, 0.02)).toBe(1)
  })

  it('distributes bokeh samples inside the unit disk or the polygon, ordered by radius', () => {
    for (const blades of [0, 6]) {
      const k = bokehKernel(48, blades, 0.3)
      expect(k).toHaveLength(48)
      k.forEach(([x, y, r], i) => {
        if (i > 0) expect(r).toBeGreaterThan(k[i - 1][2])
        const len = Math.hypot(x, y)
        if (!blades) return expect(len).toBeCloseTo(r)
        // 多边形：到最近一条边的法线方向上的投影不超过内切圆半径
        const sector = (2 * Math.PI) / blades
        const a = (((Math.atan2(y, x) - 0.3) % sector) + sector) % sector
        expect(len * Math.cos(a - sector / 2)).toBeLessThanOrEqual(r * Math.cos(sector / 2) + 1e-9)
      })
    }
  })

  it('focuses on the character plane by default, on the clicked background depth, or on a point of the character', () => {
    // 背景深度沿 y 线性变化，立绘自身起伏左低右高
    const background = depthResult(100, 100, (_x, y) => y / 100)
    const character = depthResult(10, 20, (x) => x / 10)
    const doc: DocState = {
      ...initialDoc,
      background: asset('bg', 1000, 1000),
      character: asset('ch', 100, 200),
      charTransform: { x: 500, y: 700, scale: 1, rotation: 0, flipX: false },
    }
    const info = { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, reliefMedian: 0.5, rows: new Float32Array(0), rowSpan: [0, 1] as [number, number], cut: false }
    const input = (focus: DocState['focus']) => ({ doc: { ...doc, focus }, background, character, info })

    // 脚下（y = 800）的背景深度
    expect(focusDepth(input(DEFAULT_FOCUS))).toBeCloseTo(0.8)
    expect(focusDepth(input({ ...DEFAULT_FOCUS, target: { kind: 'background', x: 100, y: 205 } }))).toBeCloseTo(0.2)
    expect(focusDepth(input({ ...DEFAULT_FOCUS, target: { kind: 'character', u: 0.95, v: 0.5 } }))).toBeGreaterThan(0.8)

    const params = focusParams(input(DEFAULT_FOCUS))
    expect(params.dof).toBe(true)
    // 厚度为 0 时立绘是平面，对焦在立绘上时立绘本身不模糊
    expect(focusParams(input({ ...DEFAULT_FOCUS, thickness: 0 })).characterCoc).toBe(0)
    expect(focusParams(input({ ...DEFAULT_FOCUS, dof: { ...DEFAULT_FOCUS.dof, enabled: false } })).aperture).toBe(0)
  })
})
