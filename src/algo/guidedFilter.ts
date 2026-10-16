/**
 * 彩色引导滤波（He, Sun & Tang 2010 / 2013），用于把低分辨率深度对齐到原图边缘。
 *
 * 只在引导分辨率上求局部线性系数 a、b 并做均值平滑，最终输出
 * q = mean(a)·I + mean(b)。系数本身是平滑的，可以双线性放大后在任意分辨率上
 * 与全分辨率引导图组合（Fast Guided Filter，He & Sun 2015）——渲染器在着色器中
 * 正是这样计算全分辨率深度的。
 */
import { boxMean } from './raster'

export interface GuidedOptions {
  /** 盒式窗口半径（像素，引导分辨率下） */
  radius: number
  /** 正则项，越小越贴合引导图边缘，也越容易把纹理复制进输出 */
  eps: number
}

/**
 * 计算平滑后的线性系数。
 * @param guide 引导图，RGB 交错，取值 [0,1]
 * @param p 待滤波的单通道输入
 * @returns RGBA 交错：rgb 为 mean(a)，a 为 mean(b)
 */
export function guidedCoefficients(guide: Float32Array, p: Float32Array, w: number, h: number, { radius, eps }: GuidedOptions): Float32Array {
  const n = w * h
  const ch = (c: number) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = guide[i * 3 + c]
    return out
  }
  const prod = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = a[i] * b[i]
    return out
  }
  const mean = (a: Float32Array) => boxMean(a, w, h, radius)

  const ir = ch(0)
  const ig = ch(1)
  const ib = ch(2)
  const mR = mean(ir)
  const mG = mean(ig)
  const mB = mean(ib)
  const mP = mean(p)
  const mRP = mean(prod(ir, p))
  const mGP = mean(prod(ig, p))
  const mBP = mean(prod(ib, p))
  const mRR = mean(prod(ir, ir))
  const mRG = mean(prod(ir, ig))
  const mRB = mean(prod(ir, ib))
  const mGG = mean(prod(ig, ig))
  const mGB = mean(prod(ig, ib))
  const mBB = mean(prod(ib, ib))

  const aR = new Float32Array(n)
  const aG = new Float32Array(n)
  const aB = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // 协方差 cov(I, p)
    const cR = mRP[i] - mR[i] * mP[i]
    const cG = mGP[i] - mG[i] * mP[i]
    const cB = mBP[i] - mB[i] * mP[i]
    // Σ + εU（对称 3×3）
    const s00 = mRR[i] - mR[i] * mR[i] + eps
    const s01 = mRG[i] - mR[i] * mG[i]
    const s02 = mRB[i] - mR[i] * mB[i]
    const s11 = mGG[i] - mG[i] * mG[i] + eps
    const s12 = mGB[i] - mG[i] * mB[i]
    const s22 = mBB[i] - mB[i] * mB[i] + eps
    // 伴随矩阵求逆
    const i00 = s11 * s22 - s12 * s12
    const i01 = s02 * s12 - s01 * s22
    const i02 = s01 * s12 - s02 * s11
    const i11 = s00 * s22 - s02 * s02
    const i12 = s01 * s02 - s00 * s12
    const i22 = s00 * s11 - s01 * s01
    const det = s00 * i00 + s01 * i01 + s02 * i02
    const inv = 1 / det
    const ar = (i00 * cR + i01 * cG + i02 * cB) * inv
    const ag = (i01 * cR + i11 * cG + i12 * cB) * inv
    const ab = (i02 * cR + i12 * cG + i22 * cB) * inv
    aR[i] = ar
    aG[i] = ag
    aB[i] = ab
    b[i] = mP[i] - ar * mR[i] - ag * mG[i] - ab * mB[i]
  }

  const maR = mean(aR)
  const maG = mean(aG)
  const maB = mean(aB)
  const mb = mean(b)
  const coef = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    coef[i * 4] = maR[i]
    coef[i * 4 + 1] = maG[i]
    coef[i * 4 + 2] = maB[i]
    coef[i * 4 + 3] = mb[i]
  }
  return coef
}

/** 用系数和同分辨率的引导图求输出 q = a·I + b。 */
export function applyGuided(coef: Float32Array, guide: Float32Array, w: number, h: number): Float32Array {
  const n = w * h
  const q = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    q[i] = coef[i * 4] * guide[i * 3] + coef[i * 4 + 1] * guide[i * 3 + 1] + coef[i * 4 + 2] * guide[i * 3 + 2] + coef[i * 4 + 3]
  }
  return q
}

/** 便捷函数：一次完成系数求解和输出。 */
export function guidedFilter(guide: Float32Array, p: Float32Array, w: number, h: number, options: GuidedOptions): Float32Array {
  return applyGuided(guidedCoefficients(guide, p, w, h, options), guide, w, h)
}
