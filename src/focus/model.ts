/** 景深与深度遮挡参数（可撤销，docs/Plan.md §3.4）。 */

export type OcclusionMode = 'opaque' | 'darken' | 'multiply' | 'medium' | 'water' | 'none'
export const OCCLUSION_MODES: readonly OcclusionMode[] = ['opaque', 'darken', 'multiply', 'medium', 'water', 'none']
/** 按深度测试划定遮挡范围的遮挡方式 */
export const DEPTH_MODES: readonly OcclusionMode[] = ['opaque', 'darken', 'multiply', 'medium']
/** 用到介质参数（清澈度、浑浊度、表面细节）的遮挡方式 */
export const MEDIUM_MODES: readonly OcclusionMode[] = ['medium', 'water']

/** 散景形状：光圈叶片数，0 为圆形 */
export const BOKEH_BLADES = [0, 5, 6, 8] as const

/**
 * 焦点。立绘上的点用立绘 UV 记录，随立绘移动；背景上的点用文档坐标记录。
 */
export type FocusTarget = { kind: 'character'; u: number; v: number } | { kind: 'background'; x: number; y: number }

/** 遮挡方式及其参数；区域外的默认方式和每个区域各有一套 */
export interface OcclusionStyle {
  mode: OcclusionMode
  /** 透明介质与水体：交界处立绘透出的比例 */
  clarity: number
  /** 透明介质与水体：越深越看不清立绘的速度（介质按深度差，水体按水线以下的距离） */
  density: number
  /** 透明介质与水体：在透出的立绘上叠加背景的高频细节（波纹、雾的纹理） */
  detail: number
  /** 水体：水线处的高光 */
  highlight: number
  /** 水体：水线起伏与水下部分的折射扰动 */
  ripple: number
  /** 水体：立绘倒影的强度，0 为没有倒影 */
  reflection: number
  /** 水体：倒影离水线越远越模糊的程度 */
  reflectionBlur: number
  /** 水体：倒影随波纹扭曲的幅度 */
  reflectionRipple: number
  /** 水体：倒影按这个颜色过滤（sRGB 十六进制），白色为不改变 */
  waterColor: string
}

/** 画笔笔画：文档坐标的折线，按半径画出圆头粗线；橡皮擦除之前画过的部分 */
export interface BrushStroke {
  erase: boolean
  /** 半径（文档像素） */
  radius: number
  /** [x0, y0, x1, y1, …]（文档像素） */
  points: number[]
}

/** 在背景上画出的遮挡区域，区域内按自己的遮挡方式；后面的区域覆盖前面的 */
export interface OcclusionRegion extends OcclusionStyle {
  id: string
  strokes: BrushStroke[]
}

export const MAX_REGIONS = 4

let regionCounter = 0
export function newRegionId(): string {
  return `region-${++regionCounter}`
}

export interface FocusDoc {
  dof: {
    enabled: boolean
    /** 光圈：深度差为 1 时的弥散圆半径，相对图像长边 */
    aperture: number
    /** 合焦范围：与焦点的深度差在此范围内保持清晰（归一化逆深度） */
    range: number
    blades: number
    /** 多边形散景的旋转角（弧度） */
    rotation: number
  }
  /** 焦点；null 为立绘所在的深度，随立绘移动 */
  target: FocusTarget | null
  /** 立绘厚度：自身起伏对应的前后距离，相对立绘高度 */
  thickness: number
  /** 遮挡；自身的遮挡方式用于区域以外 */
  occlusion: OcclusionStyle & {
    enabled: boolean
    /** 背景比立绘近出这个深度差才开始遮挡 */
    tolerance: number
    /** 遮挡从 0 过渡到 1 的深度差宽度 */
    softness: number
    /** 区域边缘吸附到背景的边缘 */
    snap: boolean
    regions: OcclusionRegion[]
  }
}

export type FocusSection = 'dof' | 'occlusion'

/** 水体遮挡开启（区域外或任一画过的区域）时接地点就是水线 */
export function waterActive(focus: FocusDoc): boolean {
  const o = focus.occlusion
  return o.enabled && (o.mode === 'water' || o.regions.some((r) => r.mode === 'water' && r.strokes.length > 0))
}

export const DEFAULT_STYLE: OcclusionStyle = {
  mode: 'opaque',
  clarity: 0.6,
  density: 0.3,
  detail: 0.3,
  highlight: 0.3,
  ripple: 0.2,
  reflection: 0,
  reflectionBlur: 0.3,
  reflectionRipple: 0.3,
  waterColor: '#ffffff',
}

export const DEFAULT_FOCUS: FocusDoc = {
  dof: { enabled: true, aperture: 0.01, range: 0.03, blades: 0, rotation: 0 },
  target: null,
  thickness: 0.15,
  occlusion: { enabled: false, tolerance: 0.05, softness: 0.03, ...DEFAULT_STYLE, snap: true, regions: [] },
}
