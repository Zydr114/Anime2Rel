/**
 * 仅供测试：光线追踪生成合成场景（地面 + 若干球体 + 天空），输出 sRGB 图像、归一化逆深度和天空遮罩。
 * 深度按 d = k/Z - β 生成，与法线估计的伪深度模型一致，因此由深度恢复的法线是准确的。
 */
import { normalize, pixelToRay } from '@/algo/camera'
import { linearToSrgb } from '@/algo/color'
import { DEFAULT_NORMAL_OPTIONS } from '@/algo/normals'
import type { Vec3 } from '@/algo/sh'

export interface SyntheticLight {
  /** 指向光源的单位向量；null 表示没有方向光（阴天） */
  direction: Vec3 | null
  color: Vec3
  /** 常数环境光 */
  ambient: Vec3
  /** 来自上方的半球天空光（阴天）：E += sky·(1 + n_y)/2 */
  skyLight?: Vec3
  /** 太阳在画面内时画出过曝的日轮与光晕 */
  sunInView?: boolean
  /** 前景中的自发光灯（文档像素位置与半径），画成过曝的圆 */
  lamp?: { x: number; y: number; r: number }
  /** 夜空 */
  night?: boolean
}

export interface SyntheticScene {
  width: number
  height: number
  rgba: Uint8ClampedArray
  depth: Float32Array
  sky: Float32Array
  /** 解析法线（xyz 交错，天空为 (0,0,1)） */
  normal: Float32Array
}

interface Sphere {
  c: Vec3
  r: number
  albedo: Vec3
}

const GROUND_Y = -1.5
const SPHERES: Sphere[] = [
  { c: [-1.6, GROUND_Y + 0.9, -7], r: 0.9, albedo: [0.7, 0.35, 0.3] },
  { c: [1.4, GROUND_Y + 1.2, -9], r: 1.2, albedo: [0.4, 0.55, 0.7] },
  { c: [0.1, GROUND_Y + 0.6, -5.5], r: 0.6, albedo: [0.6, 0.6, 0.55] },
  { c: [-3.5, GROUND_Y + 1.5, -13], r: 1.5, albedo: [0.55, 0.5, 0.35] },
  { c: [3.6, GROUND_Y + 0.8, -6.5], r: 0.8, albedo: [0.5, 0.4, 0.6] },
]

function hitSphere(o: Vec3, d: Vec3, s: Sphere): number {
  const oc = [o[0] - s.c[0], o[1] - s.c[1], o[2] - s.c[2]]
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2]
  const c = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - s.r * s.r
  const disc = b * b - c
  if (disc < 0) return Infinity
  const t = -b - Math.sqrt(disc)
  return t > 1e-4 ? t : Infinity
}

const encode = (v: number) => Math.round(linearToSrgb(v) * 255)

export function renderScene(width: number, height: number, light: SyntheticLight, fovDeg = 60): SyntheticScene {
  const size = { width, height }
  const n = width * height
  const rgba = new Uint8ClampedArray(n * 4)
  const depth = new Float32Array(n)
  const sky = new Float32Array(n)
  const normals = new Float32Array(n * 3)
  const beta = DEFAULT_NORMAL_OPTIONS.shift
  // 画面底边处地面的距离作为最近距离，对应逆深度 1
  const bottom = pixelToRay({ x: width / 2, y: height - 0.5 }, size, fovDeg)
  const k = (1 + beta) * (GROUND_Y / bottom[1]) * -bottom[2]

  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const d = pixelToRay({ x: x + 0.5, y: y + 0.5 }, size, fovDeg)
      let t = Infinity
      let normal: Vec3 = [0, 1, 0]
      let albedo: Vec3 = [0, 0, 0]
      for (const s of SPHERES) {
        const ts = hitSphere([0, 0, 0], d, s)
        if (ts < t) {
          t = ts
          normal = normalize([d[0] * ts - s.c[0], d[1] * ts - s.c[1], d[2] * ts - s.c[2]])
          albedo = s.albedo
        }
      }
      if (d[1] < 0) {
        const tg = GROUND_Y / d[1]
        if (tg < t) {
          t = tg
          normal = [0, 1, 0]
          const gx = d[0] * tg
          const gz = d[2] * tg
          const checker = (Math.floor(gx / 1.2) + Math.floor(gz / 1.2)) & 1
          albedo = checker ? [0.42, 0.4, 0.3] : [0.3, 0.33, 0.24]
        }
      }
      let rgb: Vec3
      let emissive = false
      if (light.lamp) {
        const dx = x + 0.5 - light.lamp.x
        const dy = y + 0.5 - light.lamp.y
        if (dx * dx + dy * dy < light.lamp.r ** 2) emissive = true
      }
      if (emissive) {
        rgb = [1.5, 1.3, 0.9]
        depth[i] = 0.7
      } else if (t === Infinity) {
        sky[i] = 1
        depth[i] = 0
        normals.set([0, 0, 1], i * 3)
        // 天空：越靠近地平线越亮，越靠近太阳越亮
        const up = Math.max(0, d[1])
        let base: Vec3 = light.night ? [0.01, 0.012, 0.02] : light.skyLight ? [0.55, 0.57, 0.6] : [0.25 + 0.2 * (1 - up), 0.4 + 0.2 * (1 - up), 0.75]
        if (light.direction && !light.skyLight) {
          const cos = d[0] * light.direction[0] + d[1] * light.direction[1] + d[2] * light.direction[2]
          const glow = Math.exp((cos - 1) / 0.15) * 0.8 + 0.25 * (cos + 1)
          base = base.map((v) => v * (0.7 + glow)) as Vec3
          if (light.sunInView && cos > Math.cos(0.04)) base = [4, 4, 3.8]
        }
        rgb = base
      } else {
        const p: Vec3 = [d[0] * t, d[1] * t, d[2] * t]
        let e: Vec3 = [...light.ambient]
        if (light.skyLight) e = e.map((v, c) => v + light.skyLight![c] * (1 + normal[1]) * 0.5) as Vec3
        if (light.direction) {
          const l = light.direction
          const lambert = Math.max(0, normal[0] * l[0] + normal[1] * l[1] + normal[2] * l[2])
          const shadowed = lambert > 0 && SPHERES.some((s) => hitSphere([p[0] + normal[0] * 1e-3, p[1] + normal[1] * 1e-3, p[2] + normal[2] * 1e-3], l, s) < Infinity)
          if (!shadowed) e = e.map((v, c) => v + light.color[c] * lambert) as Vec3
        }
        rgb = albedo.map((a, c) => a * e[c]) as Vec3
        depth[i] = Math.min(1, Math.max(0, k / -p[2] - beta))
        normals.set(normal, i * 3)
      }
      rgba[i * 4] = encode(rgb[0])
      rgba[i * 4 + 1] = encode(rgb[1])
      rgba[i * 4 + 2] = encode(rgb[2])
      rgba[i * 4 + 3] = 255
    }
  return { width, height, rgba, depth, sky, normal: normals }
}
