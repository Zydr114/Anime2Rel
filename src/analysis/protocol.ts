/** 光源分析（AnalysisWorker）的输入输出类型（docs/Plan.md §3.2）。 */
import type { Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'

/** A 可见光源检测、B 球谐拟合、C 轮廓法、D 天空梯度 */
export type Estimator = 'A' | 'B' | 'C' | 'D'

export interface LightCandidate {
  type: 'directional' | 'point'
  /** 方向光：指向光源的单位向量（相机空间：x 右、y 上、z 指向相机） */
  direction: Vec3
  /** 点光源：归一化图像坐标 [0,1]（左上角为原点）与该处的归一化逆深度 */
  position: { u: number; v: number; depth: number } | null
  /** 线性 RGB，最大分量为 1 */
  color: Vec3
  /** 与背景像素同一量纲的强度 */
  intensity: number
  softness: number
  confidence: number
  sources: Estimator[]
}

/** 各估计器的原始结果，供面板展示和调试 */
export interface EstimatorReport {
  visible: { count: number; sky: number }
  sh: { direction: Vec3; confidence: number; directionality: number; samples: number } | null
  contour: { angle: number; confidence: number; samples: number } | null
  skyGradient: { angle: number; confidence: number } | null
  skyFraction: number
  /** 天空亮度的变异系数 */
  skyVariation: number
  /** 非天空区域亮度 P99 / P50 */
  contrast: number
}

export interface AnalysisResult {
  /** 分析分辨率 */
  size: Size
  candidates: LightCandidate[]
  /** 去掉主方向光后的环境光（2 阶球谐 × RGB，27 个系数，与背景像素同一量纲） */
  ambient: number[]
  /** 漫射主导（阴天） */
  diffuse: boolean
  report: EstimatorReport
  ms: number
}

export interface AnalysisRequest {
  /** 分析分辨率的背景图（sRGB） */
  bitmap: ImageBitmap
  /** 深度结果（引导分辨率） */
  depth: Float32Array
  sky: Float32Array | null
  depthSize: Size
  fovDeg: number
}

export interface AnalysisWorkerApi {
  analyze(request: AnalysisRequest): Promise<AnalysisResult>
}
