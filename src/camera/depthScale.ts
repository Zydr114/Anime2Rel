/**
 * 深度校准（docs/Plan.md §3.7 M8.6a）：深度模型给出的相对逆深度 d 只确定到尺度和偏移，按标定的地面换算成距离（米）。
 * 设沿光轴的距离 z 满足 1/z = a·d + b。视平线以下、不是天空的像素，按地面可以算出“假如这里是地面”的距离 z_g，
 * 用这些像素的 (d, 1/z_g) 先 RANSAC、再在内点上加权最小二乘拟合 a、b。站在地面上的物体比地面近，自然成为离群点。
 * 拟合不可靠时退回伪深度 1/(d + 平移量)，按地面像素的中位比例换算到米。
 */
import type { DepthScale } from '@/algo/camera'
import type { Size } from '@/algo/geometry'
import { DEFAULT_NORMAL_OPTIONS } from '@/algo/normals'
import type { DepthResult } from '@/depth/protocol'
import { groundPoint } from './geometry'
import type { CameraDoc } from './model'

/** 校准状态：按地面校准，或使用近似深度的原因 */
export const DEPTH_SCALE_STATES = ['ground', 'noDepth', 'noGround', 'fewInliers', 'narrow'] as const
export type DepthScaleState = (typeof DEPTH_SCALE_STATES)[number]

export interface CalibratedDepth extends DepthScale {
  state: DepthScaleState
  /** 地面一侧的采样数与其中符合地面的个数 */
  samples: number
  inliers: number
}

/** 采样点数的目标 */
const SAMPLES = 4000
/** 天空遮罩超过它的像素不参与 */
const SKY = 0.5
/** 地面距离超过相机高度的这么多倍时不参与：深度模型在远处已经分辨不出远近 */
const GROUND_FAR = 60
/** 最远距离：相机高度的倍数 */
const FAR = 300
const MIN_SAMPLES = 30
/** 内点：预测的 1/z 与地面的 1/z_g 相对误差不超过它 */
const INLIER = 0.15
/** 内点至少占地面一侧采样的比例和个数 */
const MIN_INLIER_RATIO = 0.15
const MIN_INLIERS = 30
/** 内点的 d 从 10% 到 90% 分位至少跨过这么多 */
const MIN_RANGE = 0.05
const ITERATIONS = 256

interface Sample {
  d: number
  /** 1/z_g */
  w: number
}

const shift = DEFAULT_NORMAL_OPTIONS.shift

function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

/** 相对误差意义下的加权最小二乘：最小化 Σ((a·d + b) / w − 1)² */
function refine(samples: Sample[]): [number, number] | null {
  let uu = 0
  let uv = 0
  let vv = 0
  let u1 = 0
  let v1 = 0
  for (const { d, w } of samples) {
    const u = d / w
    const v = 1 / w
    uu += u * u
    uv += u * v
    vv += v * v
    u1 += u
    v1 += v
  }
  const det = uu * vv - uv * uv
  if (!(Math.abs(det) > 1e-12)) return null
  return [(u1 * vv - v1 * uv) / det, (uu * v1 - uv * u1) / det]
}

const inliersOf = (samples: Sample[], a: number, b: number) => samples.filter(({ d, w }) => Math.abs(a * d + b - w) <= INLIER * w)

function fit(samples: Sample[]): { a: number; b: number; inliers: Sample[] } | null {
  // 固定种子，同样的输入得到同样的结果
  let seed = 1
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  let best: { a: number; b: number; count: number } | null = null
  for (let k = 0; k < ITERATIONS; k++) {
    const p = samples[Math.floor(random() * samples.length)]
    const q = samples[Math.floor(random() * samples.length)]
    if (Math.abs(p.d - q.d) < 0.02) continue
    const a = (p.w - q.w) / (p.d - q.d)
    if (!(a > 0)) continue
    const b = p.w - a * p.d
    const count = inliersOf(samples, a, b).length
    if (!best || count > best.count) best = { a, b, count }
  }
  if (!best) return null
  let { a, b } = best
  let inliers = inliersOf(samples, a, b)
  for (let round = 0; round < 2 && inliers.length >= 2; round++) {
    const r = refine(inliers)
    if (!r || !(r[0] > 0)) break
    ;[a, b] = r
    inliers = inliersOf(samples, a, b)
  }
  return { a, b, inliers }
}

/** 按相机标定换算深度；depth 为背景的深度估计结果 */
export function calibrateDepth(camera: CameraDoc, size: Size, depth: DepthResult | undefined): CalibratedDepth {
  const far = FAR * camera.height
  // 近似：伪深度按比例换算，没有地面时最近处在相机高度的距离上
  const approx = (state: DepthScaleState, samples: Sample[]): CalibratedDepth => {
    const k = samples.length ? quantile(samples.map(({ d, w }) => w / (Math.max(d, 0) + shift)), 0.5) : 1 / (camera.height * (1 + shift))
    return { a: k, b: k * shift, far, state, samples: samples.length, inliers: 0 }
  }
  if (!depth) return approx('noDepth', [])

  const { width: gw, height: gh } = depth.guideSize
  const step = Math.max(1, Math.floor(Math.sqrt((gw * gh) / SAMPLES)))
  const samples: Sample[] = []
  const scene: number[] = []
  for (let y = Math.floor(step / 2); y < gh; y += step)
    for (let x = Math.floor(step / 2); x < gw; x += step) {
      const i = y * gw + x
      if (depth.sky && depth.sky[i] > SKY) continue
      const d = depth.depth[i]
      scene.push(d)
      const g = groundPoint(camera, size, { x: ((x + 0.5) * size.width) / gw, y: ((y + 0.5) * size.height) / gh })
      if (g && -g[2] < GROUND_FAR * camera.height) samples.push({ d, w: -1 / g[2] })
    }
  if (samples.length < MIN_SAMPLES) return approx('noGround', samples)

  const result = fit(samples)
  if (!result || result.inliers.length < Math.max(MIN_INLIERS, MIN_INLIER_RATIO * samples.length)) return approx('fewInliers', samples)
  const ds = result.inliers.map((s) => s.d)
  if (quantile(ds, 0.9) - quantile(ds, 0.1) < MIN_RANGE) return approx('narrow', samples)
  // 比照片中最远的景物还远的部分当作远处
  const farthest = result.a * quantile(scene, 0.02) + result.b
  return { a: result.a, b: result.b, far: farthest > 0 ? Math.min(far, 1 / farthest) : far, state: 'ground', samples: samples.length, inliers: result.inliers.length }
}

const cache = new WeakMap<DepthResult, { key: string; value: CalibratedDepth }>()

/** 带缓存的 calibrateDepth：同一份深度、同样的标定只拟合一次 */
export function depthScaleFor(camera: CameraDoc, size: Size, depth: DepthResult | undefined): CalibratedDepth {
  if (!depth) return calibrateDepth(camera, size, depth)
  const key = [camera.fovDeg, camera.pitch, camera.roll, camera.height, size.width, size.height].join()
  const hit = cache.get(depth)
  if (hit?.key === key) return hit.value
  const value = calibrateDepth(camera, size, depth)
  cache.set(depth, { key, value })
  return value
}
