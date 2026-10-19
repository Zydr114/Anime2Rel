/** 融合 Worker 与主线程之间的接口类型。 */
import type { Mat3 } from '@/algo/cat'
import type { Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import type { NormalWeights } from './normals'
import type { LabStats } from './stats'

export interface BackgroundInput {
  id: string
  /** 原分辨率位图（噪声估计需要原始像素），Worker 用完后关闭 */
  bitmap: ImageBitmap
  /** 背景深度与天空遮罩（引导分辨率）；深度未就绪时为 null */
  depth: Float32Array | null
  sky: Float32Array | null
  depthSize: Size | null
}

export interface BackgroundInfo {
  /** 背景白点（线性 sRGB，最大分量为 1） */
  whitePoint: Vec3
  /** 噪声标准差（sRGB 编码值，按通道） */
  noise: Vec3
  /** 非天空区域的平均颜色（线性） */
  meanColor: Vec3
}

export interface CharacterInput {
  id: string
  /** 引导分辨率的位图，与立绘深度结果的尺寸一致 */
  bitmap: ImageBitmap
  /** 深度模型的法线 RGBA8 与归一化逆深度；深度未就绪时为 null */
  depthNormal: Uint8Array | null
  depth: Float32Array | null
}

export interface CharacterInfo {
  /** 不透明区域（alpha > 0.5）的包围盒，相对立绘尺寸 [0,1] */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  /** 不透明区域内立绘自身深度的中位数，作为起伏的基准；深度未就绪时为 0.5 */
  reliefMedian: number
  /** 包围盒最下方 1% 的行中不透明像素占包围盒宽度的比例：被裁切的半身像接近 1，双脚通常较小 */
  bottomCoverage: number
  /** 按高度分成 ROW_BINS 行，每行不透明区域的左右边界（立绘 UV，交错存放）；没有不透明像素的行为 -1 */
  rows: Float32Array
}

/** CharacterInfo.rows 的行数 */
export const ROW_BINS = 256

export interface NormalRequest {
  id: string
  weights: NormalWeights
  /** 膨胀半径，相对立绘长边 */
  inflateRadius: number
}

export interface NormalMap {
  width: number
  height: number
  /** RGBA8：rgb = n·0.5 + 0.5，a = 1 − 线稿遮罩 */
  data: Uint8Array
  /** 轮廓光的边缘带，RGBA8，尺寸同上，见 src/fusion/normals.ts 的 rimMap */
  rim: Uint8Array
}

/** 去除残留底色时估计的前景色与背景色（引导分辨率，RGBA8，sRGB 编码值，a = 255），见 src/fusion/matte.ts */
export interface MatteMap {
  width: number
  height: number
  foreground: Uint8Array
  background: Uint8Array
}

export interface StatsRequest {
  backgroundId: string
  characterId: string
  /** 立绘颜色先经过的白平衡适配矩阵（线性 sRGB） */
  cat: Mat3
  /** 立绘包围盒：中心与半宽高（背景归一化坐标） */
  region: { cx: number; cy: number; rx: number; ry: number }
  /** 立绘所在的归一化逆深度 */
  depth: number
}

export interface FusionStats {
  /** 白平衡适配后的立绘统计 */
  character: LabStats | null
  /** 立绘周围、深度相近的背景统计 */
  local: LabStats | null
  /** 同一权重下背景的平均颜色（线性） */
  localColor: Vec3
}

export interface FusionWorkerApi {
  setBackground(input: BackgroundInput): Promise<BackgroundInfo>
  setCharacter(input: CharacterInput): Promise<CharacterInfo>
  normals(request: NormalRequest): Promise<NormalMap>
  matte(id: string): Promise<MatteMap>
  stats(request: StatsRequest): Promise<FusionStats>
}
