/**
 * 立绘融合 Worker（docs/Plan.md §3.3）：缓存当前背景与立绘的低分辨率数据，
 * 计算背景白点和噪声、立绘法线，以及随立绘位置变化的局部统计。
 */
import * as Comlink from 'comlink'
import { mat3Vec } from '@/algo/cat'
import { srgbToLinear } from '@/algo/color'
import { fitWithin } from '@/algo/geometry'
import { oklabImage } from '@/algo/oklab'
import { resizeBilinear } from '@/algo/raster'
import type { Vec3 } from '@/algo/sh'
import { characterNormals } from '@/fusion/normals'
import type { BackgroundInfo, BackgroundInput, CharacterInfo, CharacterInput, FusionStats, FusionWorkerApi, NormalMap, NormalRequest, StatsRequest } from '@/fusion/protocol'
import { labStats, noiseSigma, whitePoint } from '@/fusion/stats'

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
  /** 统计分辨率下的线性 RGB 与 alpha */
  small: { linear: Float32Array; alpha: Float32Array }
}

let background: Background | null = null
let character: Character | null = null

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
    character = { id: input.id, width, height, rgb, alpha, depthNormal: input.depthNormal, small: { linear: sp, alpha: sa } }

    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (alpha[y * width + x] <= 0.5) continue
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    if (x1 < 0) return { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }
    return { bbox: { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height } }
  },

  async normals(request: NormalRequest): Promise<NormalMap> {
    const ch = character
    if (!ch || ch.id !== request.id) throw new Error('立绘数据尚未就绪')
    const data = characterNormals({
      width: ch.width,
      height: ch.height,
      rgb: ch.rgb,
      alpha: ch.alpha,
      depthNormal: ch.depthNormal,
      weights: request.weights,
      inflateRadius: request.inflateRadius * Math.max(ch.width, ch.height),
    })
    return Comlink.transfer({ width: ch.width, height: ch.height, data }, [data.buffer])
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
    if (!bg || bg.id !== request.backgroundId) return { character: characterStats, local: null, localColor: [0.18, 0.18, 0.18] }

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
    return { character: characterStats, local, localColor }
  },
}

Comlink.expose(api)
