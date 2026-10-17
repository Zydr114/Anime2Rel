import { encodePng } from './png'

type Rgb = readonly [number, number, number]

interface Shape {
  /** 有符号距离（像素，内部为负） */
  sdf: (x: number, y: number) => number
  color: Rgb
}

const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) - r

/** 轴对齐的梯形：上下边中心在 cx，半宽从 top 处的 w0 线性变到 bottom 处的 w1 */
const trapezoid = (cx: number, top: number, bottom: number, w0: number, w1: number) => (x: number, y: number) => {
  const t = Math.min(1, Math.max(0, (y - top) / (bottom - top)))
  const half = w0 + (w1 - w0) * t
  return Math.max(Math.abs(x - cx) - half, top - y, y - bottom)
}

/**
 * 程序生成的简笔立绘：头、头发、裙子、双腿，带 2 px 黑色描边，背景透明。
 * 尺寸 w×h，形状按比例摆放，便于在不同分辨率下复用。
 */
export function figure(w: number, h: number): Buffer {
  const skin: Rgb = [250, 222, 205]
  const shapes: Shape[] = [
    { sdf: circle(w * 0.5, h * 0.17, w * 0.2), color: [95, 62, 52] },
    { sdf: circle(w * 0.5, h * 0.2, w * 0.17), color: skin },
    { sdf: trapezoid(w * 0.5, h * 0.33, h * 0.75, w * 0.14, w * 0.36), color: [70, 110, 205] },
    { sdf: trapezoid(w * 0.4, h * 0.74, h * 0.99, w * 0.05, w * 0.04), color: skin },
    { sdf: trapezoid(w * 0.6, h * 0.74, h * 0.99, w * 0.05, w * 0.04), color: skin },
  ]
  const outline = 2
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const ds = shapes.map((s) => s.sdf(px, py))
      const d = Math.min(...ds)
      const alpha = Math.min(1, Math.max(0, 0.5 - d))
      // 头发在后、皮肤在前：取最后一个包含该点的形状
      let k = -1
      ds.forEach((v, i) => {
        if (v < 0) k = i
      })
      const top = k >= 0 ? ds[k] : d
      const line = Math.min(1, Math.max(0, outline + 0.5 + top)) * (d < 0.5 ? 1 : 0)
      const color = shapes[Math.max(k, 0)].color
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(color[c] * (1 - line) + 20 * line)
      rgba[i + 3] = Math.round(alpha * 255)
    }
  return encodePng(w, h, rgba)
}
