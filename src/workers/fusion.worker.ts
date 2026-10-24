/**
 * 立绘融合 Worker（docs/Plan.md §3.3）：缓存当前背景与立绘的低分辨率数据，
 * 计算背景白点和噪声、立绘法线，以及随立绘位置变化的局部统计。
 */
import * as Comlink from 'comlink'
import { mat3Vec } from '@/algo/cat'
import { srgbToLinear } from '@/algo/color'
import { fitWithin } from '@/algo/geometry'
import { oklabImage } from '@/algo/oklab'
import { quantiles, resizeBilinear } from '@/algo/raster'
import type { Vec3 } from '@/algo/sh'
import { DEFAULT_NORMAL_OPTIONS, depthToNormals, packNormals } from '@/algo/normals'
import type { DepthEditRaster } from '@/fusion/depthEdit'
import { estimateForeground } from '@/fusion/matte'
import { characterNormals, rimMap } from '@/fusion/normals'
import { rasterizeWarp, warpMesh } from '@/fusion/warp'
import { ROW_BINS, type BackgroundInfo, type BackgroundInput, type CharacterInfo, type CharacterInput, type FusionStats, type FusionWorkerApi, type MatteMap, type NormalMap, type NormalRequest, type StatsRequest, type WarpedGeometry, type WarpRequest } from '@/fusion/protocol'
import { labStats, noiseSigma, sampleGroundColor, whitePoint } from '@/fusion/stats'

/** 统计用的分辨率（长边） */
const STATS_EDGE = 384
const CHAR_STATS_EDGE = 256
/** 噪声取样块 */
const TILE = 96
const TILE_GRID = 4
/** 过曝阈值（8 位） */
const CLIP = 250
/** 深度相近的尺度（归一化逆深度） */
const DEPTH_SIGMA = 0.12
/** 不透明区域贴着立绘底边、且最下方几行大部分不透明时，视为被裁切的半身像 */
const CUT_EDGE = 0.995
const CUT_COVERAGE = 0.45
/** 变形后统计几何的栅格长边上限 */
const WARP_EDGE = 2048

interface Background {
  id: string
  width: number
  height: number
  linear: Float32Array
  lab: Float32Array
  depth: Float32Array | null
  sky: Float32Array | null
  clipped: Uint8Array
}

interface Character {
  id: string
  width: number
  height: number
  /** sRGB 编码 RGB 与 alpha（引导分辨率） */
  rgb: Float32Array
  alpha: Float32Array
  depthNormal: Uint8Array | null
  /** 立绘自身的归一化逆深度（引导分辨率）；深度未就绪时为 null */
  depth: Float32Array | null
  /** 按深度修正重新计算的深度法线，以及它对应的增量 */
  edited: { delta: Float32Array; depthNormal: Uint8Array } | null
  /** 统计分辨率下的线性 RGB 与 alpha */
  small: { linear: Float32Array; alpha: Float32Array }
  /** 轮廓光的边缘带，只与立绘本身有关，首次求法线时计算 */
  rim: Uint8Array | null
  matte: Omit<MatteMap, 'width' | 'height'> | null
}

let background: Background | null = null
let character: Character | null = null

/** 深度法线：有深度修正时按修正后的深度重新计算（增量不变时沿用上次的结果） */
function editedNormals(ch: Character, edit: DepthEditRaster | null): Uint8Array | null {
  if (!edit || !ch.depth) return ch.depthNormal
  const e = ch.edited
  if (e && e.delta.length === edit.delta.length && e.delta.every((v, i) => v === edit.delta[i])) return e.depthNormal
  const { width: w, height: h } = ch
  const delta = resizeBilinear(edit.delta, edit.width, edit.height, w, h)
  const depth = Float32Array.from(ch.depth, (d, i) => d + delta[i])
  const depthNormal = packNormals(depthToNormals(depth, w, h, DEFAULT_NORMAL_OPTIONS, ch.alpha))
  ch.edited = { delta: edit.delta, depthNormal }
  return depthNormal
}

function pixels(bitmap: ImageBitmap | OffscreenCanvas, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(dw, dh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 2D 画布')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh)
  return ctx.getImageData(0, 0, dw, dh).data
}

/** 均匀分布在画面中的若干原分辨率小块，逐块估计噪声后取中位数。 */
function estimateNoise(bitmap: ImageBitmap): Vec3 {
  const size = Math.min(TILE, bitmap.width, bitmap.height)
  const per: number[][] = [[], [], []]
  for (let gy = 0; gy < TILE_GRID; gy++)
    for (let gx = 0; gx < TILE_GRID; gx++) {
      const x = Math.round(((gx + 0.5) / TILE_GRID) * bitmap.width - size / 2)
      const y = Math.round(((gy + 0.5) / TILE_GRID) * bitmap.height - size / 2)
      const data = pixels(bitmap, Math.max(0, x), Math.max(0, y), size, size, size, size)
      const rgb = new Float32Array(size * size * 3)
      for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = data[i * 4 + c] / 255
      noiseSigma(rgb, size, size).forEach((v, c) => per[c].push(v))
    }
  return per.map((list) => list.sort((a, b) => a - b)[list.length >> 1] ?? 0) as Vec3
}

const emptyRows = () => new Float32Array(ROW_BINS * 2).fill(-1)

/**
 * 不透明区域（alpha > 0.5）的包围盒和每行的左右边界（相对栅格尺寸 [0,1]），
 * 以及包围盒最下方 1% 的行中不透明像素占包围盒宽度的比例（被裁切的半身像接近 1，双脚通常较小）。没有不透明像素时为 null。
 */
function opaqueGeometry(alpha: Float32Array, width: number, height: number) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  const rows = emptyRows()
  for (let y = 0; y < height; y++) {
    const bin = Math.min(ROW_BINS - 1, Math.floor((y / height) * ROW_BINS))
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] <= 0.5) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
      const left = x / width
      const right = (x + 1) / width
      if (rows[bin * 2] < 0 || left < rows[bin * 2]) rows[bin * 2] = left
      rows[bin * 2 + 1] = Math.max(rows[bin * 2 + 1], right)
    }
  }
  if (x1 < 0) return null
  const bottom = Math.max(1, Math.round((y1 - y0 + 1) * 0.01))
  let covered = 0
  for (let y = y1 - bottom + 1; y <= y1; y++) for (let x = x0; x <= x1; x++) if (alpha[y * width + x] > 0.5) covered++
  const bottomCoverage = covered / (bottom * (x1 - x0 + 1))
  return { bbox: { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height }, rows, bottomCoverage }
}

/** 双线性采样单通道图像（坐标为 UV，边缘夹取） */
function sampleBilinear(src: Float32Array, width: number, height: number, u: number, v: number): number {
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5))
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const top = src[y0 * width + x0] * (1 - fx) + src[y0 * width + x1] * fx
  const bottom = src[y1 * width + x0] * (1 - fx) + src[y1 * width + x1] * fx
  return top * (1 - fy) + bottom * fy
}

const api: FusionWorkerApi = {
  async setBackground(input: BackgroundInput): Promise<BackgroundInfo> {
    const { bitmap } = input
    try {
      const { width, height } = fitWithin(bitmap, STATS_EDGE)
      const data = pixels(bitmap, 0, 0, bitmap.width, bitmap.height, width, height)
      const n = width * height
      const linear = new Float32Array(n * 3)
      const clipped = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) linear[i * 3 + c] = srgbToLinear(data[i * 4 + c] / 255)
        clipped[i] = data[i * 4] >= CLIP || data[i * 4 + 1] >= CLIP || data[i * 4 + 2] >= CLIP ? 1 : 0
      }
      const ds = input.depthSize
      const depth = input.depth && ds ? resizeBilinear(input.depth, ds.width, ds.height, width, height) : null
      const sky = input.sky && ds ? resizeBilinear(input.sky, ds.width, ds.height, width, height) : null
      background = { id: input.id, width, height, linear, lab: oklabImage(linear), depth, sky, clipped }

      const ground = Uint8Array.from({ length: n }, (_, i) => (!clipped[i] && (sky?.[i] ?? 0) < 0.5 ? 1 : 0))
      const mean = [0, 0, 0]
      let count = 0
      for (let i = 0; i < n; i++) {
        if (!ground[i]) continue
        for (let c = 0; c < 3; c++) mean[c] += linear[i * 3 + c]
        count++
      }
      return {
        whitePoint: whitePoint(linear, ground),
        noise: estimateNoise(bitmap),
        meanColor: (count ? mean.map((v) => v / count) : [0.18, 0.18, 0.18]) as Vec3,
      }
    } finally {
      bitmap.close()
    }
  },

  async setCharacter(input: CharacterInput): Promise<CharacterInfo> {
    const { bitmap } = input
    const { width, height } = bitmap
    const data = pixels(bitmap, 0, 0, width, height, width, height)
    bitmap.close()
    const n = width * height
    const rgb = new Float32Array(n * 3)
    const alpha = new Float32Array(n)
    const premul = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3] / 255
      alpha[i] = a
      for (let c = 0; c < 3; c++) {
        const v = data[i * 4 + c] / 255
        rgb[i * 3 + c] = v
        premul[i * 3 + c] = srgbToLinear(v) * a
      }
    }
    // 统计分辨率：按预乘值缩放，再除回 alpha
    const small = fitWithin({ width, height }, CHAR_STATS_EDGE)
    const sp = resizeBilinear(premul, width, height, small.width, small.height, 3)
    const sa = resizeBilinear(alpha, width, height, small.width, small.height)
    for (let i = 0; i < sa.length; i++) for (let c = 0; c < 3; c++) sp[i * 3 + c] = sa[i] > 1e-3 ? sp[i * 3 + c] / sa[i] : 0
    const previous = character
    const depth = input.depth?.length === n ? input.depth : null
    character = { id: input.id, width, height, rgb, alpha, depthNormal: input.depthNormal, depth, edited: null, small: { linear: sp, alpha: sa }, rim: null, matte: null }
    // 同一张立绘只是深度结果更新时，沿用只与像素有关的结果
    if (previous?.id === input.id && previous.width === width && previous.height === height) {
      character.rim = previous.rim
      character.matte = previous.matte
    }

    const opaque = Uint8Array.from(alpha, (a) => (a > 0.5 ? 1 : 0))
    const reliefMedian = (depth ? quantiles(depth, [0.5], opaque)?.[0] : undefined) ?? 0.5
    const geometry = opaqueGeometry(alpha, width, height)
    if (!geometry) return { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, reliefMedian, cut: false, rows: emptyRows(), rowSpan: [0, 1] }
    const cut = geometry.bbox.y1 >= CUT_EDGE && geometry.bottomCoverage > CUT_COVERAGE
    return { bbox: geometry.bbox, reliefMedian, cut, rows: geometry.rows, rowSpan: [0, 1] }
  },

  async normals(request: NormalRequest): Promise<NormalMap> {
    const ch = character
    if (!ch || ch.id !== request.id) throw new Error('立绘数据尚未就绪')
    const data = characterNormals({
      width: ch.width,
      height: ch.height,
      rgb: ch.rgb,
      alpha: ch.alpha,
      depthNormal: editedNormals(ch, request.depthEdit),
      weights: request.weights,
      inflateRadius: request.inflateRadius * Math.max(ch.width, ch.height),
    })
    ch.rim ??= rimMap(ch)
    const rim = ch.rim.slice()
    return Comlink.transfer({ width: ch.width, height: ch.height, data, rim }, [data.buffer, rim.buffer])
  },

  async matte(id: string): Promise<MatteMap> {
    const ch = character
    if (!ch || ch.id !== id) throw new Error('立绘数据尚未就绪')
    if (!ch.matte) {
      const n = ch.width * ch.height
      const { foreground, background } = estimateForeground(ch.rgb, ch.alpha, ch.width, ch.height)
      const encode = (rgb: Float32Array) => {
        const out = new Uint8Array(n * 4)
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgb[i * 3 + c] * 255)
          out[i * 4 + 3] = 255
        }
        return out
      }
      ch.matte = { foreground: encode(foreground), background: encode(background) }
    }
    const foreground = ch.matte.foreground.slice()
    const background = ch.matte.background.slice()
    return Comlink.transfer({ width: ch.width, height: ch.height, foreground, background }, [foreground.buffer, background.buffer])
  },

  async warpGeometry(request: WarpRequest): Promise<WarpedGeometry> {
    const ch = character
    if (!ch || ch.id !== request.id) throw new Error('立绘数据尚未就绪')
    const mesh = warpMesh(request.warp)
    const box = mesh.bounds
    // 栅格的分辨率与立绘数据相同，长边不超过 WARP_EDGE
    const k = Math.min(1, WARP_EDGE / Math.max((box.x1 - box.x0) * ch.width, (box.y1 - box.y0) * ch.height))
    const width = Math.max(1, Math.round((box.x1 - box.x0) * ch.width * k))
    const height = Math.max(1, Math.round((box.y1 - box.y0) * ch.height * k))
    const alpha = new Float32Array(width * height)
    rasterizeWarp(mesh, box, width, height, (i, u, v) => {
      alpha[i] = sampleBilinear(ch.alpha, ch.width, ch.height, u, v)
    })
    const g = opaqueGeometry(alpha, width, height)
    if (!g) return { bbox: box, rows: emptyRows(), rowSpan: [box.y0, box.y1] }
    const sx = box.x1 - box.x0
    const sy = box.y1 - box.y0
    const rows = g.rows.map((x) => (x < 0 ? x : box.x0 + x * sx))
    return {
      bbox: { x0: box.x0 + g.bbox.x0 * sx, y0: box.y0 + g.bbox.y0 * sy, x1: box.x0 + g.bbox.x1 * sx, y1: box.y0 + g.bbox.y1 * sy },
      rows,
      rowSpan: [box.y0, box.y1],
    }
  },

  async stats(request: StatsRequest): Promise<FusionStats> {
    const bg = background
    const ch = character
    let characterStats = null
    if (ch && ch.id === request.characterId) {
      const { linear, alpha } = ch.small
      const adapted = new Float32Array(linear.length)
      for (let i = 0; i < alpha.length; i++) adapted.set(mat3Vec(request.cat, [linear[i * 3], linear[i * 3 + 1], linear[i * 3 + 2]]), i * 3)
      characterStats = labStats(oklabImage(adapted), Float32Array.from(alpha, (a) => (a > 0.5 ? 1 : 0)))
    }
    if (!bg || bg.id !== request.backgroundId) return { character: characterStats, local: null, localColor: [0.18, 0.18, 0.18], groundColor: null }

    // 权重：以立绘包围盒为中心的高斯 × 深度相近 × 非天空 × 未过曝
    const { cx, cy, rx, ry } = request.region
    const sx = Math.max(0.05, rx) * 1.5
    const sy = Math.max(0.05, ry) * 1.5
    const n = bg.width * bg.height
    const weights = new Float32Array(n)
    for (let y = 0; y < bg.height; y++)
      for (let x = 0; x < bg.width; x++) {
        const i = y * bg.width + x
        const dx = ((x + 0.5) / bg.width - cx) / sx
        const dy = ((y + 0.5) / bg.height - cy) / sy
        let w = Math.exp(-0.5 * (dx * dx + dy * dy))
        if (bg.depth) w *= Math.exp(-0.5 * ((bg.depth[i] - request.depth) / DEPTH_SIGMA) ** 2)
        if (bg.sky) w *= 1 - 0.9 * bg.sky[i]
        if (bg.clipped[i]) w *= 0.5
        weights[i] = w
      }
    const local = labStats(bg.lab, weights)
    const color = [0, 0, 0]
    let sw = 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) color[c] += weights[i] * bg.linear[i * 3 + c]
      sw += weights[i]
    }
    const localColor = (sw > 0 ? color.map((v) => v / sw) : [0.18, 0.18, 0.18]) as Vec3
    // 地面反光的颜色：接地点周围、离地面平面足够近的像素（M8.8d）
    const ground = request.ground
      ? sampleGroundColor({ linear: bg.linear, depth: bg.depth, sky: bg.sky, width: bg.width, height: bg.height, ...request.ground })
      : null
    return { character: characterStats, local, localColor, groundColor: ground }
  },
}

Comlink.expose(api)
