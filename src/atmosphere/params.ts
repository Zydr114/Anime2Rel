/**
 * 雾与尘埃的渲染参数（docs/Plan.md §3.7 M8.8c），GPU 实现见 src/engine/atmosphere.ts。
 * 距离按深度校准换算成米，视线方向、离地高度按相机标定计算（相机空间：x 右、y 上、z 指向相机）。
 */
import { normalize, sceneDepth, unproject, type DepthScale } from '@/algo/camera'
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { hexToLinear } from '@/algo/color'
import { cameraFocal, cameraUp } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import type { Light } from '@/lighting/model'
import type { FogParams as FogDoc } from './model'

/** 浓度为 1 时的消光系数（1/米）：10 米外只剩 5%。浓度按平方换算，低浓度一端更细 */
export const SIGMA_MAX = 0.3
/** 高度衰减为 1 时，浓度每升高 1 米衰减到 e^−1.5 */
export const FALLOFF_MAX = 1.5

/** 照亮雾和尘埃的光源：方向光为指向光源的单位向量，点光源为相机空间的位置（米）；颜色已乘以强度 */
export interface AtmosphereLight {
  type: Light['type']
  vector: Vec3
  color: Vec3
}

/** 雾和尘埃共用的场景信息 */
export interface AtmosphereView {
  scale: DepthScale
  /** 相机离地高度（米）、世界的上方向（相机空间）、焦距（文档像素） */
  height: number
  up: Vec3
  focal: number
  lights: AtmosphereLight[]
}

export interface FogParams {
  /** 地面处的消光系数（1/米） */
  sigma: number
  start: number
  /** 浓度随高度衰减的速度（1/米） */
  falloff: number
  /** 雾色（线性） */
  color: Vec3
  light: number
  noise: number
  noiseSize: number
  sky: boolean
}

export function atmosphereView(camera: CameraDoc, size: Size, scale: DepthScale, lights: readonly Light[]): AtmosphereView {
  return {
    scale,
    height: camera.height,
    up: cameraUp(camera),
    focal: cameraFocal(camera, size),
    lights: lights
      .filter((l) => l.enabled && l.intensity > 0)
      .map((l) => ({
        type: l.type,
        vector: l.type === 'directional' ? l.direction : unproject(l.position, l.position.depth, size, camera.fovDeg, scale),
        color: l.color.map((c) => c * l.intensity) as Vec3,
      })),
  }
}

/** autoColor：雾色为自动时使用的颜色（线性） */
export function fogParams(fog: FogDoc, autoColor: Vec3): FogParams {
  return {
    sigma: SIGMA_MAX * fog.density * fog.density,
    start: fog.start,
    falloff: FALLOFF_MAX * fog.falloff,
    color: (fog.color && hexToLinear(fog.color)) || autoColor,
    light: fog.light,
    noise: fog.noise,
    noiseSize: fog.noiseSize,
    sky: fog.sky,
  }
}

/** 文档坐标 p 处的视线：相机空间的单位方向，以及沿视线的距离与沿光轴的距离之比 */
export function viewRay(p: Point, size: Size, focal: number): { dir: Vec3; stretch: number } {
  const ray: Vec3 = [p.x - size.width / 2, size.height / 2 - p.y, -focal]
  return { dir: normalize(ray), stretch: Math.hypot(...ray) / focal }
}

/** (1 − e^−x) / x，x → 0 时为 1 */
const expRatio = (x: number) => (Math.abs(x) < 1e-3 ? 1 - x / 2 : (1 - Math.exp(-x)) / x)

/**
 * 沿视线从起始距离到 distance（米）的光学厚度。浓度随离地高度指数衰减（地面处为 sigma），沿直线积分有闭式解；
 * 高度低于地面的部分（深度误差）按地面计算。与 GPU 的 fogDepth 一致（不含不均匀度）。
 */
export function opticalDepth(fog: Pick<FogParams, 'sigma' | 'start' | 'falloff'>, view: Pick<AtmosphereView, 'height' | 'up'>, dir: Vec3, distance: number): number {
  const s = Math.min(fog.start, distance)
  const rise = dir[0] * view.up[0] + dir[1] * view.up[1] + dir[2] * view.up[2]
  const h0 = Math.max(view.height + s * rise, 0)
  const length = distance - s
  const dh = Math.max(length * rise, -h0)
  return fog.sigma * length * Math.exp(-fog.falloff * h0) * expRatio(fog.falloff * dh)
}

/** 文档坐标 p、归一化逆深度 depth 处景物的透过率 */
export function fogTransmittance(fog: FogParams, view: AtmosphereView, p: Point, depth: number, size: Size): number {
  const { dir, stretch } = viewRay(p, size, view.focal)
  return Math.exp(-opticalDepth(fog, view, dir, sceneDepth(depth, view.scale) * stretch))
}
