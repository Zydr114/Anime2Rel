export interface AlphaInfo {
  /** alpha < 250 的像素占比 */
  transparentRatio: number
  /** 是否存在足够的透明区域，可以当作立绘使用 */
  hasTransparency: boolean
}

/** 透明像素占比超过该值才认为图像带有透明背景。 */
export const TRANSPARENCY_THRESHOLD = 0.005

/** 统计 RGBA8 像素数据的透明程度。 */
export function analyzeAlpha(rgba: Uint8ClampedArray | Uint8Array): AlphaInfo {
  const n = rgba.length >> 2
  if (n === 0) return { transparentRatio: 0, hasTransparency: false }
  let transparent = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) transparent++
  const transparentRatio = transparent / n
  return { transparentRatio, hasTransparency: transparentRatio > TRANSPARENCY_THRESHOLD }
}
