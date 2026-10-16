/** 深度 Worker 与主线程之间的接口类型。 */
import type { Attempt, Device, ModelSource, Precision } from './models'
import type { DepthKind, Size } from './pipeline'

export interface LoadRequest {
  /** 站点根地址（以 / 结尾），用于拼接自托管模型和运行时的地址 */
  siteBase: string
  source: ModelSource
  device: Device | 'auto'
  precision: Precision | 'auto'
}

export type LoadPhase = 'runtime' | 'model' | 'init'

export interface LoadProgress {
  phase: LoadPhase
  attempt?: Attempt
  loaded: number
  total: number
}

export interface AttemptFailure {
  attempt: Attempt
  message: string
}

export interface ModelInfo extends Attempt {
  fromCache: boolean
  /** 下载（或读缓存）耗时 */
  loadMs: number
  /** 创建会话和自检耗时 */
  initMs: number
  /** WASM 线程数 */
  threads: number
  /** 之前失败的尝试 */
  failures: AttemptFailure[]
}

export type LoadResult = { ok: true; info: ModelInfo } | { ok: false; failures: AttemptFailure[]; message: string }

export interface EstimateTimings {
  /** 缩放与张量准备 */
  prepare: number
  /** 模型推理 */
  inference: number
  /** 边缘吸附、引导滤波、法线、天空 */
  post: number
}

/** 一张图片的深度估计结果（引导分辨率）。 */
export interface DepthResult {
  kind: DepthKind
  device: Device
  precision: Precision
  model: Size
  guideSize: Size
  /** 边缘对齐后的深度 [0,1]，1 为最近 */
  depth: Float32Array
  /** 法线与置信度 RGBA8 */
  normal: Uint8Array
  /** 天空遮罩 [0,1]，仅背景 */
  sky: Float32Array | null
  /** RGBA16F：引导滤波系数（rgb = a，a = b） */
  coefHalf: Uint16Array
  /** RGBA16F：r = 未对齐深度，g = 天空遮罩 */
  auxHalf: Uint16Array
  timings: EstimateTimings
}

export interface DepthWorkerApi {
  load(request: LoadRequest, onProgress: (p: LoadProgress) => void): Promise<LoadResult>
  estimate(bitmap: ImageBitmap, kind: DepthKind): Promise<DepthResult>
  unload(): Promise<void>
  clearCache(): Promise<boolean>
  cacheSize(): Promise<number>
}
