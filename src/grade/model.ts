/** 调色参数（可撤销，docs/Plan.md §3.5、§3.6）。所有参数默认中性：不做任何修改时输出与未调色时一致。 */

/** 三级调整：背景层、立绘层（融合结果之上）、全局（合成结果） */
export type GradeLevel = 'global' | 'background' | 'character'
export const GRADE_LEVELS: readonly GradeLevel[] = ['global', 'background', 'character']

export type CurveChannel = 'master' | 'r' | 'g' | 'b'
export const CURVE_CHANNELS: readonly CurveChannel[] = ['master', 'r', 'g', 'b']

/** 曲线控制点 [x, y]，显示空间（sRGB 编码值）[0,1]，x 严格递增，首尾两点固定在 x = 0 和 x = 1 */
export type CurvePoints = [number, number][]

/** HSL 的 8 个色相段（Oklch），顺序与 src/grade/color.ts 的 HSL_CENTERS 一致 */
export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type HslBand = (typeof HSL_BANDS)[number]

export interface BasicAdjust {
  /** 曝光（EV），线性空间乘以 2^EV */
  exposure: number
  /** 以下为 [-1,1]，0 为不调整 */
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  /** 色温、色调：正值偏暖、偏品红 */
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  /** 各色相段的色相偏移、饱和度、明度 [-1,1]，长度为 8 */
  hsl: { hue: number[]; saturation: number[]; luminance: number[] }
  curves: Record<CurveChannel, CurvePoints>
  /** 清晰度（大半径局部对比度）[-1,1] */
  clarity: number
  /** 锐化（小半径 USM）[0,1] */
  sharpen: number
}

/** 色轮：暗部（lift）、中间调（gamma）、亮部（gain） */
export type WheelKey = 'lift' | 'gamma' | 'gain'
export const WHEEL_KEYS: readonly WheelKey[] = ['lift', 'gamma', 'gain']

/** 偏色：方向为 Oklch 色相（度），强度 [0,1] */
export interface Tint {
  hue: number
  amount: number
}

export interface ColorWheel extends Tint {
  /** 亮度 [-1,1] */
  luma: number
}

export type ToneKey = 'shadow' | 'highlight'
export const TONE_KEYS: readonly ToneKey[] = ['shadow', 'highlight']

export interface SplitToning {
  shadow: Tint
  highlight: Tint
  /** 平衡 [-1,1]：正值让亮部的色调覆盖更多中间调 */
  balance: number
}

/** 导入的 LUT：数据在 src/grade/luts.ts 的登记表中 */
export interface LutRef {
  id: string
  /** 文件名 */
  name: string
}

/** 全局调色（色彩风格）：在全局基础调整之后、显示空间中进行 */
export interface CreativeGrade {
  wheels: Record<WheelKey, ColorWheel>
  split: SplitToning
  lut: LutRef | null
  /** LUT 强度 [0,1] */
  lutIntensity: number
}

export interface GradeDoc {
  levels: Record<GradeLevel, BasicAdjust>
  creative: CreativeGrade
}

export const IDENTITY_CURVE: CurvePoints = [
  [0, 0],
  [1, 1],
]

const zeros = () => new Array<number>(HSL_BANDS.length).fill(0)

export const DEFAULT_ADJUST: BasicAdjust = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  hsl: { hue: zeros(), saturation: zeros(), luminance: zeros() },
  curves: { master: IDENTITY_CURVE, r: IDENTITY_CURVE, g: IDENTITY_CURVE, b: IDENTITY_CURVE },
  clarity: 0,
  sharpen: 0,
}

const NO_WHEEL: ColorWheel = { hue: 0, amount: 0, luma: 0 }

export const DEFAULT_CREATIVE: CreativeGrade = {
  wheels: { lift: NO_WHEEL, gamma: NO_WHEEL, gain: NO_WHEEL },
  // 色相取常见的冷暗部、暖亮部，强度为 0 时不起作用
  split: { shadow: { hue: 230, amount: 0 }, highlight: { hue: 70, amount: 0 }, balance: 0 },
  lut: null,
  lutIntensity: 1,
}

export const DEFAULT_GRADE: GradeDoc = {
  levels: { global: DEFAULT_ADJUST, background: DEFAULT_ADJUST, character: DEFAULT_ADJUST },
  creative: DEFAULT_CREATIVE,
}

/** 曲线是否为恒等（只有两个端点且在对角线上） */
export function isIdentityCurve(points: CurvePoints): boolean {
  return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1
}

const SCALARS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation', 'clarity', 'sharpen'] as const

/** 基础调整是否不做任何修改 */
export function isNeutralAdjust(a: BasicAdjust): boolean {
  return (
    SCALARS.every((k) => a[k] === 0) &&
    [a.hsl.hue, a.hsl.saturation, a.hsl.luminance].every((band) => band.every((v) => v === 0)) &&
    CURVE_CHANNELS.every((c) => isIdentityCurve(a.curves[c]))
  )
}

/** 全局调色是否不做任何修改 */
export function isNeutralCreative(c: CreativeGrade): boolean {
  return (
    WHEEL_KEYS.every((k) => c.wheels[k].amount === 0 && c.wheels[k].luma === 0) &&
    TONE_KEYS.every((k) => c.split[k].amount === 0) &&
    (c.lut === null || c.lutIntensity === 0)
  )
}
