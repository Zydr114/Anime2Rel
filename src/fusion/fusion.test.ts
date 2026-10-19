import { describe, expect, it } from 'vitest'
import { kelvinToRgb, nearestKelvin } from '@/algo/kelvin'
import { oklabImage } from '@/algo/oklab'
import type { Vec3 } from '@/algo/sh'
import { DEFAULT_LIGHTING, newDirectionalLight, type Light } from '@/lighting/model'
import type { DepthResult } from '@/depth/protocol'
import { initialDoc, type DocState } from '@/state/store'
import { DEFAULT_FUSION } from './model'
import { characterNormals, inflateNormals, lineArtMask, rimMap } from './normals'
import { fusionParams, toneCurve } from './params'
import { characterDepth, characterGround } from './placement'
import { ROW_BINS } from './protocol'
import { shadowParams } from './shadow'
import { labStats, noiseSigma, whitePoint, type LabStats } from './stats'

/** 可复现的伪随机数（xorshift）与近似正态分布 */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  const u = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
  return { u, normal: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) }
}

describe('character normals', () => {
  it('inflates a disk so that normals point outward near the silhouette and toward the camera inside', () => {
    const w = 64
    const alpha = new Float32Array(w * w).map((_, i) => (Math.hypot((i % w) - 31.5, Math.floor(i / w) - 31.5) < 25 ? 1 : 0))
    const n = inflateNormals(alpha, w, w, 10)
    const at = (x: number, y: number) => [n[(y * w + x) * 3], n[(y * w + x) * 3 + 1], n[(y * w + x) * 3 + 2]]
    // 右侧边缘朝右，上侧边缘朝上（图像 y 向下），中心朝向相机
    expect(at(55, 32)[0]).toBeGreaterThan(0.6)
    expect(at(32, 8)[1]).toBeGreaterThan(0.6)
    expect(at(32, 32)[2]).toBeGreaterThan(0.99)
  })

  it('detects dark thin lines as line art and marks them in the alpha channel', () => {
    const w = 48
    const rgb = new Float32Array(w * w * 3).fill(0.8)
    const alpha = new Float32Array(w * w).fill(1)
    for (let y = 0; y < w; y++) for (let c = 0; c < 3; c++) rgb[(y * w + 24) * 3 + c] = 0.05
    const luma = Float32Array.from({ length: w * w }, (_, i) => rgb[i * 3])
    const line = lineArtMask(luma, alpha, w, w)
    expect(line[10 * w + 24]).toBe(1)
    expect(line[10 * w + 10]).toBe(0)
    const packed = characterNormals({ width: w, height: w, rgb, alpha, depthNormal: null, weights: { depth: 0.5, inflate: 0.4, detail: 0.1 }, inflateRadius: 6 })
    expect(packed[(10 * w + 24) * 4 + 3]).toBe(0)
    expect(packed[(10 * w + 10) * 4 + 3]).toBe(255)
  })

  // 浅色圆盘（半径 40）带 2 像素深色外描边，左侧伸出一条半宽 6 的细条
  function outlined() {
    const w = 128
    const rgb = new Float32Array(w * w * 3)
    const alpha = new Float32Array(w * w)
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const disk = Math.hypot(x + 0.5 - 80, y + 0.5 - 64) - 40
        const bar = Math.max(Math.abs(y + 0.5 - 64) - 6, Math.abs(x + 0.5 - 25) - 25)
        const d = Math.min(disk, bar)
        alpha[y * w + x] = d < 0 ? 1 : 0
        rgb.fill(d > -2 ? 0.08 : 0.8, (y * w + x) * 3, (y * w + x) * 3 + 3)
      }
    return { w, rgb, alpha }
  }

  it('finds the outer outline next to transparent pixels', () => {
    const { w, rgb, alpha } = outlined()
    const line = lineArtMask(Float32Array.from({ length: w * w }, (_, i) => rgb[i * 3]), alpha, w, w)
    // 圆盘最右侧的描边：x = 118、119
    for (let x = 118; x < 120; x++) expect(line[64 * w + x]).toBe(1)
    expect(line[64 * w + 100]).toBe(0)
  })

  it('starts the rim band inside the outline and narrows it on thin parts', () => {
    const { w, rgb, alpha } = outlined()
    const rim = rimMap({ width: w, height: w, rgb, alpha })
    const t = (x: number, y: number) => rim[(y * w + x) * 4] / 255
    // 描边内侧紧挨着的像素靠近带的起点，往里很快出带：带宽为长边的 2%（2.6 像素）
    expect(t(117, 64)).toBeLessThan(0.3)
    expect(t(115, 64)).toBeGreaterThan(0.9)
    // 细条半宽 6，带宽按局部半宽变窄：同样紧挨描边内侧的像素，在细条上比在圆盘上更靠近带外
    expect(t(20, 60)).toBeGreaterThan(t(80, 26) + 0.15)
    // 描边处 g / b 为 0，内部为 1
    expect(rim[(64 * w + 118) * 4 + 1]).toBe(0)
    expect(rim[(64 * w + 100) * 4 + 1]).toBe(255)
  })
})

describe('statistics', () => {
  it('computes weighted Oklab quantiles and means', () => {
    const n = 1000
    const linear = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) linear.fill((i / (n - 1)) ** 2.2, i * 3, i * 3 + 3)
    const s = labStats(oklabImage(linear), new Float32Array(n).fill(1))!
    expect(s.quantiles[1]).toBeCloseTo(0.5 ** (2.2 / 3), 2)
    expect(Math.abs(s.mean[0]) + Math.abs(s.mean[1])).toBeLessThan(1e-3)
    expect(s.chromaP90).toBeLessThan(2e-3)
    // 只统计后一半
    const half = labStats(oklabImage(linear), Float32Array.from({ length: n }, (_, i) => (i >= n / 2 ? 1 : 0)))!
    expect(half.quantiles[0]).toBeGreaterThan(s.quantiles[1] - 0.01)
  })

  it('finds a tinted white point and pulls green casts toward the Planckian locus', () => {
    const n = 500
    const r = rng(3)
    const warm = kelvinToRgb(3500)
    const linear = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const g = r.u()
      for (let c = 0; c < 3; c++) linear[i * 3 + c] = g * warm[c]
    }
    const wp = whitePoint(linear, new Uint8Array(n).fill(1))
    expect(Math.abs(nearestKelvin(wp) - 3500)).toBeLessThan(250)
    const green = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) green.set([0.3, 0.6, 0.25], i * 3)
    const gw = whitePoint(green, new Uint8Array(n).fill(1))
    expect(gw[1] - Math.max(gw[0], gw[2])).toBeLessThan(0.25)
  })

  it('estimates the noise level of a textured image', () => {
    const w = 128
    const sigma = 0.02
    const r = rng(7)
    const rgb = new Float32Array(w * w * 3)
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        // 平滑渐变 + 一条硬边 + 噪声
        const base = 0.3 + 0.3 * (x / w) + (x > 80 ? 0.3 : 0)
        for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = base + sigma * r.normal()
      }
    for (const s of noiseSigma(rgb, w, w)) expect(Math.abs(s - sigma) / sigma).toBeLessThan(0.15)
  })
})

describe('fusion parameters', () => {
  const stats = (q: [number, number, number], chromaP90 = 0.1): LabStats => ({ quantiles: q, mean: [0, 0], cov: [0, 0, 0], chromaP90, weight: 1 })

  it('matches black level and midtones, lets highlights follow the exposure, and limits the contrast change', () => {
    const full = toneCurve(stats([0.2, 0.6, 0.9]), stats([0.1, 0.4, 0.7]), 1)
    expect(full.ys.map((y) => +y.toFixed(3))).toEqual([0.1, 0.4, 0.6])
    // 背景很平时，斜率被限制在下限，立绘的暗部不会被压成一片
    const flat = toneCurve(stats([0.2, 0.6, 0.9]), stats([0.45, 0.5, 0.52]), 1)
    expect(flat.ys[1] - flat.ys[0]).toBeCloseTo(0.4 * 0.4)
  })

  it('normalizes relighting to the frontal hemisphere average and only adds rim light for back lights', () => {
    const base = {
      fusion: DEFAULT_FUSION,
      size: { width: 800, height: 600 },
      background: null,
      stats: null,
      ambient: undefined,
      center: { x: 400, y: 300 },
      depth: 0.5,
    }
    const light = (direction: Vec3): Light => ({ ...newDirectionalLight(), direction, color: [1, 1, 1], intensity: 1, softness: 0 })
    const front = fusionParams({ ...base, lighting: { ...DEFAULT_LIGHTING, lights: [light([0, 0, 1])] } })
    // 正面光照下，朝向相机的法线 S(N) = 1，半球平均为 2/3
    expect(1 / front.inverseReference[0]).toBeCloseTo(2 / 3, 1)
    const unlit = fusionParams({ ...base, lighting: DEFAULT_LIGHTING })
    expect(unlit.relight).toBe(0)
    expect(unlit.rim).toBe(0)
  })
})

describe('placement', () => {
  it('stands the character on the ground point and reads the median background depth around it', () => {
    const doc: DocState = {
      ...initialDoc,
      background: { id: 'bg', name: 'bg', width: 100, height: 100, sourceWidth: 100, sourceHeight: 100, hasTransparency: false },
      character: { id: 'ch', name: 'ch', width: 20, height: 40, sourceWidth: 20, sourceHeight: 40, hasTransparency: true },
      charTransform: { x: 50, y: 50, scale: 1, rotation: 0, flipX: false },
    }
    const bbox = { x0: 0.25, y0: 0, x1: 0.75, y1: 0.9 }
    // 自动：包围盒底边中点；手动：用户设置的立绘 UV
    expect(characterGround(doc, doc.background!, bbox)).toEqual({ x: 50, y: 66 })
    const manual = { ...doc, fusion: { ...doc.fusion, ground: { u: 0.5, v: 0.5 } } }
    expect(characterGround(manual, doc.background!, bbox)).toEqual({ x: 50, y: 50 })

    // 背景深度为 0.6，接地点处有一个噪点，中位数不受影响
    const depth = Float32Array.from({ length: 100 }, (_, i) => (i === 6 * 10 + 5 ? 0 : 0.6))
    const result = { guideSize: { width: 10, height: 10 }, depth } as DepthResult
    expect(characterDepth(doc, result, bbox)).toBeCloseTo(0.6)
  })
})

describe('standing shadow', () => {
  const doc: DocState = {
    ...initialDoc,
    background: { id: 'bg', name: 'bg', width: 100, height: 100, sourceWidth: 100, sourceHeight: 100, hasTransparency: false },
    character: { id: 'ch', name: 'ch', width: 20, height: 40, sourceWidth: 20, sourceHeight: 40, hasTransparency: true },
    charTransform: { x: 50, y: 50, scale: 1, rotation: 0, flipX: false },
  }
  const background = { guideSize: { width: 10, height: 10 }, depth: new Float32Array(100).fill(0.6) } as DepthResult
  // 不透明区域：脚部（底部几行）横跨 u = 0.4–0.6
  const rows = new Float32Array(ROW_BINS * 2).fill(-1)
  for (let b = 0; b < ROW_BINS * 0.9; b++) rows.set([0.4, 0.6], b * 2)
  const info = { bbox: { x0: 0.25, y0: 0, x1: 0.75, y1: 0.9 }, reliefMedian: 0.5, rows, bottomCoverage: 0.2 }
  const sun = { ...newDirectionalLight(1), direction: [-0.5, 0.7, 0.5] as Vec3, softness: 0 }
  const lighting = { ...DEFAULT_LIGHTING, lights: [sun] }
  const ambient = new Array(27).fill(0)
  for (let c = 0; c < 3; c++) ambient[c] = 0.3 / 0.282095 / 0.886227

  it('casts away from the light, sized from the feet and tinted by the remaining light', () => {
    const p = shadowParams({ doc: { ...doc, lighting }, background, info, ambient })!
    // 光从左前上方来：影子朝右、朝画面深处
    expect(p.cast.along[0]).toBeGreaterThan(0.5)
    expect(p.cast.along[2]).toBeLessThan(-0.5)
    expect(p.cast.lateral[0]).toBeGreaterThan(0)
    expect(p.cast.tanElevation).toBeCloseTo(0.7 / Math.hypot(0.5, 0.5), 1)
    // 接触阴影宽度来自脚部跨度（4 px 的一半 × 1.15）
    expect(p.contact.axes[0]).toBeCloseTo(2 * 1.15)
    for (const c of p.cast.tint) {
      expect(c).toBeGreaterThan(0.2)
      expect(c).toBeLessThan(0.9)
    }
  })

  it('does not draw shadows for a cut-off half-body character unless the ground point is set', () => {
    const cut = { ...info, bbox: { ...info.bbox, y1: 1 }, bottomCoverage: 0.9 }
    expect(shadowParams({ doc, background, info: cut, ambient })).toBeNull()
    expect(shadowParams({ doc: { ...doc, fusion: { ...doc.fusion, ground: { u: 0.5, v: 0.9 } } }, background, info: cut, ambient })).not.toBeNull()
  })
})
