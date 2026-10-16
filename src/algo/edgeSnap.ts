/**
 * 深度边缘吸附：带颜色权重的中值滤波，只作用于深度过渡带。
 *
 * 低分辨率深度放大后，前后景交界处是一条宽几个像素的渐变带，带内是两侧深度的混合值。
 * 引导滤波和联合双边滤波都只是加权平均，无法消除这些混合值。这里对过渡带内的每个像素，
 * 在窗口内的非过渡带像素中按颜色相似度加权取中值（参考 Ma et al. 2013 的加权中值滤波），
 * 让它归属到颜色相近的一侧，从而把深度边缘吸附到原图边缘上。
 */

export interface SnapOptions {
  /** 搜索窗口半径（像素），需大于过渡带的半宽 */
  radius: number
  /** 颜色相似度的高斯 σ（RGB 欧氏距离，取值 [0,1]） */
  sigmaColor: number
  /** 5×5 邻域内深度极差超过该值的像素视为过渡带 */
  bandThreshold: number
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  radius: 12,
  sigmaColor: 0.1,
  bandThreshold: 0.03,
}

const BINS = 128
const LUT_SIZE = 1024
/** 颜色距离平方的上限：超过 9σ² 的权重可以忽略 */
const LUT_RANGE_SIGMAS2 = 9

/** 5×5 邻域深度极差超过阈值的像素。 */
export function transitionBand(depth: Float32Array, w: number, h: number, threshold: number): Uint8Array {
  // 先求行方向 5 邻域的极值，再求列方向
  const rowMin = new Float32Array(w * h)
  const rowMax = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let lo = Infinity
      let hi = -Infinity
      for (let i = Math.max(0, x - 2); i <= Math.min(w - 1, x + 2); i++) {
        const v = depth[y * w + i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      rowMin[y * w + x] = lo
      rowMax[y * w + x] = hi
    }
  }
  const band = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let lo = Infinity
      let hi = -Infinity
      for (let j = Math.max(0, y - 2); j <= Math.min(h - 1, y + 2); j++) {
        const a = rowMin[j * w + x]
        const b = rowMax[j * w + x]
        if (a < lo) lo = a
        if (b > hi) hi = b
      }
      band[y * w + x] = hi - lo > threshold ? 1 : 0
    }
  }
  return band
}

/**
 * @param guide RGB [0,1] 交错
 * @param depth [0,1]
 * @returns 吸附后的深度（新数组）
 */
export function snapEdges(guide: Float32Array, depth: Float32Array, w: number, h: number, options: SnapOptions = DEFAULT_SNAP_OPTIONS): Float32Array {
  const { radius, sigmaColor, bandThreshold } = options
  const band = transitionBand(depth, w, h, bandThreshold)
  const out = depth.slice()
  // 大窗口隔点采样，控制每个像素的采样数在 ~169 个以内
  const stride = Math.max(1, Math.round(radius / 6))
  const maxD2 = LUT_RANGE_SIGMAS2 * sigmaColor * sigmaColor
  const lut = new Float32Array(LUT_SIZE + 1)
  for (let i = 0; i <= LUT_SIZE; i++) lut[i] = Math.exp(-((i / LUT_SIZE) * maxD2) / (2 * sigmaColor * sigmaColor))
  const lutScale = LUT_SIZE / maxD2
  const wsum = new Float64Array(BINS)
  const vsum = new Float64Array(BINS)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!band[i]) continue
      const r0 = guide[i * 3]
      const g0 = guide[i * 3 + 1]
      const b0 = guide[i * 3 + 2]
      wsum.fill(0)
      vsum.fill(0)
      let total = 0
      for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy += stride) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx += stride) {
          const j = yy * w + xx
          if (band[j]) continue
          const dr = guide[j * 3] - r0
          const dg = guide[j * 3 + 1] - g0
          const db = guide[j * 3 + 2] - b0
          const d2 = dr * dr + dg * dg + db * db
          if (d2 >= maxD2) continue
          const wt = lut[(d2 * lutScale) | 0]
          const v = depth[j]
          const bin = Math.min(BINS - 1, Math.max(0, (v * BINS) | 0))
          wsum[bin] += wt
          vsum[bin] += wt * v
          total += wt
        }
      }
      // 没有颜色相近的可靠像素（如细小结构整体落在过渡带内）时保持原值
      if (total < 1e-3) continue
      let acc = 0
      for (let b = 0; b < BINS; b++) {
        acc += wsum[b]
        if (acc >= total / 2) {
          out[i] = vsum[b] / wsum[b]
          break
        }
      }
    }
  }
  return out
}
