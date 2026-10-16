/**
 * 深度估计的前后处理（docs/Plan.md §3.1），不依赖推理后端，可在 Worker 和单测中复用。
 */
import { DEFAULT_SNAP_OPTIONS, snapEdges } from '@/algo/edgeSnap'
import { applyGuided, guidedCoefficients } from '@/algo/guidedFilter'
import { DEFAULT_NORMAL_OPTIONS, depthToNormals } from '@/algo/normals'
import { quantiles, resizeBilinear } from '@/algo/raster'
import { skyMask } from '@/algo/sky'

export type DepthKind = 'background' | 'character'

/** DA V2 的预处理参数（与 preprocessor_config.json 一致） */
const PATCH = 14
const SHORT_SIDE = 518
const MAX_ASPECT = 3
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
/** 立绘推理时垫底的中性灰（sRGB 8 位） */
export const NEUTRAL_GRAY = 128
/** 引导分辨率的长边上限 */
export const GUIDE_MAX_EDGE = 1024

export interface Size {
  width: number
  height: number
}

/**
 * 模型输入尺寸：短边缩放到 518，长边按比例取 14 的倍数；
 * 长宽比超过 3:1 时限制长边，短边随之缩小。
 */
export function modelInputSize(width: number, height: number): Size {
  const portrait = height > width
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  let s = SHORT_SIDE
  let l = Math.round((long * SHORT_SIDE) / short / PATCH) * PATCH
  const maxLong = SHORT_SIDE * MAX_ASPECT
  if (l > maxLong) {
    l = maxLong
    s = Math.max(PATCH, Math.round((short * maxLong) / long / PATCH) * PATCH)
  }
  return portrait ? { width: s, height: l } : { width: l, height: s }
}

/** 引导分辨率：长边不超过 GUIDE_MAX_EDGE，且不放大原图。 */
export function guideSize(width: number, height: number, maxEdge = GUIDE_MAX_EDGE): Size {
  const k = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/**
 * 把非预乘的 RGBA8 像素转成引导图（RGB [0,1]）和 alpha。
 * 立绘按 alpha 合成到中性灰上，与推理输入保持一致。
 */
export function toGuide(rgba: Uint8ClampedArray, kind: DepthKind): { guide: Float32Array; alpha: Float32Array } {
  const n = rgba.length / 4
  const guide = new Float32Array(n * 3)
  const alpha = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = kind === 'character' ? rgba[i * 4 + 3] / 255 : 1
    alpha[i] = a
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c] * a + NEUTRAL_GRAY * (1 - a)
      guide[i * 3 + c] = v / 255
    }
  }
  return { guide, alpha }
}

/** 引导图 → 模型输入张量（NCHW，ImageNet 均值方差归一化）。 */
export function toModelInput(guide: Float32Array, size: Size): Float32Array {
  const n = size.width * size.height
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (guide[i * 3 + c] - MEAN[c]) / STD[c]
  }
  return out
}

/** 按 1% / 99% 分位数把模型输出归一化到 [0,1]；立绘只统计不透明区域。 */
export function normalizeDepth(raw: Float32Array, alpha?: Float32Array): Float32Array {
  const mask = alpha ? Uint8Array.from(alpha, (a) => (a > 0.5 ? 1 : 0)) : undefined
  const q = quantiles(raw, [0.01, 0.99], mask) ?? quantiles(raw, [0.01, 0.99])!
  const [lo, hi] = q
  const range = hi - lo > 1e-6 ? hi - lo : 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = Math.min(1, Math.max(0, (raw[i] - lo) / range))
  return out
}

export interface GuideInput {
  size: Size
  guide: Float32Array
  alpha: Float32Array
}

export interface DepthMaps {
  kind: DepthKind
  /** 模型输入尺寸 */
  model: Size
  /** 引导分辨率 */
  guideSize: Size
  /** 引导分辨率下未经边缘对齐的深度（双线性放大） */
  rawUp: Float32Array
  /** 引导滤波系数 RGBA：q = rgb·I + a，I 为 sRGB 编码的颜色（立绘先合成到中性灰） */
  coef: Float32Array
  /** 引导分辨率下边缘对齐后的深度 [0,1] */
  depth: Float32Array
  /** 法线与置信度，RGBA8：rgb = n·0.5 + 0.5，a = 置信度 */
  normal: Uint8Array
  /** 天空遮罩 [0,1]，仅背景 */
  sky: Float32Array | null
}

export interface PostOptions {
  /** 边缘吸附的搜索半径（引导分辨率下，像素）；缺省按分辨率自动选择 */
  snapRadius?: number
  /** 最终引导滤波的窗口半径；缺省按分辨率自动选择 */
  radius?: number
  eps?: number
}

/** 按引导分辨率换算的默认参数（以长边 1024 为基准）。 */
export function postParams(guide: Size, options: PostOptions = {}) {
  const k = Math.max(guide.width, guide.height) / 1024
  return {
    snapRadius: options.snapRadius ?? Math.max(4, Math.round(DEFAULT_SNAP_OPTIONS.radius * k)),
    radius: options.radius ?? Math.max(2, Math.round(4 * k)),
    eps: options.eps ?? 1e-3,
  }
}

/**
 * 后处理：归一化 → 放大到引导分辨率 → 边缘吸附 → 引导滤波 → 法线 → 天空遮罩。
 * @param raw 模型输出（模型分辨率）
 * @param modelAlpha 模型分辨率下的 alpha（立绘），背景传 undefined
 */
export function postprocess(kind: DepthKind, raw: Float32Array, model: Size, modelAlpha: Float32Array | undefined, guideIn: GuideInput, options: PostOptions = {}): DepthMaps {
  const { width: gw, height: gh } = guideIn.size
  const params = postParams(guideIn.size, options)
  const norm = normalizeDepth(raw, modelAlpha)
  const rawUp = resizeBilinear(norm, model.width, model.height, gw, gh)
  // 先把过渡带吸附到原图边缘，再用小窗口引导滤波得到可在任意分辨率求值的线性系数
  const snapped = snapEdges(guideIn.guide, rawUp, gw, gh, { ...DEFAULT_SNAP_OPTIONS, radius: params.snapRadius })
  const coef = guidedCoefficients(guideIn.guide, snapped, gw, gh, { radius: params.radius, eps: params.eps })
  const depth = applyGuided(coef, guideIn.guide, gw, gh)
  for (let i = 0; i < depth.length; i++) depth[i] = Math.min(1, Math.max(0, depth[i]))

  const sky = kind === 'background' ? skyMask(depth, guideIn.guide, gw, gh) : null
  const mask = kind === 'character' ? guideIn.alpha : undefined
  const { normal, confidence } = depthToNormals(depth, gw, gh, DEFAULT_NORMAL_OPTIONS, mask, sky ?? undefined)
  const packed = new Uint8Array(gw * gh * 4)
  for (let i = 0; i < gw * gh; i++) {
    packed[i * 4] = Math.round((normal[i * 3] * 0.5 + 0.5) * 255)
    packed[i * 4 + 1] = Math.round((normal[i * 3 + 1] * 0.5 + 0.5) * 255)
    packed[i * 4 + 2] = Math.round((normal[i * 3 + 2] * 0.5 + 0.5) * 255)
    packed[i * 4 + 3] = Math.round(confidence[i] * 255)
  }
  return { kind, model, guideSize: guideIn.size, rawUp, coef, depth, normal: packed, sky }
}
