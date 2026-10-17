import { describe, expect, it } from 'vitest'
import { angleBetween, normalize } from './camera'
import { solveLinear } from './linalg'
import { directionality, directionalSh, evalSh, extractDominant, fitSh, type Vec3 } from './sh'

function noise(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 在整个球面上随机取法线，按“环境光 + 方向光”的 Lambert 模型着色，并混入反照率变化 */
function samples(light: Vec3, color: Vec3, ambient: Vec3, count: number, albedoNoise = 0) {
  const rnd = noise(7)
  const normals = new Float32Array(count * 3)
  const rgb = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const n = normalize([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1])
    normals.set(n, i * 3)
    const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2])
    // 少量样本的反照率大幅偏离，模拟纹理与离群点
    const albedo = rnd() < 0.15 ? 1 + albedoNoise * (rnd() * 2 - 1) : 1
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = albedo * (ambient[c] + color[c] * lambert)
  }
  return { normals, rgb, prior: new Float64Array(count).fill(1) }
}

describe('solveLinear', () => {
  it('solves a small system and rejects singular matrices', () => {
    const x = solveLinear([2, 1, 1, 3], [3, 5], 2)!
    expect(x[0]).toBeCloseTo(0.8)
    expect(x[1]).toBeCloseTo(1.4)
    expect(solveLinear([1, 2, 2, 4], [1, 2], 2)).toBeNull()
  })
})

describe('spherical harmonics', () => {
  it('approximates a clamped cosine light', () => {
    const d = normalize([0.3, 0.8, 0.5])
    const sh = directionalSh(d, [1, 1, 1])
    expect(evalSh(sh, d)[0]).toBeCloseTo(1.0625, 3)
    expect(directionality(sh)).toBeCloseTo(1, 5)
  })

  it('recovers the light direction despite albedo outliers', () => {
    const light = normalize([-0.5, 0.6, 0.62])
    const { normals, rgb, prior } = samples(light, [0.8, 0.7, 0.6], [0.15, 0.17, 0.2], 4000, 0.9)
    const fit = fitSh(normals, rgb, prior)!
    const dom = extractDominant(fit.sh)!
    expect((angleBetween(dom.direction, light) * 180) / Math.PI).toBeLessThan(3)
    expect(dom.color[0]).toBeGreaterThan(dom.color[2])
    // 环境光提取后仍为正，方向性明显低于纯方向光
    const amb = evalSh(dom.ambient, [0, 0, 1])
    expect(amb.every((v) => v > 0)).toBe(true)
    expect(directionality(dom.ambient)).toBeLessThan(directionality(fit.sh))
  })

  it('reports low directionality for uniform lighting', () => {
    const { normals, rgb, prior } = samples([0, 1, 0], [0, 0, 0], [0.5, 0.5, 0.5], 2000)
    const fit = fitSh(normals, rgb, prior)!
    expect(directionality(fit.sh)).toBeLessThan(0.05)
  })
})
