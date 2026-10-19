/**
 * 液态玻璃的位移图（docs/Plan.md §6.3）：面板边缘是一圈凸起的玻璃，背景按 Snell 定律折射后的位置采样。
 * 数学参考 iyinchao/liquid-glass-studio（MIT）：超椭圆圆角矩形的距离场 → 边缘的高度剖面 → 表面法线 → 折射偏移。
 * 结果作为 feDisplacementMap 的输入：R、G 为 x、y 方向的偏移（128 为不偏移），scale 取最大偏移的两倍；B 为边缘的高光强度。
 */

export interface GlassShape {
  width: number
  height: number
  radius: number
  /** 圆角的超椭圆指数：4 对应 CSS 的 corner-shape: squircle，2 为普通圆角 */
  exponent: number
}

export interface GlassOptics {
  /** 边缘凸起的宽度（像素） */
  bezel: number
  /** 凸起的高度（像素），决定折射偏移的大小 */
  thickness: number
  /** 折射率 */
  ior: number
}

/** 按面板尺寸取光学参数：小元素（提示、消息条）的凸起窄一些 */
export function opticsFor(width: number, height: number): GlassOptics {
  const bezel = Math.min(24, Math.max(4, Math.min(width, height) * 0.3))
  return { bezel, thickness: bezel * 1.6, ior: 1.5 }
}

/** 高度剖面 h(s) = (1 − (1 − s)⁴)^¼，s 为离外沿的距离 / 凸起宽度 */
const bump = (s: number) => Math.pow(1 - Math.pow(1 - s, 4), 0.25)

/** h'(s) */
function slope(s: number): number {
  const u = 1 - s
  return (u * u * u) / Math.pow(Math.max(1 - u * u * u * u, 1e-6), 0.75)
}

/** 离外沿 t 像素处的折射偏移（像素，指向面板内部） */
export function refractionOffset(t: number, optics: GlassOptics): number {
  if (t <= 0 || t >= optics.bezel) return 0
  const s = t / optics.bezel
  // 竖直入射的视线经过倾斜的表面后偏离竖直方向，穿过高 h 的玻璃后落点横向移动 h·tan(偏角)
  const incidence = Math.atan(slope(s) * (optics.thickness / optics.bezel))
  const refracted = Math.asin(Math.sin(incidence) / optics.ior)
  return bump(s) * optics.thickness * Math.tan(incidence - refracted)
}

/**
 * 圆角矩形内一点到外沿的距离（内部为正）和外法线方向。
 * 圆角为 |x|ⁿ + |y|ⁿ = rⁿ 的超椭圆，距离按 (r − ρ) / |∇ρ| 近似，在边界附近与真实距离一致。
 */
export function edgeDistance(x: number, y: number, shape: GlassShape): { t: number; nx: number; ny: number } {
  const r = Math.min(shape.radius, shape.width / 2, shape.height / 2)
  const dx = x - shape.width / 2
  const dy = y - shape.height / 2
  const qx = Math.abs(dx) - (shape.width / 2 - r)
  const qy = Math.abs(dy) - (shape.height / 2 - r)
  const sx = Math.sign(dx) || 1
  const sy = Math.sign(dy) || 1
  if (qx > 0 && qy > 0) {
    const n = shape.exponent
    const rho = Math.pow(qx ** n + qy ** n, 1 / n)
    // ∇ρ = (qxⁿ⁻¹, qyⁿ⁻¹) / ρⁿ⁻¹
    const gx = (qx / rho) ** (n - 1)
    const gy = (qy / rho) ** (n - 1)
    const g = Math.hypot(gx, gy)
    return { t: (r - rho) / g, nx: (sx * gx) / g, ny: (sy * gy) / g }
  }
  return qx > qy ? { t: r - qx, nx: sx, ny: 0 } : { t: r - qy, nx: 0, ny: sy }
}

/** 高光的光源方向（左上），外法线与它平行或反平行的边缘最亮 */
const LIGHT = [-0.6, -0.8]

/** 位移图（RGBA8，按行排列）与 feDisplacementMap 使用的 scale */
export function displacementMap(shape: GlassShape, optics = opticsFor(shape.width, shape.height)): { data: Uint8ClampedArray<ArrayBuffer>; scale: number } {
  const { width, height } = shape
  const data = new Uint8ClampedArray(width * height * 4)
  // 偏移剖面按 1/8 像素制表
  const steps = Math.ceil(optics.bezel * 8)
  const profile = new Float32Array(steps + 1)
  for (let i = 0; i <= steps; i++) profile[i] = refractionOffset(i / 8, optics)
  const max = Math.max(...profile, 1e-3)
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 1], data[i + 2], data[i + 3]] = [128, 128, 0, 255]
  // 只有离边缘不到 rim 的像素受影响，中间一大块保持不偏移
  const rim = Math.ceil(Math.max(optics.bezel, Math.min(shape.radius, width / 2, height / 2))) + 1
  for (let y = 0; y < height; y++) {
    const inner = y >= rim && y < height - rim
    for (let x = 0; x < width; x++) {
      if (inner && x === rim) x = Math.max(rim, width - rim)
      const e = edgeDistance(x + 0.5, y + 0.5, shape)
      if (e.t >= optics.bezel || e.t <= -1) continue
      const t = Math.max(e.t, 0)
      const k = profile[Math.min(steps, Math.round(t * 8))] / max
      const s = t / optics.bezel
      // 外沿约 1.5 像素的亮线加上凸起内侧的微光，按法线与光源方向的夹角调制
      const facing = Math.abs(e.nx * LIGHT[0] + e.ny * LIGHT[1])
      const spec = (Math.min(1, Math.max(0, 1.5 - t)) * 0.8 + 0.2 * (1 - s) ** 4) * (0.3 + 0.7 * facing * facing)
      const i = (y * width + x) * 4
      // feDisplacementMap 在 (x + scale·(R − 0.5), y + scale·(G − 0.5)) 处采样：沿外法线的反方向，即从内侧取背景
      data[i] = 128 - 127 * k * e.nx
      data[i + 1] = 128 - 127 * k * e.ny
      data[i + 2] = 255 * Math.min(1, spec)
    }
  }
  return { data, scale: 2 * max }
}
