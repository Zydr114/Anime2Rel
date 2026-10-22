/**
 * 雾与尘埃（docs/Plan.md §3.7 M8.8c）：镜头步骤中与场景有关的参数，不随调色预设保存。
 * 距离按深度校准换算成米（src/camera/depthScale.ts）；浓度、数量为 0 时关闭。
 */

export interface FogParams {
  /** 浓度，0 为关闭 */
  density: number
  /** 起始距离（米）：比它近的部分不加雾 */
  start: number
  /** 高度衰减：浓度随离地高度指数衰减的速度，0 为均匀 */
  falloff: number
  /** 雾色（sRGB 十六进制）；null 为自动：天空的平均颜色 */
  color: string | null
  /** 光源的散射光 */
  light: number
  /** 不均匀度 */
  noise: number
  /** 噪声尺寸（米） */
  noiseSize: number
  /** 雾覆盖天空 */
  sky: boolean
}

export interface DustParams {
  /** 数量，0 为关闭 */
  amount: number
  /** 颗粒大小 */
  size: number
  brightness: number
  /** 分布的近处与远处距离（米） */
  near: number
  far: number
  /** 随机种子 */
  seed: number
}

export interface AtmosphereDoc {
  fog: FogParams
  dust: DustParams
}

export type AtmosphereSection = keyof AtmosphereDoc

/** 界面与工程文件允许的范围 */
export const FOG_START_RANGE: readonly [number, number] = [0, 100]
export const NOISE_SIZE_RANGE: readonly [number, number] = [0.5, 50]
export const DUST_NEAR_RANGE: readonly [number, number] = [0.2, 20]
export const DUST_FAR_RANGE: readonly [number, number] = [1, 100]
export const DUST_SEED_RANGE: readonly [number, number] = [0, 999]

export const DEFAULT_FOG: FogParams = { density: 0, start: 0, falloff: 0, color: null, light: 0.5, noise: 0, noiseSize: 5, sky: false }
export const DEFAULT_DUST: DustParams = { amount: 0, size: 0.3, brightness: 0.5, near: 0.3, far: 8, seed: 1 }
export const DEFAULT_ATMOSPHERE: AtmosphereDoc = { fog: DEFAULT_FOG, dust: DEFAULT_DUST }

export const fogActive = (fog: FogParams) => fog.density > 0
export const dustActive = (dust: DustParams) => dust.amount > 0 && dust.brightness > 0
