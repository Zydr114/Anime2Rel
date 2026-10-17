/** 灰球预览与重光照共用的漫反射着色（CPU 版本；GPU 版本见 src/engine/passes.ts，两者需保持一致）。 */
import { evalSh, type ShRgb, type Vec3 } from './sh'

export interface ShadeLight {
  /** 指向光源的单位向量 */
  direction: Vec3
  /** 线性 RGB，已乘以强度和衰减 */
  color: Vec3
  /** 软硬度 [0,1]：0 为 Lambert，1 时明暗交界线推到背面（近似半球天空光） */
  softness: number
}

/** wrap Lambert：max(0, (cosθ + s) / (1 + s))。 */
export function wrapDiffuse(cos: number, softness: number): number {
  return Math.max(0, (cos + softness) / (1 + softness))
}

/** 点光源按 2.5D 距离衰减：距离等于参考距离时衰减到一半。 */
export function pointAttenuation(distance: number, reference: number): number {
  const r = distance / Math.max(reference, 1e-6)
  return 1 / (1 + r * r)
}

/** 法线 n 处的辐照度 × 平均反照率（与背景像素同一量纲）。 */
export function shade(n: Vec3, ambient: ShRgb, lights: readonly ShadeLight[]): Vec3 {
  const out = evalSh(ambient, n).map((v) => Math.max(0, v)) as Vec3
  for (const l of lights) {
    const k = wrapDiffuse(n[0] * l.direction[0] + n[1] * l.direction[1] + n[2] * l.direction[2], l.softness)
    for (let c = 0; c < 3; c++) out[c] += l.color[c] * k
  }
  return out
}
