/**
 * 2 阶实球谐（9 个系数 × RGB）：基函数、方向光投影、求值、主方向光提取（docs/Plan.md §3.2 B）。
 *
 * 坐标系与法线一致：x 向右，y 向上，z 指向相机。
 * 系数描述的是 Lambert 表面上“辐照度 × 平均反照率”随法线的变化，即直接预测像素的线性值：
 *   B(n) = Σ e_k·Y_k(n)
 * 一个方向为 d、颜色为 c 的方向光贡献 c·max(0, n·d)，其球谐系数为 c·Â_l·Y_k(d)。
 */

import { robustLeastSquares, weightedLeastSquares } from './linalg'

export type Vec3 = [number, number, number]

/** RGB 球谐系数：长度 27，按 [k·3 + c] 存放 */
export type ShRgb = Float64Array

export const SH_COUNT = 9

/** 每个系数所属的阶 */
export const SH_BAND = [0, 1, 1, 1, 2, 2, 2, 2, 2] as const

/** 截断余弦核 max(0, cosθ) 的各阶系数 Â_l（Ramamoorthi & Hanrahan 2001） */
const A_HAT = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4]

/** Rec. 709 亮度权重 */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722]

/** 9 个基函数在单位向量 (x, y, z) 处的值。 */
export function shBasis(x: number, y: number, z: number, out: Float64Array = new Float64Array(SH_COUNT)): Float64Array {
  out[0] = 0.282095
  out[1] = 0.488603 * y
  out[2] = 0.488603 * z
  out[3] = 0.488603 * x
  out[4] = 1.092548 * x * y
  out[5] = 1.092548 * y * z
  out[6] = 0.315392 * (3 * z * z - 1)
  out[7] = 1.092548 * x * z
  out[8] = 0.546274 * (x * x - y * y)
  return out
}

/** 方向光 c·max(0, n·d) 的球谐投影。 */
export function directionalSh(d: Vec3, c: Vec3, out: ShRgb = new Float64Array(SH_COUNT * 3)): ShRgb {
  const y = shBasis(d[0], d[1], d[2])
  for (let k = 0; k < SH_COUNT; k++) {
    const v = A_HAT[SH_BAND[k]] * y[k]
    for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] = v * c[ch]
  }
  return out
}

/** 在法线 n 处求值（RGB）。 */
export function evalSh(sh: ShRgb, n: Vec3): Vec3 {
  const y = shBasis(n[0], n[1], n[2])
  const out: Vec3 = [0, 0, 0]
  for (let k = 0; k < SH_COUNT; k++) for (let ch = 0; ch < 3; ch++) out[ch] += sh[k * 3 + ch] * y[k]
  return out
}

/** 亮度通道的 9 个系数。 */
export function shLuma(sh: ShRgb): Float64Array {
  const out = new Float64Array(SH_COUNT)
  for (let k = 0; k < SH_COUNT; k++) out[k] = LUMA[0] * sh[k * 3] + LUMA[1] * sh[k * 3 + 1] + LUMA[2] * sh[k * 3 + 2]
  return out
}

/** 单个方向光的 ‖L1‖ / L0，用于把方向性归一化到 [0,1]。 */
export const DIRECTIONAL_RATIO = (A_HAT[1] * 0.488603) / (A_HAT[0] * 0.282095)

/** ‖L1‖ / L0（亮度），除以单个方向光的理论值后裁剪到 [0,1]：0 为完全漫射，1 为纯方向光。 */
export function directionality(sh: ShRgb): number {
  const l = shLuma(sh)
  if (l[0] <= 1e-9) return 0
  return Math.min(1, Math.hypot(l[1], l[2], l[3]) / l[0] / DIRECTIONAL_RATIO)
}

export interface DominantLight {
  /** 指向光源的单位向量 */
  direction: Vec3
  /** 线性 RGB，与像素值同一量纲 */
  color: Vec3
  /** 去掉该方向光之后的剩余环境光 */
  ambient: ShRgb
}

/**
 * 从球谐中提取主方向光（Sloan 2008 “Stupid SH Tricks”的做法）：
 * 方向取亮度 L1 带的方向；颜色按 L1 带最小二乘匹配；再从全部系数中减去它的投影得到环境光。
 * 为避免环境光被减成负数，L0 至少保留 minAmbient 的比例。
 */
export function extractDominant(sh: ShRgb, minAmbient = 0.1): DominantLight | null {
  const l = shLuma(sh)
  const len = Math.hypot(l[3], l[1], l[2])
  if (len <= 1e-9) return null
  const direction: Vec3 = [l[3] / len, l[1] / len, l[2] / len]
  const basis = shBasis(direction[0], direction[1], direction[2])
  const k1 = [1, 2, 3].map((k) => A_HAT[1] * basis[k])
  const k1Sq = k1[0] ** 2 + k1[1] ** 2 + k1[2] ** 2
  const k0 = A_HAT[0] * basis[0]
  const color: Vec3 = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    let dot = 0
    for (let i = 0; i < 3; i++) dot += sh[(i + 1) * 3 + ch] * k1[i]
    const cap = Math.max(0, ((1 - minAmbient) * sh[ch]) / k0)
    color[ch] = Math.min(cap, Math.max(0, dot / k1Sq))
  }
  const light = directionalSh(direction, color)
  const ambient = new Float64Array(sh.length)
  for (let i = 0; i < sh.length; i++) ambient[i] = sh[i] - light[i]
  return { direction, color, ambient }
}

export interface ShFitOptions {
  /** L1、L2 带的岭回归系数（相对 AᵀWA 对角线均值）；画面中的法线通常只覆盖朝向相机的半球，需要正则化 */
  ridge: [number, number]
  iterations: number
  huber: number
}

export const DEFAULT_SH_FIT: ShFitOptions = { ridge: [0.01, 0.1], iterations: 6, huber: 1.345 }

export interface ShFit {
  sh: ShRgb
  /** 最终权重（先验 × Huber） */
  weights: Float64Array
  /** 亮度拟合的决定系数 */
  r2: number
}

/**
 * 按 Lambert 假设拟合球谐：先在亮度上做 IRLS 得到稳健权重，再用同一组权重分别拟合 RGB。
 * @param normals 每个样本的单位法线（xyz 交错）
 * @param rgb 每个样本的线性 RGB（交错）
 * @param prior 每个样本的先验权重
 */
export function fitSh(normals: ArrayLike<number>, rgb: ArrayLike<number>, prior: Float64Array, options: ShFitOptions = DEFAULT_SH_FIT): ShFit | null {
  const n = prior.length
  const rows = new Float64Array(n * SH_COUNT)
  const basis = new Float64Array(SH_COUNT)
  const luma = new Float64Array(n)
  const channels = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  for (let i = 0; i < n; i++) {
    shBasis(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], basis)
    rows.set(basis, i * SH_COUNT)
    for (let ch = 0; ch < 3; ch++) channels[ch][i] = rgb[i * 3 + ch]
    luma[i] = LUMA[0] * rgb[i * 3] + LUMA[1] * rgb[i * 3 + 1] + LUMA[2] * rgb[i * 3 + 2]
  }
  const ridge = SH_BAND.map((b) => (b === 0 ? 0 : options.ridge[b - 1]))
  const robust = robustLeastSquares(rows, luma, prior, SH_COUNT, { ridge, iterations: options.iterations, huber: options.huber })
  if (!robust) return null
  const solved = weightedLeastSquares(rows, channels, robust.weights, SH_COUNT, ridge)
  if (!solved) return null
  const sh = new Float64Array(SH_COUNT * 3)
  for (let k = 0; k < SH_COUNT; k++) for (let ch = 0; ch < 3; ch++) sh[k * 3 + ch] = solved[ch][k]
  return { sh, weights: robust.weights, r2: robust.r2 }
}
