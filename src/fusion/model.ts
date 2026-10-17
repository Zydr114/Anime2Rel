/** 立绘融合参数（可撤销，docs/Plan.md §3.3）。强度类参数取值 [0,1]，1 为完全匹配。 */
import { DEFAULT_INFLATE_RADIUS, DEFAULT_NORMAL_WEIGHTS } from './normals'

export type RelightStyle = 'realistic' | 'soft' | 'cel'
export const RELIGHT_STYLES: readonly RelightStyle[] = ['realistic', 'soft', 'cel']

export interface FusionDoc {
  colorMatch: {
    /** 白平衡适配：把立绘的白点（D65）适配到背景白点 */
    whiteBalance: number
    /** 影调：明度分位点 P1/P50/P99 匹配到立绘周围的背景 */
    tone: number
    /** 色度：a/b 均值与方差迁移 */
    chroma: number
    /** 饱和度收敛：色度 P90 收敛到背景 */
    saturation: number
    /** 肤色保护：色度迁移与饱和度收敛对肤色减弱 */
    skinProtect: boolean
  }
  relight: {
    style: RelightStyle
    strength: number
    /** 赛璐璐：明暗分界（n·L）与过渡宽度 */
    celThreshold: number
    celSoftness: number
    /** 轮廓光强度（光源在人物后方时自动增强） */
    rim: number
    /** 高光强度 */
    specular: number
  }
  normals: {
    depth: number
    inflate: number
    detail: number
    /** 膨胀半径，相对立绘长边 */
    inflateRadius: number
  }
  edge: {
    lightWrap: number
    /** Light Wrap 半径，相对背景短边 */
    wrapRadius: number
    /** 边缘羽化（背景像素） */
    feather: number
    /** 噪声匹配：1 为与背景噪声等量 */
    noise: number
  }
  /** 立绘所在深度（归一化逆深度）；null 为自动，取立绘脚下的背景深度 */
  depth: number | null
}

export type FusionSection = 'colorMatch' | 'relight' | 'normals' | 'edge'

export const DEFAULT_FUSION: FusionDoc = {
  colorMatch: { whiteBalance: 0.7, tone: 0.5, chroma: 0.3, saturation: 0.3, skinProtect: true },
  relight: { style: 'realistic', strength: 0.6, celThreshold: 0.1, celSoftness: 0.05, rim: 0.6, specular: 0 },
  normals: { ...DEFAULT_NORMAL_WEIGHTS, inflateRadius: DEFAULT_INFLATE_RADIUS },
  edge: { lightWrap: 0.25, wrapRadius: 0.008, feather: 0.5, noise: 1 },
  depth: null,
}
