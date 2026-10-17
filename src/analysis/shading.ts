/**
 * 估计器 B：球谐拟合（docs/Plan.md §3.2）。
 *
 * 在非天空、法线可靠的像素上按 Lambert 假设拟合 2 阶球谐（IRLS/Huber），得到低频环境光。
 * 画面里的法线基本只覆盖朝向相机的半球，此时 L1 带的方向会有十度左右的系统偏差，
 * 所以只把它作为初值，再用“常数环境光 + 截断余弦方向光”模型做局部搜索来细化主光方向。
 * 只有前半球的数据时，球谐的 L0（全球面平均）并不可靠，减去主光后可能为负；
 * 因此环境光取与主光联合拟合的常数项（分通道），在融合确定主光之后计算，见 fuse.ts。
 */
import { normalize } from '@/algo/camera'
import { wrapDiffuse } from '@/algo/shading'
import { directionality, extractDominant, fitSh, LUMA, type ShRgb, type Vec3 } from '@/algo/sh'
import { kelvinToRgb, nearestKelvin } from '@/algo/kelvin'
import type { Scene } from './scene'

const MAX_SAMPLES = 15_000
/** 主光色温的范围：日落暖光到阴影处的冷光 */
const B_MIN_KELVIN = 2000
const B_MAX_KELVIN = 10000

export interface ShadingEstimate {
  /** 完整的球谐拟合（低频环境光照，含主光） */
  sh: ShRgb
  /** 主光方向（指向光源） */
  direction: Vec3
  /** 主光颜色（最大分量为 1）。反照率颜色会混进拟合结果，因此投影到普朗克轨迹上，只保留冷暖 */
  color: Vec3
  confidence: number
  /** ‖L1‖/L0 归一化到 [0,1] */
  directionality: number
  samples: number
  /**
   * 给定方向、软硬度和颜色时，与画面最吻合的光源强度，以及同时拟合出的常数环境光（分通道）。
   * 像素 ≈ ambient + color·intensity·wrap(n·d, softness)。
   */
  fitLight: (direction: Vec3, softness: number, color: Vec3) => { intensity: number; ambient: Vec3 }
}

interface Samples {
  normals: Float32Array
  rgb: Float32Array
  luma: Float64Array
  prior: Float64Array
}

/** 选取可用于拟合的像素：非天空、法线置信度高、未过曝。像素过多时等间隔抽样。 */
function selectSamples(scene: Scene): Samples {
  const n = scene.width * scene.height
  const ok = (i: number) => scene.sky[i] < 0.3 && scene.confidence[i] > 0.4 && !scene.clipped[i] && scene.luma[i] > 1e-4
  let count = 0
  for (let i = 0; i < n; i++) if (ok(i)) count++
  const stride = Math.max(1, Math.ceil(count / MAX_SAMPLES))
  const picked: number[] = []
  for (let i = 0, k = 0; i < n; i++) if (ok(i) && k++ % stride === 0) picked.push(i)
  const m = picked.length
  const s: Samples = { normals: new Float32Array(m * 3), rgb: new Float32Array(m * 3), luma: new Float64Array(m), prior: new Float64Array(m) }
  picked.forEach((i, j) => {
    for (let c = 0; c < 3; c++) {
      s.normals[j * 3 + c] = scene.normal[i * 3 + c]
      s.rgb[j * 3 + c] = scene.linear[i * 3 + c]
    }
    s.luma[j] = scene.luma[i]
    s.prior[j] = scene.confidence[i]
  })
  return s
}

interface LightFit {
  ambient: number
  light: number
  sse: number
}

/** 固定方向 d 时，y ≈ a + c·wrap(n·d, softness) 的加权最小二乘；c 为负时退化为只有常数项。 */
function fitAt(s: Samples, y: ArrayLike<number>, w: Float64Array, d: Vec3, softness = 0): LightFit {
  let sw = 0
  let sx = 0
  let sxx = 0
  let sy = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < w.length; i++) {
    const wi = w[i]
    if (wi <= 0) continue
    const x = wrapDiffuse(s.normals[i * 3] * d[0] + s.normals[i * 3 + 1] * d[1] + s.normals[i * 3 + 2] * d[2], softness)
    const v = y[i]
    sw += wi
    sx += wi * x
    sxx += wi * x * x
    sy += wi * v
    sxy += wi * x * v
    syy += wi * v * v
  }
  if (sw <= 0) return { ambient: 0, light: 0, sse: Infinity }
  const det = sw * sxx - sx * sx
  const c = det > 1e-12 * sw * sw ? (sw * sxy - sx * sy) / det : 0
  if (c <= 0) return { ambient: sy / sw, light: 0, sse: syy - (sy * sy) / sw }
  const a = (sy - c * sx) / sw
  return { ambient: a, light: c, sse: syy - a * sy - c * sxy }
}

/** 以 d0 为起点在球面上做模式搜索，最小化 fitAt 的残差。 */
function refineDirection(s: Samples, w: Float64Array, d0: Vec3): Vec3 {
  let d = d0
  let best = fitAt(s, s.luma, w, d).sse
  let step = 0.15
  for (let it = 0; it < 300 && step > 0.002; it++) {
    // 当前方向处的切平面基
    const helper: Vec3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const t1 = normalize([helper[1] * d[2] - helper[2] * d[1], helper[2] * d[0] - helper[0] * d[2], helper[0] * d[1] - helper[1] * d[0]])
    const t2: Vec3 = [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]]
    let moved = false
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cand = normalize([0, 1, 2].map((k) => d[k] + step * (a * t1[k] + b * t2[k])))
      const e = fitAt(s, s.luma, w, cand).sse
      if (e < best - 1e-12) {
        best = e
        d = cand
        moved = true
        break
      }
    }
    if (!moved) step /= 2
  }
  return d
}

/** 按 y ≈ a + c·max(0, n·d) 的残差更新 Huber 权重。 */
function huberWeights(s: Samples, d: Vec3, fit: LightFit, k = 1.345): Float64Array {
  const m = s.prior.length
  const res = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    const x = wrapDiffuse(s.normals[i * 3] * d[0] + s.normals[i * 3 + 1] * d[1] + s.normals[i * 3 + 2] * d[2], 0)
    res[i] = Math.abs(s.luma[i] - fit.ambient - fit.light * x)
  }
  const sorted = res.slice().sort()
  const sigma = 1.4826 * sorted[sorted.length >> 1]
  const out = new Float64Array(m)
  if (sigma <= 1e-12) return s.prior.slice()
  const delta = k * sigma
  for (let i = 0; i < m; i++) out[i] = s.prior[i] * (res[i] <= delta ? 1 : delta / res[i])
  return out
}

/** 法线分布的散布程度 1 - |加权平均法线|²：法线全部相同时为 0，均匀覆盖半球时为 0.75。 */
function normalSpread(s: Samples, w: Float64Array): number {
  let sw = 0
  const mean = [0, 0, 0]
  for (let i = 0; i < w.length; i++) {
    sw += w[i]
    for (let c = 0; c < 3; c++) mean[c] += w[i] * s.normals[i * 3 + c]
  }
  if (sw <= 0) return 0
  return 1 - (mean[0] ** 2 + mean[1] ** 2 + mean[2] ** 2) / (sw * sw)
}

export function estimateShading(scene: Scene): ShadingEstimate | null {
  const s = selectSamples(scene)
  const m = s.prior.length
  if (m < 200) return null
  const fit = fitSh(s.normals, s.rgb, s.prior)
  if (!fit) return null
  const dom = extractDominant(fit.sh)
  const ratio = directionality(fit.sh)
  let w = fit.weights
  // 闭包在估计结束后调用，使用最终的稳健权重
  const fitLight = (d: Vec3, softness: number, color: Vec3) => {
    const lumaFit = fitAt(s, s.luma, w, d, softness)
    const y = Math.max(1e-4, LUMA[0] * color[0] + LUMA[1] * color[1] + LUMA[2] * color[2])
    const intensity = lumaFit.light / y
    let sw = 0
    let sx = 0
    const sc = [0, 0, 0]
    for (let i = 0; i < m; i++) {
      const x = wrapDiffuse(s.normals[i * 3] * d[0] + s.normals[i * 3 + 1] * d[1] + s.normals[i * 3 + 2] * d[2], softness)
      sw += w[i]
      sx += w[i] * x
      for (let c = 0; c < 3; c++) sc[c] += w[i] * s.rgb[i * 3 + c]
    }
    // 环境光 = 平均颜色 − 光源的平均贡献，至少保留平均颜色的 10%
    const ambient = sc.map((v, c) => Math.max(0.1 * (v / sw), v / sw - color[c] * intensity * (sx / sw))) as Vec3
    return { intensity, ambient }
  }
  if (!dom) return { sh: fit.sh, direction: [0, 1, 0], color: [1, 1, 1], confidence: 0, directionality: 0, samples: m, fitLight }

  // 两轮：细化方向 → 按新模型的残差更新稳健权重 → 再细化
  let direction = refineDirection(s, w, dom.direction)
  w = huberWeights(s, direction, fitAt(s, s.luma, w, direction))
  direction = refineDirection(s, w, direction)
  const lumaFit = fitAt(s, s.luma, w, direction)

  // 固定方向，分通道求颜色
  const rgb = [0, 1, 2].map((c) => fitAt(s, Float64Array.from({ length: m }, (_, i) => s.rgb[i * 3 + c]), w, direction).light)
  // 分通道的颜色受朝光表面的反照率影响（例如朝上的草地让光偏绿），因此只保留冷暖：投影到普朗克轨迹
  const color = kelvinToRgb(nearestKelvin(rgb, B_MIN_KELVIN, B_MAX_KELVIN))

  // 置信度：方向性 × 法线覆盖度 × 拟合优度
  let sw = 0
  let sy = 0
  for (let i = 0; i < m; i++) {
    sw += w[i]
    sy += w[i] * s.luma[i]
  }
  let ssTot = 0
  for (let i = 0; i < m; i++) ssTot += w[i] * (s.luma[i] - sy / sw) ** 2
  const r2 = ssTot > 0 ? Math.max(0, 1 - lumaFit.sse / ssTot) : 0
  const coverage = Math.min(1, normalSpread(s, w) / 0.3)
  const confidence = lumaFit.light > 0 ? ratio * coverage * (0.5 + 0.5 * r2) : 0

  return { sh: fit.sh, direction, color, confidence, directionality: ratio, samples: m, fitLight }
}
