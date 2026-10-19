/**
 * 去除抠图边缘残留的底色（docs/Plan.md §3.7 M8.1）。
 *
 * 已知 alpha，把像素颜色看作前景色 F 与未知背景色 B 的混合 I = αF + (1 − α)B，
 * 用快速多级前景估计（Germer et al. 2020，“Fast Multi-Level Foreground Estimation”，pymatting 采用的方法）
 * 从 1×1 逐级放大到原尺寸，每级做几次 Gauss-Seidel 迭代，求平滑的 F 与 B。
 *
 * 与原方法的不同：完全透明的像素颜色没有意义（浏览器解码时预乘后为黑色），不参与数据项，
 * 否则背景色会被拉向黑色，半透明处反而解出更亮的前景色。
 * 颜色取 sRGB 编码值：抠图工具一般在编码空间中估计 alpha 和混合颜色，在这里模型才吻合。
 * Worker 在引导分辨率上求解，着色器在原分辨率上用放大后的 F、B 作为邻域值再解一次（src/engine/passes.ts）。
 */

export interface ForegroundOptions {
  /** 平滑项的基础权重 */
  regularization?: number
  /** alpha 梯度对平滑项的加权 */
  gradientWeight?: number
  smallIterations?: number
  bigIterations?: number
  /** 两边都不超过该尺寸的层级用 smallIterations 次迭代 */
  smallSize?: number
}

/** 最近邻缩放（像素中心对齐） */
function resizeNearest(src: Float32Array, sw: number, sh: number, dw: number, dh: number, channels: number): Float32Array {
  const out = new Float32Array(dw * dh * channels)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))
      for (let c = 0; c < channels; c++) out[(y * dw + x) * channels + c] = src[(sy * sw + sx) * channels + c]
    }
  }
  return out
}

/**
 * 输入为 sRGB 编码的 RGB（直通 alpha，交错存放）与 alpha，返回同尺寸的前景色与背景色（sRGB 编码，[0,1]）。
 */
export function estimateForeground(
  rgb: Float32Array,
  alpha: Float32Array,
  w: number,
  h: number,
  options: ForegroundOptions = {},
): { foreground: Float32Array; background: Float32Array } {
  const { regularization = 1e-5, gradientWeight = 1, smallIterations = 10, bigIterations = 2, smallSize = 32 } = options
  // 初值：不透明部分的平均颜色
  const mean = [0, 0, 0]
  let weight = 0
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) mean[c] += alpha[i] * rgb[i * 3 + c]
    weight += alpha[i]
  }
  for (let c = 0; c < 3; c++) mean[c] = weight > 0 ? mean[c] / weight : 0
  let F: Float32Array = Float32Array.from(mean)
  let B: Float32Array = Float32Array.from(mean)
  let pw = 1
  let ph = 1

  const levels = Math.max(1, Math.ceil(Math.log2(Math.max(w, h))))
  const b0 = [0, 0, 0]
  const b1 = [0, 0, 0]
  for (let level = 0; level <= levels; level++) {
    const lw = Math.max(1, Math.round(w ** (level / levels)))
    const lh = Math.max(1, Math.round(h ** (level / levels)))
    const image = level === levels ? rgb : resizeNearest(rgb, w, h, lw, lh, 3)
    const a = level === levels ? alpha : resizeNearest(alpha, w, h, lw, lh, 1)
    F = resizeNearest(F, pw, ph, lw, lh, 3)
    B = resizeNearest(B, pw, ph, lw, lh, 3)
    pw = lw
    ph = lh
    const iterations = lw <= smallSize && lh <= smallSize ? smallIterations : bigIterations
    for (let it = 0; it < iterations; it++)
      for (let y = 0; y < lh; y++)
        for (let x = 0; x < lw; x++) {
          const i = y * lw + x
          const a0 = a[i]
          const a1 = 1 - a0
          // 完全透明的像素没有数据项
          const data = a0 > 0 ? 1 : 0
          let a00 = data * a0 * a0
          const a01 = data * a0 * a1
          let a11 = data * a1 * a1
          for (let c = 0; c < 3; c++) {
            b0[c] = data * a0 * image[i * 3 + c]
            b1[c] = data * a1 * image[i * 3 + c]
          }
          for (let d = 0; d < 4; d++) {
            const x2 = d === 0 ? Math.max(0, x - 1) : d === 1 ? Math.min(lw - 1, x + 1) : x
            const y2 = d === 2 ? Math.max(0, y - 1) : d === 3 ? Math.min(lh - 1, y + 1) : y
            const j = y2 * lw + x2
            const da = regularization + gradientWeight * Math.abs(a0 - a[j])
            a00 += da
            a11 += da
            for (let c = 0; c < 3; c++) {
              b0[c] += da * F[j * 3 + c]
              b1[c] += da * B[j * 3 + c]
            }
          }
          const inv = 1 / (a00 * a11 - a01 * a01)
          for (let c = 0; c < 3; c++) {
            F[i * 3 + c] = Math.min(1, Math.max(0, inv * (a11 * b0[c] - a01 * b1[c])))
            B[i * 3 + c] = Math.min(1, Math.max(0, inv * (a00 * b1[c] - a01 * b0[c])))
          }
        }
  }
  return { foreground: F, background: B }
}
