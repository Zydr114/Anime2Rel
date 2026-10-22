/**
 * 局部调整蒙版（可撤销，docs/Plan.md §3.7 M8.8b）。坐标、半径都是文档像素。
 * 每个局部调整由形状、限定范围和一组调整组成，按列表顺序作用在全局基础调整之后；不随调色预设保存。
 */
import { mat3Mul, type Mat3 } from '@/algo/cat'
import type { Size } from '@/algo/geometry'
import type { BrushStroke } from '@/focus/model'
import { whiteBalanceMatrix } from './color'
import { hexToEncoded } from './creative'
import { BLEND_MODES, type BlendMode } from './model'

export type MaskShape = 'full' | 'ellipse' | 'linear' | 'brush'
export const MASK_SHAPES: readonly MaskShape[] = ['full', 'ellipse', 'linear', 'brush']

/** 限定范围：全部、立绘、背景、天空、按深度、按亮度 */
export type MaskRangeKind = 'all' | 'character' | 'background' | 'sky' | 'depth' | 'luminance'
export const MASK_RANGES: readonly MaskRangeKind[] = ['all', 'character', 'background', 'sky', 'depth', 'luminance']

export const MAX_MASKS = 8

export interface EllipseShape {
  x: number
  y: number
  rx: number
  ry: number
  /** 旋转（弧度），rx 所在的轴从文档 x 轴顺时针转过的角度 */
  rotation: number
  /** 羽化 [0,1]：(1 − feather) 倍半径以内完全作用，到边缘过渡为 0 */
  feather: number
}

/** 线性渐变：起点线上完全作用，终点线上不作用；两条线都垂直于起点到终点的连线 */
export interface LinearShape {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface MaskRange {
  kind: MaskRangeKind
  /** 按深度：作用于比分界近（true）还是远的部分 */
  near: boolean
  /** 按深度：分界（归一化逆深度，越大越近）与过渡宽度 */
  depth: number
  softness: number
  /** 按亮度：作用于亮度（编码值）在 [low, high] 之间的部分 */
  low: number
  high: number
}

export interface MaskAdjust {
  /** 曝光（EV） */
  exposure: number
  /** 以下为 [-1,1]，与基础调整相同 */
  contrast: number
  temperature: number
  tint: number
  saturation: number
  /** 叠色：sRGB 十六进制颜色、混合模式、不透明度 [0,1] */
  color: string
  mode: BlendMode
  opacity: number
}

export interface LocalMask {
  id: string
  enabled: boolean
  shape: MaskShape
  /** 反相（全画面以外的形状） */
  invert: boolean
  /** 各形状的参数都保留，切换形状时不丢失 */
  ellipse: EllipseShape
  linear: LinearShape
  strokes: BrushStroke[]
  /** 画笔边缘吸附到背景的边缘 */
  snap: boolean
  range: MaskRange
  adjust: MaskAdjust
}

/** 带参数的部分，按部分更新 */
export type MaskPart = 'ellipse' | 'linear' | 'range' | 'adjust'

export const DEFAULT_RANGE: MaskRange = { kind: 'all', near: false, depth: 0.5, softness: 0.1, low: 0, high: 1 }

export const NEUTRAL_MASK_ADJUST: MaskAdjust = { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, color: '#ff9d4d', mode: 'soft-light', opacity: 0 }

let maskCounter = 0
export function newMaskId(): string {
  return `mask-${++maskCounter}`
}

/** 新的局部调整：椭圆在画面中间；线性渐变从画面底边到中间，用于压暗下半部分 */
export function newMask(doc: Size): LocalMask {
  const r = Math.min(doc.width, doc.height) / 4
  return {
    id: newMaskId(),
    enabled: true,
    shape: 'ellipse',
    invert: false,
    ellipse: { x: doc.width / 2, y: doc.height / 2, rx: r, ry: r, rotation: 0, feather: 0.5 },
    linear: { x0: doc.width / 2, y0: doc.height, x1: doc.width / 2, y1: doc.height / 2 },
    strokes: [],
    snap: true,
    range: DEFAULT_RANGE,
    adjust: NEUTRAL_MASK_ADJUST,
  }
}

/** 调整不改变任何颜色 */
export function isNeutralMaskAdjust(a: MaskAdjust): boolean {
  return a.exposure === 0 && a.contrast === 0 && a.temperature === 0 && a.tint === 0 && a.saturation === 0 && a.opacity === 0
}

/** 画笔是否画过（只有橡皮的笔画什么也画不出来） */
export const hasBrush = (m: LocalMask) => m.strokes.some((s) => !s.erase)

/** 这个局部调整会改变画面：启用、有调整，且画笔形状画过（反相的画笔没画过时作用于全画面） */
export function maskActive(m: LocalMask): boolean {
  return m.enabled && !isNeutralMaskAdjust(m.adjust) && (m.shape !== 'brush' || m.invert || hasBrush(m))
}

/** 文档坐标按 (kx, ky) 缩放 */
export function rescaleMask(m: LocalMask, kx: number, ky: number): LocalMask {
  const k = Math.min(kx, ky)
  const e = m.ellipse
  const l = m.linear
  return {
    ...m,
    ellipse: { ...e, x: e.x * kx, y: e.y * ky, rx: e.rx * kx, ry: e.ry * ky },
    linear: { x0: l.x0 * kx, y0: l.y0 * ky, x1: l.x1 * kx, y1: l.y1 * ky },
    strokes: m.strokes.map((s) => ({ ...s, radius: s.radius * k, points: s.points.map((v, i) => v * (i % 2 ? ky : kx)) })),
  }
}

/**
 * 每个局部调整打包成的 vec4 个数（src/engine/masks.ts），依次为：
 * (形状序号, 反相, 羽化, 是否作用)、椭圆 (中心 x, y, 半径 rx, ry)、(cos 旋转, sin 旋转, 0, 0)、线性渐变 (x0, y0, x1, y1)、
 * 范围 (种类序号, 近处, 分界, 过渡)、(亮度下限, 上限, 对比度, 饱和度)、白平衡矩阵乘以曝光增益的三行 (xyz) 与 w = (混合模式序号, 叠色不透明度, 0)、叠色 (编码值)
 */
export const MASK_VEC4S = 10

/** 局部调整的着色器参数 */
export interface MaskParams {
  /** 有会改变画面的局部调整 */
  active: boolean
  /** 打包的项数（文档中的全部局部调整，包括不起作用的，以便预览其中任意一项的蒙版） */
  count: number
  data: Float32Array
}

const paramsCache = new WeakMap<readonly LocalMask[], MaskParams>()

/** 同一个列表返回同一个结果 */
export function maskParams(masks: readonly LocalMask[]): MaskParams {
  const cached = paramsCache.get(masks)
  if (cached) return cached
  const list = masks.slice(0, MAX_MASKS)
  const data = new Float32Array(MAX_MASKS * MASK_VEC4S * 4)
  list.forEach((m, i) => {
    const { ellipse: e, linear: l, range: r, adjust: a } = m
    const gain = 2 ** a.exposure
    const wb: Mat3 = mat3Mul([gain, 0, 0, 0, gain, 0, 0, 0, gain], whiteBalanceMatrix(a.temperature, a.tint))
    data.set(
      [
        ...[MASK_SHAPES.indexOf(m.shape), m.invert ? 1 : 0, e.feather, maskActive(m) ? 1 : 0],
        ...[e.x, e.y, e.rx, e.ry],
        ...[Math.cos(e.rotation), Math.sin(e.rotation), 0, 0],
        ...[l.x0, l.y0, l.x1, l.y1],
        ...[MASK_RANGES.indexOf(r.kind), r.near ? 1 : 0, r.depth, r.softness],
        ...[r.low, r.high, a.contrast, a.saturation],
        ...[wb[0], wb[1], wb[2], BLEND_MODES.indexOf(a.mode)],
        ...[wb[3], wb[4], wb[5], a.opacity],
        ...[wb[6], wb[7], wb[8], 0],
        ...[...hexToEncoded(a.color), 0],
      ],
      i * MASK_VEC4S * 4,
    )
  })
  const params = { active: list.some(maskActive), count: list.length, data }
  paramsCache.set(masks, params)
  return params
}
