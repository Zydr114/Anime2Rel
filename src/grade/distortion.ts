/**
 * 镜头失真（docs/Plan.md §3.7 M8.8a）：以画面中心为原点、半对角线为单位，输出位置 p 处取原画面 z·p·(1 + a·|p|²) 处的颜色。
 * a > 0 为桶形（中间鼓出），a < 0 为枕形（四周拉伸）；z 为填满画面的缩放，四周不会出现空白。
 * 着色器中的同一公式见 src/engine/finish.ts。
 */
import type { Point, Size } from '@/algo/geometry'

/** 失真满格时的 a；|a| < 1/3 时径向映射单调 */
export const DISTORTION_SCALE = 0.25

/** 半对角线为 1 时画面的半宽、半高 */
function halfExtent(size: Size): [number, number] {
  const d = Math.hypot(size.width, size.height)
  return [size.width / d, size.height / d]
}

/**
 * 填满画面的缩放：使边界上各点都落在原画面内的最大 z。
 * 右边界 x = hx 上 |src_x| = z·hx·(1 + a(hx² + y²))，a ≥ 0 时在角落最大，a < 0 时在边的中点最大；上边界同理。
 */
export function distortionZoom(a: number, size: Size): number {
  const [hx, hy] = halfExtent(size)
  return 1 / (a >= 0 ? 1 + a : 1 + a * Math.min(hx * hx, hy * hy))
}

/** 输出图像的 UV → 原画面的 UV */
export function distortUV(uv: Point, a: number, z: number, size: Size): Point {
  const [hx, hy] = halfExtent(size)
  const px = (uv.x - 0.5) * 2 * hx
  const py = (uv.y - 0.5) * 2 * hy
  const f = z * (1 + a * (px * px + py * py))
  return { x: 0.5 + (uv.x - 0.5) * f, y: 0.5 + (uv.y - 0.5) * f }
}

/** 原画面的 UV → 输出图像的 UV：沿半径用牛顿法解 z·ρ·(1 + a·ρ²) = σ */
export function undistortUV(uv: Point, a: number, z: number, size: Size): Point {
  const [hx, hy] = halfExtent(size)
  const sx = (uv.x - 0.5) * 2 * hx
  const sy = (uv.y - 0.5) * 2 * hy
  const sigma = Math.hypot(sx, sy)
  if (sigma < 1e-12) return { ...uv }
  let rho = sigma / z
  for (let i = 0; i < 8; i++) rho -= (z * rho * (1 + a * rho * rho) - sigma) / (z * (1 + 3 * a * rho * rho))
  const k = rho / sigma
  return { x: 0.5 + (uv.x - 0.5) * k, y: 0.5 + (uv.y - 0.5) * k }
}

/** 画面内采样位置的最大位移（相对长边）。位移只与半径有关：|z(1 + a·r²) − 1|·r，r 从 0 到角落的 1 */
export function distortionReach(a: number, z: number, size: Size): number {
  if (a === 0) return 0
  let max = 0
  for (let i = 1; i <= 100; i++) {
    const r = i / 100
    max = Math.max(max, Math.abs(z * (1 + a * r * r) - 1) * r)
  }
  return (max * 0.5 * Math.hypot(size.width, size.height)) / Math.max(size.width, size.height)
}

/** 文档像素坐标的换算：view 为失真后画面上的位置，doc 为原画面上的位置。a 为 0 时都是恒等 */
export function distortionMapping(a: number, size: Size): { toDoc: (p: Point) => Point; toView: (p: Point) => Point } {
  const z = distortionZoom(a, size)
  const map = (f: typeof distortUV) => (p: Point) => {
    if (a === 0) return p
    const q = f({ x: p.x / size.width, y: p.y / size.height }, a, z, size)
    return { x: q.x * size.width, y: q.y * size.height }
  }
  return { toDoc: map(distortUV), toView: map(undistortUV) }
}
