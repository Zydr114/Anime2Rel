import { describe, expect, it } from 'vitest'
import { kelvinToRgb, nearestKelvin } from '@/algo/kelvin'
import { oklabImage } from '@/algo/oklab'
import type { Vec3 } from '@/algo/sh'
import { DEFAULT_LIGHTING, newDirectionalLight, type Light } from '@/lighting/model'
import { DEFAULT_FUSION } from './model'
import { characterNormals, inflateNormals, lineArtMask } from './normals'
import { fusionParams, toneCurve } from './params'
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

  it('maps character quantiles onto the background and limits the contrast change', () => {
    const full = toneCurve(stats([0.2, 0.6, 0.9]), stats([0.1, 0.4, 0.7]), 1)
    expect(full.ys.map((y) => +y.toFixed(3))).toEqual([0.1, 0.4, 0.7])
    // 背景很平时，斜率被限制在下限，立绘不会被压成一片
    const flat = toneCurve(stats([0.2, 0.6, 0.9]), stats([0.45, 0.5, 0.52]), 1)
    expect(flat.ys[2] - flat.ys[1]).toBeCloseTo(0.4 * 0.3)
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
