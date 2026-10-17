/** 单通道或多通道浮点栅格的基础运算：缩放、盒式滤波、高斯模糊、分位数。 */

/**
 * 双线性缩放（像素中心对齐，等价于 align_corners=false）。
 * 数据按行优先、通道交错存放。
 */
export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number, channels = 1): Float32Array {
  const out = new Float32Array(dw * dh * channels)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1)
    const y0 = Math.floor(fy)
    const y1 = Math.min(y0 + 1, sh - 1)
    const ty = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1)
      const x0 = Math.floor(fx)
      const x1 = Math.min(x0 + 1, sw - 1)
      const tx = fx - x0
      const o = (y * dw + x) * channels
      const i00 = (y0 * sw + x0) * channels
      const i01 = (y0 * sw + x1) * channels
      const i10 = (y1 * sw + x0) * channels
      const i11 = (y1 * sw + x1) * channels
      for (let c = 0; c < channels; c++) {
        const top = src[i00 + c] + (src[i01 + c] - src[i00 + c]) * tx
        const bottom = src[i10 + c] + (src[i11 + c] - src[i10 + c]) * tx
        out[o + c] = top + (bottom - top) * ty
      }
    }
  }
  return out
}

/**
 * 半径为 r 的盒式均值滤波（窗口 (2r+1)²），边界处按窗口内实际像素数归一化。
 * 行列分离的滑动求和，复杂度与半径无关。
 */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x]
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      tmp[row + x] = sum / (hi - lo + 1)
      if (x + r + 1 < w) sum += src[row + x + r + 1]
      if (x - r >= 0) sum -= src[row + x - r]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      out[y * w + x] = sum / (hi - lo + 1)
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x]
      if (y - r >= 0) sum -= tmp[(y - r) * w + x]
    }
  }
  return out
}

/** 归一化高斯核，半径取 3σ。 */
function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + r] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

/** 可分离高斯模糊，边界外按最近像素延拓。 */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice()
  const k = gaussianKernel(sigma)
  const r = (k.length - 1) / 2
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += k[i + r] * src[row + Math.min(w - 1, Math.max(0, x + i))]
      tmp[row + x] = s
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]
      out[y * w + x] = s
    }
  }
  return out
}

/**
 * 带权重的高斯模糊（归一化卷积）：blur(v·m) / blur(m)。
 * 用于只在遮罩内平滑，避免遮罩外的数值渗入。权重为 0 的区域输出 0。
 */
export function maskedGaussianBlur(src: Float32Array, mask: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const weighted = new Float32Array(w * h)
  for (let i = 0; i < weighted.length; i++) weighted[i] = src[i] * mask[i]
  const num = gaussianBlur(weighted, w, h, sigma)
  const den = gaussianBlur(mask, w, h, sigma)
  for (let i = 0; i < num.length; i++) num[i] = den[i] > 1e-4 ? num[i] / den[i] : 0
  return num
}

/**
 * 求一组分位数（q ∈ [0,1]），只统计 mask 非零（或 mask 缺省）的元素。
 * 没有可统计的元素时返回 null。
 */
export function quantiles(values: Float32Array, qs: readonly number[], mask?: ArrayLike<number>): number[] | null {
  let picked: Float32Array
  if (mask) {
    let n = 0
    for (let i = 0; i < values.length; i++) if (mask[i]) n++
    picked = new Float32Array(n)
    n = 0
    for (let i = 0; i < values.length; i++) if (mask[i]) picked[n++] = values[i]
  } else {
    picked = values.slice()
  }
  if (picked.length === 0) return null
  picked.sort()
  return qs.map((q) => {
    const pos = Math.min(picked.length - 1, Math.max(0, q * (picked.length - 1)))
    const lo = Math.floor(pos)
    const hi = Math.min(picked.length - 1, lo + 1)
    return picked[lo] + (picked[hi] - picked[lo]) * (pos - lo)
  })
}

/**
 * 近似高斯模糊：三次盒式滤波（方差相加），耗时与 σ 无关。
 * 用于大 σ 且对核形状不敏感的场合（如 DoG 斑点检测）。
 */
export function fastGaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice()
  // 半径 r 的盒式滤波方差为 r(r+1)/3，三次叠加为 r(r+1)
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5))
  return boxMean(boxMean(boxMean(src, w, h, r), w, h, r), w, h, r)
}
