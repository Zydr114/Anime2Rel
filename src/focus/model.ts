/** 景深与深度遮挡参数（可撤销，docs/Plan.md §3.4）。 */

export type OcclusionMode = 'opaque' | 'darken' | 'multiply'
export const OCCLUSION_MODES: readonly OcclusionMode[] = ['opaque', 'darken', 'multiply']

/** 散景形状：光圈叶片数，0 为圆形 */
export const BOKEH_BLADES = [0, 5, 6, 8] as const

/**
 * 焦点。立绘上的点用立绘 UV 记录，随立绘移动；背景上的点用文档坐标记录。
 */
export type FocusTarget = { kind: 'character'; u: number; v: number } | { kind: 'background'; x: number; y: number }

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
  occlusion: {
    enabled: boolean
    mode: OcclusionMode
    /** 背景比立绘近出这个深度差才开始遮挡 */
    tolerance: number
    /** 遮挡从 0 过渡到 1 的深度差宽度 */
    softness: number
  }
}

export type FocusSection = 'dof' | 'occlusion'

export const DEFAULT_FOCUS: FocusDoc = {
  dof: { enabled: true, aperture: 0.01, range: 0.03, blades: 0, rotation: 0 },
  target: null,
  thickness: 0.15,
  occlusion: { enabled: false, mode: 'opaque', tolerance: 0.05, softness: 0.03 },
}
