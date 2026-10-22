import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/algo/sh'
import { normalize } from '@/algo/camera'
import { DEFAULT_DUST, DEFAULT_FOG } from './model'
import { DUST_LAYERS, dustLayers, dustParams, fogParams, fogTransmittance, opticalDepth, type AtmosphereView } from './params'

const UP: Vec3 = [0, 1, 0]
const size = { width: 1600, height: 900 }
const view: AtmosphereView = { scale: { a: 1, b: 0.01, far: 100 }, height: 1.6, up: UP, focal: 1400, docLong: 1600, lights: [] }

/** 沿视线数值积分的光学厚度（浓度随离地高度指数衰减） */
function integrate(sigma: number, start: number, falloff: number, height: number, dir: Vec3, distance: number) {
  const n = 20000
  const dt = (distance - start) / n
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t = start + (i + 0.5) * dt
    sum += sigma * Math.exp(-falloff * Math.max(height + t * dir[1], 0)) * dt
  }
  return sum
}

describe('fog', () => {
  it('accumulates σ per metre beyond the start distance when the density is uniform', () => {
    const fog = { sigma: 0.2, start: 5, falloff: 0 }
    expect(opticalDepth(fog, view, normalize([0.3, -0.1, -1]), 20)).toBeCloseTo(0.2 * 15)
    expect(opticalDepth(fog, view, normalize([0, 0, -1]), 3)).toBe(0)
  })

  it('matches numeric integration when the density falls off with height', () => {
    const fog = { sigma: 0.1, start: 2, falloff: 0.8 }
    for (const dir of [normalize([0, 0.3, -1]), normalize([0, -0.05, -1]), normalize([0.2, 0, -1])]) {
      expect(opticalDepth(fog, view, dir, 25)).toBeCloseTo(integrate(fog.sigma, fog.start, fog.falloff, view.height, dir, 25), 4)
    }
  })

  it('never makes the fog below the ground thicker than at the ground', () => {
    const fog = { sigma: 0.1, start: 0, falloff: 1.5 }
    const down = normalize([0, -1, -1])
    expect(opticalDepth(fog, { height: 0, up: UP }, down, 10)).toBeCloseTo(0.1 * 10)
    expect(opticalDepth(fog, view, down, 10)).toBeLessThanOrEqual(0.1 * 10)
  })

  it('lets less of the scene through the farther it is', () => {
    const fog = fogParams({ ...DEFAULT_FOG, density: 0.5, falloff: 0.3 }, [0.7, 0.7, 0.7])
    const p = { x: 800, y: 500 }
    const t = [0.9, 0.5, 0.2, 0.05].map((depth) => fogTransmittance(fog, view, p, depth, size))
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeLessThan(t[i - 1])
    expect(t[0]).toBeLessThan(1)
  })
})

describe('dust', () => {
  const dust = dustParams({ ...DEFAULT_DUST, amount: 1, near: 0.3, far: 8 }, { blades: 0, rotation: 0 })
  const sharp = { focus: 0.5, aperture: 0, range: 0 }
  const blurred = { focus: 0.5, aperture: 0.1, range: 0 }

  it('splits near…far into contiguous layers that hold the requested number of particles', () => {
    const layers = dustLayers(dust, view, sharp)
    expect(layers).toHaveLength(DUST_LAYERS)
    expect(layers[0].near).toBeCloseTo(1 / dust.near)
    expect(layers[DUST_LAYERS - 1].far).toBeCloseTo(1 / dust.far)
    for (let k = 1; k < DUST_LAYERS; k++) expect(layers[k].near).toBeCloseTo(layers[k - 1].far)
    // 每个基础单元一个颗粒：总数 = 密度 × 视锥体积
    const count = layers.reduce((sum, l) => sum + (size.width * size.height) / (l.cell * l.cell), 0)
    const volume = (size.width * size.height * (dust.far ** 3 - dust.near ** 3)) / (3 * view.focal ** 2)
    expect(count / (dust.density * volume)).toBeCloseTo(1)
  })

  it('enlarges cells by powers of two for wide bokeh without moving the base grid', () => {
    const [a, b] = [dustLayers(dust, view, sharp), dustLayers(dust, view, blurred)]
    for (let k = 0; k < DUST_LAYERS; k++) {
      expect(b[k].cell).toBe(a[k].cell)
      expect(b[k].scale).toBeGreaterThanOrEqual(a[k].scale)
      expect(Math.log2(b[k].scale) % 1).toBe(0)
      expect(b[k].reach).toBeLessThanOrEqual(2)
    }
    // 最远一层颗粒最密，大光圈下散景比单元大
    expect(b[DUST_LAYERS - 1].scale).toBeGreaterThan(1)
    // 光圈稍有变化时多数层的放大倍数不变，颗粒不会整体跳动
    const nudged = dustLayers(dust, view, { ...blurred, aperture: blurred.aperture * 1.02 })
    expect(nudged.filter((l, k) => l.scale === b[k].scale).length).toBeGreaterThanOrEqual(DUST_LAYERS - 1)
  })
})
