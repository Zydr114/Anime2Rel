/**
 * 预设：三级基础调整、全局调色和后期参数的快照（docs/Plan.md §3.6）。
 * 文件是 JSON，导入的 LUT 以 base64（float32，小端）内嵌，可以单独分享。
 * 导入的内容不可信：逐字段检查类型并限制在界面允许的范围内，缺少或无效的字段取默认值。内置预设也经过同样的处理。
 */
import { bool, hex, hue, num, oneOf, record, text, type Json } from '@/io/conform'
import { MAX_CUBE_SIZE, type CubeLut } from './cube'
import { getLut, registerLut } from './luts'
import {
  BLEND_MODES,
  CURVE_CHANNELS,
  DEFAULT_ADJUST,
  DEFAULT_CREATIVE,
  GRADE_LEVELS,
  HSL_BANDS,
  IDENTITY_CURVE,
  MAX_BLEND_LAYERS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  newBlendLayer,
  TONE_KEYS,
  WHEEL_KEYS,
  type BasicAdjust,
  type BlendLayer,
  type CreativeGrade,
  type CurvePoints,
  type GradeDoc,
  type GradeLevel,
  type HslBand,
  type LutRef,
} from './model'
import { conformFlare, flareElementsForFile } from './flare'
import { DEFAULT_POST, TONE_MAPPINGS, type PostDoc, type PostSection } from './post'

export interface Preset {
  name: string
  grade: GradeDoc
  post: PostDoc
}

export const PRESET_FORMAT = 'anime2real-preset'
/** 改名前（Anime2Rel）导出的预设文件使用的格式标识，内容相同 */
const LEGACY_PRESET_FORMATS = ['anime2rel-preset']
export const PRESET_VERSION = 1
const MAX_NAME_LENGTH = 60
/** 曲线控制点数的上限 */
const MAX_CURVE_POINTS = 32

export class PresetError extends Error {}

const conformName = (v: unknown, fallback: string) => text(v, fallback, MAX_NAME_LENGTH)

/** 曲线：首尾在 x = 0、1，x 严格递增；不满足时恢复为直线 */
function conformCurve(v: unknown): CurvePoints {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_CURVE_POINTS) return IDENTITY_CURVE
  const points = v.map((p) => (Array.isArray(p) && p.length === 2 ? [num(p[0], NaN, 0, 1), num(p[1], NaN, 0, 1)] : [NaN, NaN]))
  const valid = points.every(([x, y], i) => Number.isFinite(x) && Number.isFinite(y) && (i === 0 || x > points[i - 1][0]))
  return valid && points[0][0] === 0 && points[points.length - 1][0] === 1 ? (points as CurvePoints) : IDENTITY_CURVE
}

const SIGNED_FIELDS = ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation', 'clarity'] as const

function conformAdjust(v: unknown): BasicAdjust {
  const o = record(v)
  const hsl = record(o.hsl)
  const bands = (key: string) => {
    const a = Array.isArray(hsl[key]) ? (hsl[key] as unknown[]) : []
    return HSL_BANDS.map((_, i) => num(a[i], 0, -1, 1))
  }
  const curves = record(o.curves)
  const adjust: BasicAdjust = {
    ...DEFAULT_ADJUST,
    exposure: num(o.exposure, 0, -5, 5),
    sharpen: num(o.sharpen, 0, 0, 1),
    hsl: { hue: bands('hue'), saturation: bands('saturation'), luminance: bands('luminance') },
    curves: Object.fromEntries(CURVE_CHANNELS.map((c) => [c, conformCurve(curves[c])])) as BasicAdjust['curves'],
  }
  for (const k of SIGNED_FIELDS) adjust[k] = num(o[k], 0, -1, 1)
  return adjust
}

function conformLayer(v: unknown): BlendLayer {
  const o = record(v)
  const d = newBlendLayer()
  const gradient = Array.isArray(o.gradient) && o.gradient.length >= MIN_GRADIENT_STOPS && o.gradient.length <= MAX_GRADIENT_STOPS ? o.gradient.map((c, i) => hex(c, d.gradient[Math.min(i, 1)])) : d.gradient
  const maskLow = num(o.maskLow, 0, 0, 1)
  return {
    id: d.id,
    kind: oneOf(o.kind, ['color', 'gradient'], d.kind),
    color: hex(o.color, d.color),
    gradient,
    mode: oneOf(o.mode, BLEND_MODES, d.mode),
    opacity: num(o.opacity, d.opacity, 0, 1),
    maskLow,
    maskHigh: num(o.maskHigh, 1, maskLow, 1),
  }
}

/** lut：预设中的 LUT 引用 → 已登记的 LUT；找不到数据时为 null */
function conformCreative(v: unknown, lut: (ref: Json) => LutRef | null): CreativeGrade {
  const o = record(v)
  const wheels = record(o.wheels)
  const split = record(o.split)
  const tint = (t: unknown, fallback: { hue: number }) => ({ hue: hue(record(t).hue, fallback.hue), amount: num(record(t).amount, 0, 0, 1) })
  const layers = Array.isArray(o.layers) ? o.layers.slice(0, MAX_BLEND_LAYERS).map(conformLayer) : []
  return {
    wheels: Object.fromEntries(WHEEL_KEYS.map((k) => [k, { ...tint(wheels[k], DEFAULT_CREATIVE.wheels[k]), luma: num(record(wheels[k]).luma, 0, -1, 1) }])) as CreativeGrade['wheels'],
    split: {
      ...(Object.fromEntries(TONE_KEYS.map((k) => [k, tint(split[k], DEFAULT_CREATIVE.split[k])])) as Pick<CreativeGrade['split'], 'shadow' | 'highlight'>),
      balance: num(split.balance, 0, -1, 1),
    },
    lut: o.lut === null || o.lut === undefined ? null : lut(record(o.lut)),
    lutIntensity: num(o.lutIntensity, 1, 0, 1),
    layers,
  }
}

export function conformGrade(v: unknown, lut: (ref: Json) => LutRef | null): GradeDoc {
  const o = record(v)
  const levels = record(o.levels)
  return {
    levels: Object.fromEntries(GRADE_LEVELS.map((l) => [l, conformAdjust(levels[l])])) as Record<GradeLevel, BasicAdjust>,
    creative: conformCreative(o.creative, lut),
  }
}

/** 后期参数：除暗角外都是 [0,1]。光束和光晕的光源与画面有关，light 把文件中的光源 id 换成文档中的，预设中一律为自动 */
export function conformPost(v: unknown, light: (id: unknown) => string | null = () => null): PostDoc {
  const o = record(v)
  const section = <K extends Exclude<PostSection, 'flare'>>(key: K): PostDoc[K] => {
    const src = record(o[key])
    const out: Json = {}
    for (const [field, fallback] of Object.entries(DEFAULT_POST[key])) {
      if (typeof fallback === 'number') out[field] = num(src[field], fallback, field === 'vignette' ? -1 : 0, 1)
      else if (typeof fallback === 'boolean') out[field] = bool(src[field], fallback)
      else if (typeof fallback === 'string') out[field] = hex(src[field], fallback)
      else out[field] = light(src[field])
    }
    return out as PostDoc[K]
  }
  return {
    bloom: section('bloom'),
    diffusion: section('diffusion'),
    halation: section('halation'),
    rays: section('rays'),
    lens: section('lens'),
    grain: section('grain'),
    flare: conformFlare(o.flare, light),
    toneMapping: oneOf(o.toneMapping, TONE_MAPPINGS, 'none'),
  }
}

// ── 文件 ──

/** 混色层的 id 只在文档内有意义，预设文件和比较中都去掉 */
const withoutIds = (layers: BlendLayer[]) => layers.map((l) => ({ ...l, id: undefined }))

/** 后期参数 → 预设文件和比较中的形式：去掉光束、光晕的光源和光晕元素的 id */
const postForPreset = (p: PostDoc) => ({ ...p, rays: { ...p.rays, light: null }, flare: { ...p.flare, light: null, elements: flareElementsForFile(p.flare.elements) } })

function toBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.length * 4)
  const view = new DataView(bytes.buffer)
  data.forEach((v, i) => view.setFloat32(i * 4, v, true))
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Float32Array {
  const s = atob(text)
  const view = new DataView(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) view.setUint8(i, s.charCodeAt(i))
  const data = new Float32Array(s.length >> 2)
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, true)
  return data
}

const triple = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as [number, number, number]) : null

/** 内嵌的 LUT → 登记后的引用；数据无效时抛出 PresetError */
function embeddedLut(v: unknown): [string, LutRef] {
  const o = record(v)
  const size = o.size
  const domainMin = triple(o.domainMin)
  const domainMax = triple(o.domainMax)
  if (typeof o.id !== 'string' || typeof o.data !== 'string' || typeof size !== 'number' || !Number.isInteger(size) || size < 2 || size > MAX_CUBE_SIZE || !domainMin || !domainMax)
    throw new PresetError('内嵌的 LUT 格式不正确')
  if (domainMax.some((x, c) => x <= domainMin[c])) throw new PresetError('内嵌 LUT 的定义域不正确')
  let data: Float32Array
  try {
    data = fromBase64(o.data)
  } catch {
    throw new PresetError('内嵌的 LUT 数据无法解码')
  }
  if (data.length !== size ** 3 * 3 || data.some((x) => !Number.isFinite(x))) throw new PresetError('内嵌的 LUT 数据长度或数值不正确')
  const lut: CubeLut = { title: typeof o.title === 'string' ? o.title : '', size, data, domainMin, domainMax }
  return [o.id, registerLut(lut, conformName(o.name, 'LUT'))]
}

/** 参数中使用的 LUT → 内嵌到文件中的数据（预设和工程文件共用） */
export function embedLuts(grade: GradeDoc): Json[] {
  const ref = grade.creative.lut
  const lut = ref && getLut(ref.id)
  return lut ? [{ id: lut.id, name: ref.name, title: lut.title, size: lut.size, domainMin: lut.domainMin, domainMax: lut.domainMax, data: toBase64(lut.data) }] : []
}

/** 登记文件中内嵌的 LUT，返回把文件中的 LUT 引用换成已登记引用的函数（供 conformGrade 使用）；数据无效时抛出 PresetError */
export function lutResolver(embedded: unknown): (ref: Json) => LutRef | null {
  const luts = new Map((Array.isArray(embedded) ? embedded : []).map(embeddedLut))
  return (ref) => {
    if (typeof ref.id !== 'string') return null
    const lut = luts.get(ref.id)
    if (lut) return { id: lut.id, name: conformName(ref.name, lut.name) }
    return getLut(ref.id) ? { id: ref.id, name: conformName(ref.name, 'LUT') } : null
  }
}

/** 参数 → 写入文件的形式：混色层去掉 id，找不到数据的 LUT 引用去掉 */
export function gradeForFile(grade: GradeDoc): Json {
  const ref = grade.creative.lut
  return { ...grade, creative: { ...grade.creative, lut: ref && getLut(ref.id) ? ref : null, layers: withoutIds(grade.creative.layers) } }
}

/** 当前参数 → 预设文件的文本。使用中的 LUT 会内嵌进去 */
export function serializePreset(preset: Preset): string {
  return JSON.stringify(
    { format: PRESET_FORMAT, version: PRESET_VERSION, name: preset.name, grade: gradeForFile(preset.grade), post: postForPreset(preset.post), luts: embedLuts(preset.grade) },
    null,
    2,
  )
}

/** 预设文件的文本 → 预设，内嵌的 LUT 会被登记。格式不对时抛出 PresetError */
export function parsePreset(text: string, fallbackName: string): Preset {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PresetError('不是有效的 JSON 文件')
  }
  const o = record(raw)
  if (o.format !== PRESET_FORMAT && !LEGACY_PRESET_FORMATS.includes(o.format as string)) throw new PresetError('不是 Anime2Real 的预设文件')
  if (typeof o.version !== 'number' || o.version > PRESET_VERSION) throw new PresetError('预设来自更新的版本，请更新页面后再试')
  return { name: conformName(o.name, fallbackName), grade: conformGrade(o.grade, lutResolver(o.luts)), post: conformPost(o.post) }
}

/** 参数是否与预设一致（不比较混色层、光晕元素的 id 和光束、光晕的光源） */
export function matchesPreset(grade: GradeDoc, post: PostDoc, preset: Pick<Preset, 'grade' | 'post'>): boolean {
  const key = (g: GradeDoc, p: PostDoc) => JSON.stringify([{ ...g, creative: { ...g.creative, layers: withoutIds(g.creative.layers) } }, postForPreset(p)])
  return key(grade, post) === key(preset.grade, preset.post)
}

// ── 内置预设 ──

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

interface PresetInput {
  levels?: { [L in GradeLevel]?: DeepPartial<BasicAdjust> }
  creative?: DeepPartial<Omit<CreativeGrade, 'layers' | 'lut'>> & { layers?: Partial<Omit<BlendLayer, 'id'>>[] }
  post?: DeepPartial<PostDoc>
}

/** 按色相段名称给出 HSL 的一行 */
const bands = (values: Partial<Record<HslBand, number>>) => HSL_BANDS.map((b) => values[b] ?? 0)

const definePreset = (input: PresetInput) => ({ grade: conformGrade(input, () => null), post: conformPost(input.post) })

export type BuiltinPresetId = 'overcast-film' | 'golden-backlight' | 'night-neon' | 'fresh'

export const BUILTIN_PRESETS: Record<BuiltinPresetId, Omit<Preset, 'name'>> = {
  // 参照 docs/example.png：暖褐色调，绿色压暗偏褐，黑位压低，亮部略收，颗粒与暗角
  'overcast-film': definePreset({
    levels: {
      global: {
        contrast: 0.2,
        highlights: -0.25,
        shadows: -0.1,
        blacks: -0.45,
        temperature: 0.3,
        tint: 0.12,
        vibrance: -0.05,
        saturation: -0.1,
        hsl: {
          hue: bands({ yellow: -0.3, green: -0.7 }),
          saturation: bands({ red: 0.1, orange: -0.1, yellow: -0.5, green: -0.8, aqua: -0.5, blue: -0.1 }),
          luminance: bands({ yellow: -0.3, green: -0.8, aqua: -0.4 }),
        },
        curves: {
          master: [
            [0, 0],
            [0.3, 0.26],
            [0.7, 0.72],
            [1, 0.93],
          ],
        },
        clarity: 0.1,
      },
    },
    creative: {
      wheels: { lift: { hue: 15, amount: 0.12 }, gain: { hue: 70, amount: 0.15 } },
      split: { shadow: { hue: 15, amount: 0.35 }, highlight: { hue: 75, amount: 0.35 }, balance: 0.1 },
    },
    post: {
      bloom: { intensity: 0.1, threshold: 0.8 },
      halation: { intensity: 0.15 },
      rays: { intensity: 0.25, threshold: 0.75, length: 0.6 },
      lens: { vignette: -0.3, feather: 0.6 },
      grain: { amount: 0.35, size: 0.35, color: 0.2 },
    },
  }),
  // 橙色亮部、紫色暗部，光晕和光束加强
  'golden-backlight': definePreset({
    levels: {
      global: {
        contrast: 0.1,
        highlights: -0.3,
        shadows: 0.15,
        blacks: -0.15,
        temperature: 0.45,
        tint: 0.1,
        vibrance: 0.2,
        hsl: {
          hue: bands({ yellow: -0.3, green: -0.3, blue: 0.3 }),
          saturation: bands({ orange: 0.15, green: -0.25, blue: -0.25 }),
        },
      },
    },
    creative: {
      wheels: { gain: { hue: 60, amount: 0.15 } },
      split: { shadow: { hue: 290, amount: 0.3 }, highlight: { hue: 55, amount: 0.45 }, balance: 0.2 },
    },
    post: {
      bloom: { intensity: 0.35, threshold: 0.7, radius: 0.6 },
      halation: { intensity: 0.3, threshold: 0.8, radius: 0.4 },
      rays: { intensity: 0.6, threshold: 0.7, length: 0.7 },
      lens: { vignette: -0.35 },
      grain: { amount: 0.15 },
    },
  }),
  // 青色暗部、品红亮部，强光晕与色差。不用色调映射：Neutral 的趾部会把夜景的暗部压黑并偏色
  'night-neon': definePreset({
    levels: {
      global: {
        contrast: 0.1,
        highlights: -0.2,
        shadows: 0.15,
        temperature: -0.15,
        tint: 0.1,
        vibrance: 0.2,
        hsl: {
          hue: bands({ green: 0.5, blue: 0.2 }),
          saturation: bands({ orange: -0.1, green: -0.4, aqua: 0.2, blue: 0.1, purple: 0.3, magenta: 0.3 }),
        },
      },
    },
    creative: {
      split: { shadow: { hue: 210, amount: 0.25 }, highlight: { hue: 340, amount: 0.4 }, balance: -0.2 },
    },
    post: {
      bloom: { intensity: 0.5, threshold: 0.55, radius: 0.65 },
      halation: { intensity: 0.2, threshold: 0.75 },
      lens: { aberration: 0.3, vignette: -0.45 },
      grain: { amount: 0.25, size: 0.4, color: 0.4 },
    },
  }),
  // 提亮、低对比，黑位发灰，绿色偏青，饱和度略低
  fresh: definePreset({
    levels: {
      global: {
        exposure: 0.3,
        contrast: -0.25,
        highlights: -0.3,
        shadows: 0.35,
        whites: 0.05,
        blacks: 0.1,
        temperature: -0.12,
        tint: -0.05,
        vibrance: -0.05,
        saturation: -0.15,
        hsl: {
          hue: bands({ green: 0.4 }),
          saturation: bands({ red: -0.15, orange: -0.05, yellow: -0.3, green: -0.25, aqua: -0.1, blue: -0.15 }),
          luminance: bands({ orange: 0.15, green: 0.15, blue: 0.1 }),
        },
        curves: {
          master: [
            [0, 0.07],
            [0.5, 0.53],
            [1, 0.97],
          ],
          b: [
            [0, 0.04],
            [1, 1],
          ],
        },
      },
    },
    creative: {
      split: { shadow: { hue: 200, amount: 0.2 }, highlight: { hue: 80, amount: 0.1 } },
    },
    post: {
      bloom: { intensity: 0.15, threshold: 0.8, radius: 0.6 },
      grain: { amount: 0.08 },
    },
  }),
}

export const BUILTIN_PRESET_IDS = Object.keys(BUILTIN_PRESETS) as BuiltinPresetId[]
