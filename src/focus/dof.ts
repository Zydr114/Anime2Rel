/**
 * 景深与深度遮挡的基础公式（docs/Plan.md §3.4），与 src/engine/dof.ts 中的着色器一致。
 *
 * 薄透镜在对焦距离远大于焦距时，弥散圆半径 ≈ 光圈 × 焦距 × |1/对焦距离 − 1/物体距离|，
 * 与逆深度之差成正比。深度模型输出的逆深度与真实值只差未知的比例和偏移：比例并入光圈，偏移在相减时抵消。
 */
import { pseudoDepth } from '@/algo/camera'
import { clamp, type Size } from '@/algo/geometry'
import { DEFAULT_NORMAL_OPTIONS, focalLength } from '@/algo/normals'

/** 伪深度 z = 1 / (d + shift) 的平移量，与光源和法线使用同一个值 */
export const DEPTH_SHIFT = DEFAULT_NORMAL_OPTIONS.shift
/** 立绘起伏换算时伪深度的下限，防止厚度过大时深度变为无穷 */
export const MIN_PSEUDO_DEPTH = 0.05

/**
 * 弥散圆半径（相对图像长边）。正值表示在焦平面之前（近景），负值表示在焦平面之后（远景）。
 * @param depth 归一化逆深度
 * @param focus 焦点的归一化逆深度
 */
export function circleOfConfusion(depth: number, focus: number, aperture: number, range: number): number {
  const delta = depth - focus
  return Math.sign(delta) * aperture * Math.max(Math.abs(delta) - range, 0)
}

/**
 * 立绘起伏换算到伪深度的比例：厚度 × 立绘高度在相机空间中的长度。
 * @param heightPx 立绘不透明区域的高度（文档像素）
 * @param plane 立绘所在的归一化逆深度
 */
export function reliefScale(thickness: number, heightPx: number, plane: number, size: Size, fovDeg: number): number {
  return (thickness * heightPx * pseudoDepth(plane, DEPTH_SHIFT)) / focalLength(size.width, size.height, fovDeg)
}

/**
 * 立绘某处的归一化逆深度：立绘平面向前（起伏大于基准时）或向后偏移。
 * @param relief 立绘自身的归一化逆深度 [0,1]，1 为最近
 * @param reference 起伏的基准（立绘不透明区域的中位数），此处正好位于立绘平面上
 */
export function reliefDepth(plane: number, relief: number, reference: number, scale: number): number {
  const z = pseudoDepth(plane, DEPTH_SHIFT) - (relief - reference) * scale
  return 1 / Math.max(z, MIN_PSEUDO_DEPTH) - DEPTH_SHIFT
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / Math.max(e1 - e0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 深度遮挡强度：背景比立绘近出 tolerance 时为 0.5，在 softness 宽度内从 0 过渡到 1。 */
export function occlusionMask(background: number, character: number, tolerance: number, softness: number): number {
  return smoothstep(tolerance - softness / 2, tolerance + softness / 2, background - character)
}

/** 散景采样点：位置（单位半径内）、所在的同心层半径（覆盖判断用）和面积权重 */
export type KernelPoint = [x: number, y: number, radius: number, weight: number]

/**
 * 散景采样核：单位圆盘内按 Vogel 螺旋均匀分布的 n 个点，半径递增；
 * blades ≥ 3 时沿径向映射到正多边形，权重补偿映射造成的密度变化。
 */
export function bokehKernel(n: number, blades: number, rotation: number): KernelPoint[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const sector = blades >= 3 ? (2 * Math.PI) / blades : 0
  const points: KernelPoint[] = []
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n)
    const theta = i * golden
    let rho = 1
    if (sector) {
      const a = (((theta - rotation) % sector) + sector) % sector
      rho = Math.cos(sector / 2) / Math.cos(a - sector / 2)
    }
    points.push([r * rho * Math.cos(theta), r * rho * Math.sin(theta), r, rho * rho])
  }
  return points
}
