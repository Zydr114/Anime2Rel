/**
 * 候选融合与阴天判定（docs/Plan.md §3.2）。
 *
 * - 方向光候选：A 中位于天空的光源（相机穿过该像素的射线）、B 的主光、C/D 的像平面方位
 *   （借用 B 的前后分量补成三维）。夹角小于 25° 的按置信度加权合并，置信度按“或”的概率合成。
 * - 点光源候选：A 中位于前景的光源，位置为 (x, y, z(d))。
 * - 最终保留置信度最高的 3 个。方向光的强度按“给定方向时与画面最吻合”的原则由 B 的样本求得，
 *   环境光取与排名第一的方向光联合拟合的常数项。
 * - 阴天：天空占比高、亮度平坦、方向性弱且看不到太阳时，标记为漫射主导，主光换成来自上方的天空光。
 *   另要求天空本身是亮的，排除同样平坦的夜空。
 */
import { angleBetween, normalize, pixelToRay } from '@/algo/camera'
import { normalizeColor } from '@/algo/kelvin'
import { quantiles } from '@/algo/raster'
import { LUMA, type ShRgb, type Vec3 } from '@/algo/sh'
import type { ContourEstimate } from './contours'
import type { Estimator, LightCandidate } from './protocol'
import type { Scene } from './scene'
import type { ShadingEstimate } from './shading'
import type { SkyGradientEstimate, SkyStats } from './skyGradient'
import type { VisibleLight } from './visible'

export const MERGE_ANGLE = (25 * Math.PI) / 180
export const MAX_CANDIDATES = 3
/** 只有像平面方位（C/D）的候选需要更高的置信度才保留 */
const MIN_CONFIDENCE = 0.12
const MIN_PLANAR_CONFIDENCE = 0.2
const POINT_INTENSITY = 0.3
/** 漫射主导时天空光的方向：上方略偏向相机 */
export const SKY_LIGHT_DIRECTION = normalize([0, 1, 0.25])

export interface FuseInput {
  scene: Scene
  visible: VisibleLight[]
  shading: ShadingEstimate | null
  contour: ContourEstimate | null
  skyGradient: SkyGradientEstimate | null
  sky: SkyStats
  contrast: number
}

export interface FuseOutput {
  candidates: LightCandidate[]
  diffuse: boolean
  ambient: ShRgb
}

interface Directional {
  direction: Vec3
  confidence: number
  /** 合并方向时的额外权重（可见光源的位置最准确） */
  weight: number
  color: Vec3 | null
  softness: number
  source: Estimator
}

interface Cluster {
  sum: Vec3
  members: Directional[]
}

/** 常数环境光的球谐表示（只有 L0）。 */
function constantSh(c: Vec3): ShRgb {
  const sh = new Float64Array(27)
  for (let k = 0; k < 3; k++) sh[k] = c[k] / 0.282095
  return sh
}

const ramp = (v: number, from: number, to: number) => Math.min(1, Math.max(0, (v - from) / (to - from)))

/** 像平面方位 → 三维方向：前后分量借用 B 的主光，没有时假设略偏向相机。 */
function lift(angle: number, shading: ShadingEstimate | null): Vec3 {
  const z = shading && shading.confidence > 0 ? shading.direction[2] : 0.3
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return [Math.cos(angle) * r, Math.sin(angle) * r, z]
}

/** 没有可用的拟合时，用非天空像素的中位颜色作为常数环境光。 */
function medianColor(scene: Scene): Vec3 {
  const mask = Uint8Array.from(scene.sky, (s) => (s < 0.5 ? 1 : 0))
  return [0, 1, 2].map((c) => {
    const channel = Float32Array.from({ length: scene.width * scene.height }, (_, i) => scene.linear[i * 3 + c])
    return (quantiles(channel, [0.5], mask) ?? quantiles(channel, [0.5])!)[0]
  }) as Vec3
}

function mergeDirectional(list: Directional[]): Cluster[] {
  const clusters: Cluster[] = []
  for (const d of [...list].sort((a, b) => b.confidence - a.confidence)) {
    let best: Cluster | null = null
    let bestAngle = MERGE_ANGLE
    for (const c of clusters) {
      const a = angleBetween(normalize(c.sum), d.direction)
      if (a < bestAngle) {
        best = c
        bestAngle = a
      }
    }
    const w = d.confidence * d.weight
    if (best) {
      for (let k = 0; k < 3; k++) best.sum[k] += d.direction[k] * w
      best.members.push(d)
    } else {
      clusters.push({ sum: [d.direction[0] * w, d.direction[1] * w, d.direction[2] * w], members: [d] })
    }
  }
  return clusters
}

function clusterToCandidate(c: Cluster): LightCandidate {
  const confidence = 1 - c.members.reduce((p, m) => p * (1 - m.confidence), 1)
  const colored = c.members.filter((m) => m.color)
  const color = colored.length ? normalizeColor([0, 1, 2].map((k) => colored.reduce((s, m) => s + m.color![k] * m.confidence, 0))) : ([1, 1, 1] as Vec3)
  const lead = c.members[0]
  return {
    type: 'directional',
    direction: normalize(c.sum),
    position: null,
    color,
    intensity: 0,
    softness: lead.softness,
    confidence,
    sources: [...new Set(c.members.map((m) => m.source))].sort(),
  }
}

export function fuse(input: FuseInput): FuseOutput {
  const { scene, visible, shading, contour, skyGradient, sky, contrast } = input
  const size = { width: scene.width, height: scene.height }
  const fallback = medianColor(scene)
  // 拟合不出强度时（如光从背后照来、画面里几乎没有受光面）按环境光估一个
  const fallbackIntensity = Math.max(0.05, 1.5 * (LUMA[0] * fallback[0] + LUMA[1] * fallback[1] + LUMA[2] * fallback[2]))
  const intensityOf = (c: LightCandidate) => {
    const v = shading ? shading.fitLight(c.direction, c.softness, c.color).intensity : 0
    return v > 1e-4 ? v : fallbackIntensity
  }

  const directional: Directional[] = []
  const points: LightCandidate[] = []
  for (const v of visible) {
    if (v.inSky) {
      const direction = pixelToRay({ x: v.x, y: v.y }, size, scene.fovDeg)
      directional.push({ direction, confidence: v.confidence, weight: 3, color: v.color, softness: 0.1, source: 'A' })
    } else {
      points.push({
        type: 'point',
        direction: [0, 0, 1],
        position: { u: v.x / scene.width, v: v.y / scene.height, depth: v.depth },
        color: v.color,
        // 灯具的亮度无法从画面推断，给一个明显可见的默认值
        intensity: Math.max(POINT_INTENSITY, fallbackIntensity),
        softness: 0.4,
        confidence: v.confidence,
        sources: ['A'],
      })
    }
  }
  if (shading && shading.confidence > 0) {
    directional.push({ direction: shading.direction, confidence: shading.confidence, weight: 1, color: shading.color, softness: 0.15, source: 'B' })
  }
  if (contour) directional.push({ direction: lift(contour.angle, shading), confidence: contour.confidence, weight: 1, color: null, softness: 0.3, source: 'C' })
  if (skyGradient) directional.push({ direction: lift(skyGradient.angle, shading), confidence: skyGradient.confidence, weight: 1, color: null, softness: 0.3, source: 'D' })

  let candidates = mergeDirectional(directional)
    .map(clusterToCandidate)
    .filter((c) => c.confidence >= (c.sources.some((s) => s === 'A' || s === 'B') ? MIN_CONFIDENCE : MIN_PLANAR_CONFIDENCE))

  // 阴天判定
  const sunVisible = visible.some((v) => v.inSky)
  const directionality = shading ? shading.directionality : 1
  const overcast = ramp(sky.fraction, 0.03, 0.15) * ramp(sky.luma, 0.04, 0.1) * ramp(sky.variation, 0.35, 0.15) * ramp(contrast, 7, 3.5) * ramp(directionality, 0.5, 0.25)
  const diffuse = !sunVisible && overcast >= 0.5
  if (diffuse) {
    candidates = [
      {
        type: 'directional',
        direction: SKY_LIGHT_DIRECTION,
        position: null,
        color: sky.color,
        intensity: 0,
        softness: 1,
        confidence: overcast,
        sources: shading ? ['B', 'D'] : ['D'],
      },
    ]
  }
  for (const c of candidates) c.intensity = intensityOf(c)

  const all = [...candidates, ...points].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CANDIDATES)
  const main = all.find((c) => c.type === 'directional')
  const ambient = constantSh(shading && main ? shading.fitLight(main.direction, main.softness, main.color).ambient : fallback)
  return { candidates: all, diffuse, ambient }
}
