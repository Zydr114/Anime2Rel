/**
 * 镜头光晕（docs/Plan.md §3.7 M8.2）：一串元素排在光源与画面中心的连线上，位置为 L + (C − L)·k，
 * 由终处理 pass 逐像素解析计算（src/engine/flare.ts），不使用贴图。
 * 元素的构成方式借鉴 Optical Flares，所有元素和内置预设都由程序生成。
 */
import { hexToLinear } from '@/algo/color'
import { hex, num, oneOf, record, text, type Json } from '@/io/conform'

export type FlareElementType = 'glow' | 'ring' | 'streaks' | 'anamorphic' | 'ghost' | 'rainbow' | 'sparkles'
/** 顺序即着色器中的类型序号 */
export const FLARE_ELEMENT_TYPES: readonly FlareElementType[] = ['glow', 'ring', 'streaks', 'anamorphic', 'ghost', 'rainbow', 'sparkles']
export const MAX_FLARE_ELEMENTS = 16

/** 鬼影的边数：0 为圆形，FOLLOW_APERTURE 为跟随景深的光圈叶片数 */
export const FOLLOW_APERTURE = -1
export const GHOST_SIDES = [FOLLOW_APERTURE, 0, 3, 4, 5, 6, 7, 8] as const

export interface FlareElement {
  id: string
  type: FlareElementType
  /** 连线上的位置 k：0 在光源处，1 在画面中心，大于 1 越过中心到另一侧 */
  position: number
  /** 半径（相对画面长边） */
  size: number
  color: string
  intensity: number
  /** 旋转（度）：星芒、横向拉丝、多边形鬼影、闪点 */
  rotation: number
  softness: number
  /** 鬼影的边数，见 GHOST_SIDES */
  sides: number
  /** 星芒的射线数、闪点的个数 */
  count: number
  /** 彩虹环的色散 */
  dispersion: number
  /** 星芒长度、闪点位置的随机种子 */
  seed: number
}

export interface FlareDoc {
  enabled: boolean
  /** 整体强度、整体大小 [0,1]；0.5 为元素本身的强度和大小 */
  intensity: number
  size: number
  /** 光源 id，null 为自动选择（与光束相同） */
  light: string | null
  elements: FlareElement[]
}

/** 各字段的范围（数值）；编辑器的滑块与导入时的检查共用 */
export const FLARE_RANGES = {
  position: [-1, 3],
  size: [0, 1],
  intensity: [0, 1],
  rotation: [0, 360],
  softness: [0, 1],
  count: [2, 32],
  dispersion: [0, 1],
  seed: [0, 9999],
} as const

type ElementInput = Partial<Omit<FlareElement, 'id' | 'type'>> & { type: FlareElementType }

/** 各类型新建时的参数 */
const TYPE_DEFAULTS: Record<FlareElementType, Partial<FlareElement>> = {
  glow: { size: 0.25, intensity: 0.5, softness: 0.6 },
  ring: { size: 0.15, intensity: 0.1, softness: 0.3 },
  streaks: { size: 0.35, intensity: 0.4, softness: 0.3, count: 6 },
  anamorphic: { size: 0.6, intensity: 0.4, softness: 0.3, color: '#7fa8ff' },
  ghost: { position: 1.3, size: 0.06, intensity: 0.08, softness: 0.3 },
  rainbow: { size: 0.3, intensity: 0.1, softness: 0.4, dispersion: 0.8 },
  sparkles: { size: 0.12, intensity: 0.4, softness: 0.4, count: 8 },
}

const randomSeed = () => Math.floor(Math.random() * 10000)

export const newFlareId = () => `flare-${crypto.randomUUID()}`

export function newFlareElement(input: ElementInput): FlareElement {
  return {
    id: newFlareId(),
    position: 0,
    size: 0.2,
    color: '#ffffff',
    intensity: 0.3,
    rotation: 0,
    softness: 0.5,
    sides: 0,
    count: 6,
    dispersion: 0.5,
    seed: randomSeed(),
    ...TYPE_DEFAULTS[input.type],
    ...input,
  }
}

export type FlarePresetId = 'soft-sun' | 'blue-anamorphic' | 'vintage-ghosts' | 'star' | 'rainbow-halo'

const PRESET_INPUTS: Record<FlarePresetId, ElementInput[]> = {
  // 暖白的光辉，淡淡的彩虹环，连线上几个暖色、冷色的小鬼影
  'soft-sun': [
    { type: 'glow', size: 0.35, color: '#fff1d6', intensity: 0.55, softness: 0.7 },
    { type: 'rainbow', size: 0.42, intensity: 0.05, softness: 0.5, dispersion: 0.8 },
    { type: 'ghost', position: 0.55, size: 0.035, color: '#ffb36b', intensity: 0.08, softness: 0.4 },
    { type: 'ghost', position: 1.25, size: 0.08, color: '#9cc4ff', intensity: 0.04, softness: 0.5 },
    { type: 'ghost', position: 1.6, size: 0.025, color: '#ffe0a0', intensity: 0.1, softness: 0.3 },
  ],
  // 变形宽银幕镜头：贯穿画面的蓝色水平拉丝，偏蓝的鬼影
  'blue-anamorphic': [
    { type: 'glow', size: 0.12, color: '#d6e6ff', intensity: 0.7, softness: 0.3 },
    { type: 'anamorphic', size: 0.95, color: '#3f7dff', intensity: 0.45, softness: 0.35 },
    { type: 'anamorphic', size: 0.45, color: '#a6c8ff', intensity: 0.35, softness: 0.1 },
    { type: 'ghost', position: 0.7, size: 0.05, color: '#3a74ff', intensity: 0.06, softness: 0.4 },
    { type: 'ghost', position: 1.4, size: 0.1, color: '#2552d9', intensity: 0.04, softness: 0.6 },
    { type: 'ring', position: 1.9, size: 0.07, color: '#6f9bff', intensity: 0.06, softness: 0.2 },
  ],
  // 老镜头：一串彩色的多边形鬼影，边数跟随光圈
  'vintage-ghosts': [
    { type: 'glow', size: 0.25, color: '#ffd9a8', intensity: 0.5, softness: 0.6 },
    { type: 'ghost', position: 0.3, size: 0.03, color: '#ffcc66', intensity: 0.12, softness: 0.2, sides: FOLLOW_APERTURE },
    { type: 'ghost', position: 0.55, size: 0.06, color: '#8cf29f', intensity: 0.06, softness: 0.25, sides: FOLLOW_APERTURE },
    { type: 'ghost', position: 0.8, size: 0.02, color: '#ff8a66', intensity: 0.14, softness: 0.2, sides: FOLLOW_APERTURE },
    { type: 'ghost', position: 1.1, size: 0.1, color: '#6b9cff', intensity: 0.05, softness: 0.3, sides: FOLLOW_APERTURE },
    { type: 'ghost', position: 1.35, size: 0.04, color: '#ffad5c', intensity: 0.1, softness: 0.2, sides: FOLLOW_APERTURE },
    { type: 'ghost', position: 1.7, size: 0.14, color: '#66ccaa', intensity: 0.04, softness: 0.35, sides: FOLLOW_APERTURE },
    { type: 'ring', position: 1.9, size: 0.08, color: '#ffeeaa', intensity: 0.05, softness: 0.25 },
  ],
  // 小光圈拍太阳：锐利的六芒星和细密的射线，周围有闪点
  star: [
    { type: 'glow', size: 0.15, color: '#ffffff', intensity: 0.85, softness: 0.25 },
    { type: 'streaks', size: 0.5, color: '#ffffff', intensity: 0.6, softness: 0.2, count: 6, rotation: 15 },
    { type: 'streaks', size: 0.28, color: '#ffe8c4', intensity: 0.25, softness: 0.45, count: 14 },
    { type: 'sparkles', size: 0.14, color: '#ffffff', intensity: 0.45, softness: 0.35, count: 10 },
    { type: 'ghost', position: 1.3, size: 0.05, color: '#ffd090', intensity: 0.05, softness: 0.3 },
  ],
  // 太阳周围一圈明显的彩虹光环
  'rainbow-halo': [
    { type: 'glow', size: 0.2, color: '#fff4e0', intensity: 0.6, softness: 0.5 },
    { type: 'rainbow', size: 0.32, intensity: 0.16, softness: 0.35, dispersion: 1 },
    { type: 'ring', size: 0.5, color: '#ffe0c0', intensity: 0.04, softness: 0.6 },
    { type: 'ghost', position: 1.5, size: 0.06, color: '#c4e0ff', intensity: 0.05, softness: 0.4 },
  ],
}

export const FLARE_PRESET_IDS = Object.keys(PRESET_INPUTS) as FlarePresetId[]

/** 内置光晕的元素（每次调用生成新的 id；种子固定，同一预设的图案总是相同） */
export function flarePreset(id: FlarePresetId): FlareElement[] {
  return PRESET_INPUTS[id].map((input, i) => newFlareElement({ seed: i * 1013 + 17, ...input }))
}

export const DEFAULT_FLARE: FlareDoc = { enabled: false, intensity: 0.5, size: 0.5, light: null, elements: flarePreset('soft-sun') }

/** 文件中的元素 → 元素（重新分配 id），无效的字段取该类型的默认值 */
export function conformFlareElement(v: unknown): FlareElement {
  const o = record(v)
  const d = newFlareElement({ type: oneOf(o.type, FLARE_ELEMENT_TYPES, 'glow') })
  const field = (key: keyof typeof FLARE_RANGES) => num(o[key], d[key], FLARE_RANGES[key][0], FLARE_RANGES[key][1])
  return {
    ...d,
    position: field('position'),
    size: field('size'),
    color: hex(o.color, d.color),
    intensity: field('intensity'),
    rotation: field('rotation') % 360,
    softness: field('softness'),
    sides: oneOf(o.sides, GHOST_SIDES, 0),
    count: Math.round(field('count')),
    dispersion: field('dispersion'),
    seed: Math.round(field('seed')),
  }
}

export function conformFlareElements(v: unknown): FlareElement[] {
  return Array.isArray(v) ? v.slice(0, MAX_FLARE_ELEMENTS).map(conformFlareElement) : []
}

/** light：文件中的光源 id → 文档中的 id */
export function conformFlare(v: unknown, light: (id: unknown) => string | null): FlareDoc {
  const o = record(v)
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_FLARE.enabled,
    intensity: num(o.intensity, DEFAULT_FLARE.intensity, 0, 1),
    size: num(o.size, DEFAULT_FLARE.size, 0, 1),
    light: light(o.light),
    elements: Array.isArray(o.elements) ? conformFlareElements(o.elements) : flarePreset('soft-sun'),
  }
}

/** 元素的 id 只在文档内有意义，文件和比较中都去掉 */
export const flareElementsForFile = (elements: readonly FlareElement[]): Json[] => elements.map((e) => ({ ...e, id: undefined }))

export const sameFlareElements = (a: readonly FlareElement[], b: readonly FlareElement[]) => JSON.stringify(flareElementsForFile(a)) === JSON.stringify(flareElementsForFile(b))

/** 自定义光晕（保存在浏览器本地） */
export interface CustomFlare {
  name: string
  elements: FlareElement[]
}

const MAX_NAME_LENGTH = 60

export function conformCustomFlare(v: unknown): CustomFlare | null {
  const o = record(v)
  const name = text(o.name, '', MAX_NAME_LENGTH)
  return name && Array.isArray(o.elements) ? { name, elements: conformFlareElements(o.elements) } : null
}

/** 整体大小 [0,1] → 元素尺寸的倍数（0.5 为 1 倍，范围 0.5–2 倍） */
export const flareScale = (size: number) => 2 ** ((size - 0.5) * 2)

/** 着色器中每个元素占的 float 数（4 个 RGBA 纹素） */
export const FLARE_STRIDE = 16

/**
 * 元素参数 → 着色器读取的数据（每个元素 4 个纹素）：
 * [类型, k, 半径, 强度] [r, g, b（线性）, 旋转（弧度）] [柔和度, 边数, 个数, 色散] [种子, 0, 0, 0]。
 * 半径已乘以整体大小；跟随光圈的鬼影换成光圈的叶片数和旋转角。
 */
export function packFlareElements(elements: readonly FlareElement[], scale: number, aperture: { blades: number; rotation: number }): Float32Array {
  const out = new Float32Array(MAX_FLARE_ELEMENTS * FLARE_STRIDE)
  elements.slice(0, MAX_FLARE_ELEMENTS).forEach((e, i) => {
    const follow = e.type === 'ghost' && e.sides === FOLLOW_APERTURE
    const sides = e.type !== 'ghost' ? 0 : follow ? aperture.blades : e.sides
    const rotation = (e.rotation * Math.PI) / 180 + (follow ? aperture.rotation : 0)
    const [r, g, b] = hexToLinear(e.color) ?? [1, 1, 1]
    out.set([FLARE_ELEMENT_TYPES.indexOf(e.type), e.position, e.size * scale, e.intensity, r, g, b, rotation, e.softness, sides, e.count, e.dispersion, e.seed, 0, 0, 0], i * FLARE_STRIDE)
  })
  return out
}
