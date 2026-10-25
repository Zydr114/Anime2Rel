/**
 * 离地遮蔽与地面反光（docs/Plan.md M8.8d）。着色在重光照中进行（src/engine/fusion.ts），这里是地面颜色的取样和与着色器一致的公式。
 *
 * 两者都按立绘正面每一处到地面平面的高度 h 计算。地面平面过接地点，法线为相机标定给出的上方向，与站立阴影相同。
 * 地面颜色取自背景照片本身：接地点周围、与地面平面深度一致、不是天空的像素的平均线性颜色，不算新增的光。
 */
import { sceneDepth, type DepthScale } from '@/algo/camera'
import type { Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'

/** 地面颜色的取样半径（相对人物高度） */
export const BOUNCE_RADIUS = 0.5
/** 深度与地面平面的相对偏差在这个值以内的像素才算地面（与贴合表面吸附到平面的范围一致） */
const GROUND_DEVIATION = 0.15
/** 有效像素少于这个数时不取地面颜色 */
const MIN_PIXELS = 40

export interface GroundSampling {
  /** 接地点与地面法线（相机空间） */
  point: Vec3
  up: Vec3
  /** 取样半径（与 point 同单位） */
  radius: number
  /** 焦距与尺寸（文档像素） */
  focal: number
  size: Size
  depthScale: DepthScale
}

/** 统计分辨率的背景：线性颜色（rgb 交错）、归一化逆深度与天空遮罩 */
export interface GroundImage {
  width: number
  height: number
  linear: Float32Array
  depth: Float32Array | null
  sky: Float32Array | null
}

/** 接地点周围地面的平均线性颜色；没有深度或有效像素不足时为 null */
export function groundColor(image: GroundImage, s: GroundSampling): Vec3 | null {
  const { width, height, linear, depth, sky } = image
  if (!depth) return null
  const { point, up, radius, focal, size } = s
  // 地面平面：dot(x, up) = dot(point, up)；视线 x = t · ray，ray 的 z 分量为 −1，t 就是距离
  const offset = point[0] * up[0] + point[1] * up[1] + point[2] * up[2]
  const sum = [0, 0, 0]
  let count = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sky && sky[i] >= 0.5) continue
      const rx = (((x + 0.5) / width) * size.width - size.width / 2) / focal
      const ry = (size.height / 2 - ((y + 0.5) / height) * size.height) / focal
      const denom = rx * up[0] + ry * up[1] - up[2]
      if (Math.abs(denom) < 1e-6) continue
      const t = offset / denom
      if (t <= 0) continue
      const z = sceneDepth(depth[i], s.depthScale)
      if (Math.abs(z - t) / t > GROUND_DEVIATION) continue
      const dx = rx * t - point[0]
      const dy = ry * t - point[1]
      const dz = -t - point[2]
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue
      for (let c = 0; c < 3; c++) sum[c] += linear[i * 3 + c]
      count++
    }
  return count >= MIN_PIXELS ? (sum.map((v) => v / count) as Vec3) : null
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 离地遮蔽系数，乘在环境光上；与着色器一致。朝下的面遮蔽得更多，朝上和侧向的面只有 40%。
 * @param h 到地面平面的高度；range 为范围（同单位）；nUp 为法线与上方向的点积
 */
export function groundOcclusion(strength: number, range: number, h: number, nUp: number): number {
  return 1 - strength * (1 - smoothstep(0, range, h)) * (0.4 + 0.6 * Math.max(-nUp, 0))
}
