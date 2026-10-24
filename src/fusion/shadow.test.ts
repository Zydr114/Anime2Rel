import { describe, expect, it } from 'vitest'
import { unproject } from '@/algo/camera'
import type { Vec3 } from '@/algo/sh'
import { depthScaleFor } from '@/camera/depthScale'
import { groundPoint } from '@/camera/geometry'
import { DEFAULT_CAMERA } from '@/camera/model'
import { characterMeters } from '@/camera/character'
import type { DepthResult } from '@/depth/protocol'
import { newDirectionalLight, newLightAt, DEFAULT_LIGHTING } from '@/lighting/model'
import { initialDoc, type DocState } from '@/state/store'
import { ROW_BINS, type CharacterInfo } from './protocol'
import { shadowParams, SURFACE_STEPS } from './shadow'

const size = { width: 640, height: 480 }
const guide = { width: 160, height: 120 }
const camera = { ...DEFAULT_CAMERA, pitch: -0.2, height: 1.6, confirmed: true }

/** 地面按 1/z = a·d + b 生成深度，视平线以上是天空（与 src/camera/depthScale.test.ts 相同） */
function scene(a = 0.6, b = 0.005): DepthResult {
  const depth = new Float32Array(guide.width * guide.height)
  const sky = new Float32Array(guide.width * guide.height)
  for (let y = 0; y < guide.height; y++)
    for (let x = 0; x < guide.width; x++) {
      const i = y * guide.width + x
      const g = groundPoint(camera, size, { x: ((x + 0.5) * size.width) / guide.width, y: ((y + 0.5) * size.height) / guide.height })
      if (!g) sky[i] = 1
      else depth[i] = (-1 / g[2] - b) / a
    }
  return { depth, sky, guideSize: guide } as unknown as DepthResult
}

const background = scene()
const rows = new Float32Array(ROW_BINS * 2).fill(-1)
for (let i = 0; i < rows.length; i += 2) rows.set([0.35, 0.65], i)
const info: CharacterInfo = { bbox: { x0: 0.2, y0: 0, x1: 0.8, y1: 1 }, reliefMedian: 0.5, cut: false, rows, rowSpan: [0, 1] }
const ambient = new Array(27).fill(0)
for (let c = 0; c < 3; c++) ambient[c] = 0.3 / 0.282095 / 0.886227

const sun = { ...newDirectionalLight(1), direction: [-0.4, 0.8, 0.3] as Vec3, softness: 0 }
const doc = (method: 'plane' | 'surface', lighting = { ...DEFAULT_LIGHTING, lights: [sun] }): DocState => ({
  ...initialDoc,
  background: { id: 'bg', name: 'bg', width: size.width, height: size.height, sourceWidth: size.width, sourceHeight: size.height, hasTransparency: false },
  character: { id: 'ch', name: 'ch', width: 100, height: 200, sourceWidth: 100, sourceHeight: 200, hasTransparency: true },
  charTransform: { x: 320, y: 300, scale: 1, rotation: 0, flipX: false },
  camera,
  lighting,
  fusion: { ...initialDoc.fusion, depth: 0.5, ground: { u: 0.5, v: 1 }, shadow: { ...initialDoc.fusion.shadow, method } },
})

const call = (d: DocState, depth = background) => shadowParams({ doc: d, background: depth, info, ambient })

describe('surface shadow', () => {
  it('keeps the plane method unless 贴合表面 is selected', () => {
    const p = call(doc('plane'))!
    expect(p.cast.strength).toBeGreaterThan(0)
    expect(p.surface).toBeNull()
    expect(call(doc('surface'))!.surface).not.toBeNull()
  })

  it('walks a geometric schedule from 1% of the character height to the shadow length', () => {
    const p = call(doc('surface'))!
    const s = p.surface!
    const height = characterMeters(doc('surface'), info.bbox)!
    expect(height).toBeGreaterThan(0.5)
    expect(s.type).toBe(0)
    expect(s.first).toBeCloseTo(0.01 * height, 6)
    expect(s.thickness).toBeCloseTo(initialDoc.focus.thickness * height, 6)
    // 步长逐级放大，最后一步正好走到最远距离
    expect(s.ratio).toBeGreaterThan(1)
    expect(s.first * s.ratio ** (SURFACE_STEPS - 1)).toBeCloseTo(s.reach, 6)
    // 最远距离不超过 8 倍人物高度
    expect(s.reach).toBeLessThanOrEqual(8 * height + 1e-9)
  })

  it('covers the character and the ground point with the culling rectangle', () => {
    const p = call(doc('surface'))!
    const rect = p.surface!.rect
    expect(rect).not.toBeNull()
    const [x0, y0, x1, y1] = rect!
    // 立绘不透明区域 x = 290–350、y = 200–300（文档像素）
    const box = [
      { x: 290, y: 200 },
      { x: 350, y: 200 },
      { x: 350, y: 300 },
      { x: 290, y: 300 },
    ]
    for (const c of box) {
      expect(c.x).toBeGreaterThanOrEqual(x0)
      expect(c.x).toBeLessThanOrEqual(x1)
      expect(c.y).toBeGreaterThanOrEqual(y0)
      expect(c.y).toBeLessThanOrEqual(y1)
    }
    expect(p.ground.x).toBeGreaterThanOrEqual(x0)
    expect(p.ground.y).toBeGreaterThanOrEqual(y0)
    // 不是整幅画布
    expect((x1 - x0) * (y1 - y0)).toBeLessThan(0.85 * size.width * size.height)
  })

  it('uses the lamp position for point lights and stops the march at the lamp', () => {
    const lamp = newLightAt({ x: 400, y: 120 }, size, 120, { depth: 0.4, sky: 0 })
    const d = doc('surface', { ...DEFAULT_LIGHTING, lights: [lamp] })
    const p = call(d)!
    const s = p.surface!
    const scale = depthScaleFor(camera, size, background)
    const at = unproject(p.ground, 0.5, size, camera.fovDeg, scale)
    const position = unproject(lamp.position, lamp.position.depth, size, camera.fovDeg, scale)
    expect(s.type).toBe(1)
    s.vector.forEach((v, i) => expect(v).toBeCloseTo(position[i], 6))
    expect(s.reach).toBeLessThanOrEqual(Math.hypot(...position.map((v, i) => v - at[i])) + 1e-9)
  })

  it('falls back to the plane method when the depth is not calibrated against the ground', () => {
    // 处处相同的深度：按地面拟合不出斜率
    const flat = { ...background, depth: new Float32Array(guide.width * guide.height).fill(0.6) } as DepthResult
    expect(depthScaleFor(camera, size, flat).state).not.toBe('ground')
    const p = call(doc('surface'), flat)!
    expect(p.surface).toBeNull()
    // 平面方式照旧
    expect(p.cast.strength).toBeGreaterThan(0)
  })

  it('has no step parameters without a light or with the cast turned off', () => {
    const dark = doc('surface', { ...DEFAULT_LIGHTING, lights: [] })
    // 没有光源时仍有接触阴影，但没有投影
    expect(call(dark)!.cast.strength).toBe(0)
    expect(call(dark)!.surface).toBeNull()
    const off = doc('surface')
    off.fusion = { ...off.fusion, shadow: { ...off.fusion.shadow, cast: 0, contact: 0.5 } }
    expect(call(off)!.surface).toBeNull()
  })
})
