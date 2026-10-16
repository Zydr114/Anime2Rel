/**
 * 由相对逆深度求相机空间法线（docs/Plan.md §3.1）。
 *
 * Depth Anything 输出的是仿射不变的逆深度 d（越大越近）。取伪深度 D = 1 / (d + β)，
 * 在透视相机下对像素 (x, y)（相对主点、y 向上）有
 *   n ∝ (f·∂lnD/∂x, f·∂lnD/∂y, 1 + x·∂lnD/∂x + y·∂lnD/∂y)
 * 其中 f 为以像素计的焦距。ln D 的梯度与 D 的整体缩放无关，只剩下平移量 β 这一个未知数。
 *
 * 法线所在坐标系：x 向右，y 向上，z 指向相机。
 */
import { gaussianBlur, maskedGaussianBlur } from './raster'

export interface NormalOptions {
  /** 长边方向的视场角（度） */
  fovDeg: number
  /** 逆深度平移量 β：越小，远处被推得越远 */
  shift: number
  /** 多尺度平滑的高斯 σ（像素） */
  sigmas: readonly number[]
  /** 置信度在 |f·∇lnD| 达到该值时降到一半（约等于表面倾角的正切） */
  slopeHalf: number
}

export const DEFAULT_NORMAL_OPTIONS: NormalOptions = {
  fovDeg: 60,
  shift: 0.1,
  sigmas: [1.5, 4, 10],
  slopeHalf: 4,
}

export interface NormalMap {
  /** 每像素 xyz，交错存放 */
  normal: Float32Array
  /** 每像素置信度 [0,1] */
  confidence: Float32Array
}

/** 焦距（像素），视场角按长边计算。 */
export function focalLength(w: number, h: number, fovDeg: number): number {
  return Math.max(w, h) / 2 / Math.tan((fovDeg * Math.PI) / 360)
}

/**
 * @param depth 归一化逆深度 [0,1]
 * @param mask 可选的有效区域（如立绘 alpha），平滑只在区域内进行
 * @param down 可选的降权区域（如天空遮罩），置信度乘以 (1 - down)
 */
export function depthToNormals(
  depth: Float32Array,
  w: number,
  h: number,
  options: NormalOptions = DEFAULT_NORMAL_OPTIONS,
  mask?: Float32Array,
  down?: Float32Array,
): NormalMap {
  const n = w * h
  const lnD = new Float32Array(n)
  for (let i = 0; i < n; i++) lnD[i] = -Math.log(Math.max(depth[i], 0) + options.shift)
  // 不同尺度梯度的平均：小尺度保留形体，大尺度压掉引导滤波带来的纹理起伏
  const gx = new Float32Array(n)
  const gy = new Float32Array(n)
  const gxFine = new Float32Array(n)
  const gyFine = new Float32Array(n)
  options.sigmas.forEach((sigma, s) => {
    const sm = mask ? maskedGaussianBlur(lnD, mask, w, h, sigma) : gaussianBlur(lnD, w, h, sigma)
    for (let y = 0; y < h; y++) {
      const ym = Math.max(0, y - 1) * w
      const y0 = y * w
      const yp = Math.min(h - 1, y + 1) * w
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1)
        const xp = Math.min(w - 1, x + 1)
        // Sobel，除以 8 得到单位像素上的梯度；图像 y 向下
        const dx = (sm[ym + xp] + 2 * sm[y0 + xp] + sm[yp + xp] - sm[ym + xm] - 2 * sm[y0 + xm] - sm[yp + xm]) / 8
        const dy = (sm[yp + xm] + 2 * sm[yp + x] + sm[yp + xp] - sm[ym + xm] - 2 * sm[ym + x] - sm[ym + xp]) / 8
        const i = y0 + x
        gx[i] += dx / options.sigmas.length
        gy[i] += dy / options.sigmas.length
        if (s === 0) {
          gxFine[i] = dx
          gyFine[i] = dy
        }
      }
    }
  })

  const f = focalLength(w, h, options.fovDeg)
  const cx = w / 2
  const cy = h / 2
  const normal = new Float32Array(n * 3)
  const confidence = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      // 转成 y 向上的坐标
      const px = x + 0.5 - cx
      const py = cy - (y + 0.5)
      const dX = gx[i]
      const dY = -gy[i]
      let nx = f * dX
      let ny = f * dY
      let nz = 1 + px * dX + py * dY
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      // 背向相机（与指向相机的视线 (-px, -py, f) 夹角大于 90°）的法线来自深度噪声，翻到相机一侧
      if (-px * nx - py * ny + f * nz < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      normal[i * 3] = nx
      normal[i * 3 + 1] = ny
      normal[i * 3 + 2] = nz
      // 深度不连续处梯度极大，置信度下降
      const slope = f * Math.hypot(gxFine[i], gyFine[i]) / options.slopeHalf
      let c = 1 / (1 + slope * slope)
      if (mask) c *= mask[i]
      if (down) c *= 1 - down[i]
      confidence[i] = c
    }
  }
  return { normal, confidence }
}
