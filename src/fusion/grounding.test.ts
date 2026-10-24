import { describe, expect, it } from 'vitest'
import { unproject } from '@/algo/camera'
import { DEFAULT_CAMERA } from '@/camera/model'
import { characterMeters } from '@/camera/character'
import { depthScaleFor } from '@/camera/depthScale'
import { groundPoint } from '@/camera/geometry'
import type { DepthResult } from '@/depth/protocol'
import { DEFAULT_LIGHTING } from '@/lighting/model'
import { initialDoc, type DocState } from '@/state/store'
import { bounceAt, groundingParams, occlusionAt } from './grounding'
import { ROW_BINS, type CharacterInfo } from './protocol'

const size = { width: 640, height: 480 }
const guide = { width: 160, height: 120 }
const camera = { ...DEFAULT_CAMERA, pitch: -0.2, height: 1.6, confirmed: true }

function scene(): DepthResult {
  const depth = new Float32Array(guide.width * guide.height)
  const sky = new Float32Array(guide.width * guide.height)
  for (let y = 0; y < guide.height; y++)
    for (let x = 0; x < guide.width; x++) {
      const i = y * guide.width + x
      const g = groundPoint(camera, size, { x: ((x + 0.5) * size.width) / guide.width, y: ((y + 0.5) * size.height) / guide.height })
      if (!g) sky[i] = 1
      else depth[i] = (-1 / g[2] - 0.005) / 0.6
    }
  return { depth, sky, guideSize: guide } as unknown as DepthResult
}

const background = scene()
const rows = new Float32Array(ROW_BINS * 2).fill(-1)
for (let i = 0; i < rows.length; i += 2) rows.set([0.35, 0.65], i)
const info: CharacterInfo = { bbox: { x0: 0.2, y0: 0, x1: 0.8, y1: 1 }, reliefMedian: 0.5, cut: false, rows, rowSpan: [0, 1] }

const doc = (grounding = { ao: 0.5, aoRange: 0.35, bounce: 0.4, bounceRange: 0.5 }): DocState => ({
  ...initialDoc,
  background: { id: 'bg', name: 'bg', width: size.width, height: size.height, sourceWidth: size.width, sourceHeight: size.height, hasTransparency: false },
  character: { id: 'ch', name: 'ch', width: 100, height: 200, sourceWidth: 100, sourceHeight: 200, hasTransparency: true },
  charTransform: { x: 320, y: 300, scale: 1, rotation: 0, flipX: false },
  camera,
  lighting: DEFAULT_LIGHTING,
  fusion: { ...initialDoc.fusion, depth: 0.5, ground: { u: 0.5, v: 1 }, grounding },
})

describe('grounding', () => {
  it('darkens the ambient light near the ground and much more on downward faces', () => {
    // h = 0：竖直面保留 40%，朝下的面全黑；超过范围后不受影响
    expect(occlusionAt(0, 0.6, 1, 0)).toBeCloseTo(0.6)
    expect(occlusionAt(0, 0.6, 1, 1)).toBeCloseTo(0)
    expect(occlusionAt(1.2, 0.6, 1, 1)).toBe(1)
    expect(occlusionAt(0, 0.6, 0, 1)).toBe(1)
    // 随高度单调变亮
    const values = [0, 0.2, 0.4, 0.6].map((h) => occlusionAt(h, 0.6, 0.8, 0.3))
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('bounces only onto downward faces and fades with height', () => {
    expect(bounceAt(0, 0.85, 1, 0)).toBe(0)
    expect(bounceAt(0, 0.85, 1, 1)).toBeCloseTo(1)
    expect(bounceAt(0.85, 0.85, 1, 1)).toBeCloseTo(Math.exp(-1))
    expect(bounceAt(10, 0.85, 1, 1)).toBeLessThan(1e-4)
    expect(bounceAt(0, 0.85, 0, 1)).toBe(0)
  })

  it('puts the ground plane at the ground point and scales the ranges with the character height', () => {
    const p = groundingParams({ doc: doc(), background, info })!
    const height = characterMeters(doc(), info.bbox)!
    expect(p.aoRange).toBeCloseTo(0.35 * height, 6)
    expect(p.bounceRange).toBeCloseTo(0.5 * height, 6)
    expect(p.ground).toHaveLength(3)
    const scale = depthScaleFor(camera, size, background)
    // 接地点在立绘底边（v = 1 → 文档 y = 400）
    const at = unproject({ x: 320, y: 400 }, 0.5, size, camera.fovDeg, scale)
    p.ground.forEach((v, i) => expect(v).toBeCloseTo(at[i], 6))
    // 相机水平时地面法线就是相机的上方向
    expect(p.up[1]).toBeCloseTo(1, 1)
    expect(p.bounceColor).toEqual([0, 0, 0])
  })

  it('needs a character, a calibrated depth and a non-zero strength', () => {
    expect(groundingParams({ doc: { ...doc(), character: null }, background, info })).toBeNull()
    expect(groundingParams({ doc: doc({ ao: 0, aoRange: 0.35, bounce: 0, bounceRange: 0.5 }), background, info })).toBeNull()
    // 处处相同的深度拟合不出地面
    const flat = { ...background, depth: new Float32Array(guide.width * guide.height).fill(0.6) } as DepthResult
    expect(groundingParams({ doc: doc(), background: flat, info })).toBeNull()
    // 接地点用水体遮挡时水位线才是画面上的交界，不按地面算
    const water = doc()
    water.focus = { ...water.focus, occlusion: { ...water.focus.occlusion, enabled: true, mode: 'water' } }
    expect(groundingParams({ doc: water, background, info })).toBeNull()
  })
})
