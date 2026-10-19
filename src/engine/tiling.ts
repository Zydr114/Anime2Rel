/**
 * 分块导出的划分（docs/Plan.md §5）：输出图像按 inner 切成若干块，每块向四周扩展 margin 一起渲染，只取中间的部分写入结果。
 * 扩展的范围在图像边界处截断，此时边缘与整幅渲染一样钳位到图像边界。
 * 扩展量覆盖各 pass 读取邻近像素的距离（景深、锐化、色差等）；超出这个距离的效果（局部调整的大半径滤波、Bloom、光束）由整幅的预览分辨率渲染提供。
 */
import { SHARPEN_RADIUS } from '@/grade/color'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ExportTile {
  /** 写入输出图像的部分 */
  inner: Rect
  /** 渲染的范围，包含 inner */
  target: Rect
}

/** 一块渲染目标的边长上限（约 830 万像素）；不超过这个面积、也不需要从原图裁剪背景时整幅渲染 */
export const TILE_EDGE = 2880
export const WHOLE_PIXELS = TILE_EDGE * TILE_EDGE
/** 块的最小边长 */
const MIN_INNER = 256
/** 固定的扩展量：弥散圆统计的 3×3 个 16 像素块、合成中读取的低层级 mip、双线性插值 */
const BASE_MARGIN = 64

const roundUp = (v: number, k: number) => Math.ceil(v / k) * k

export interface TilePlanInput {
  /** 输出图像的长边，输出像素 / 文档像素 */
  long: number
  scale: number
  /** 弥散圆半径的上限（输出像素），没有景深和遮挡时为 0 */
  coc: number
  /** 色差的缩放量（相对画面中心） */
  aberration: number
  /** 其余超出当前像素的采样距离（文档像素）：水体折射、从原图裁剪背景时的 Light Wrap */
  reach: number
  /** 渲染目标的边长上限 */
  maxEdge: number
  /** 测试用：指定块的边长（不受最小边长限制） */
  inner?: number
}

/**
 * 块的边长和扩展量。块的左上角对齐到不小于弥散圆的 2 的幂（16–512），
 * 使景深的 16 像素统计块、各级 mip 的划分与整幅渲染一致。
 */
export function tilePlan(i: TilePlanInput): { inner: number; margin: number } {
  const align = Math.min(512, Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(i.coc, 1)))))
  const sharpen = Math.max(i.long * SHARPEN_RADIUS, 1)
  // 色差在终处理中读取；锐化在背景层、立绘层、全局各读一次；景深按弥散圆加上 mip 预模糊的范围
  let margin = roundUp(0.5 * i.aberration * i.long + 3 * sharpen + 1.3 * i.coc + i.reach * i.scale + BASE_MARGIN, align)
  const edge = Math.min(TILE_EDGE, i.maxEdge)
  const inner = i.inner ? roundUp(i.inner, align) : Math.max(roundUp(MIN_INNER, align), Math.floor((edge - 2 * margin) / align) * align)
  // 扩展量过大时缩小到渲染目标的上限以内，接缝处的远距离效果会有误差
  if (inner + 2 * margin > i.maxEdge) margin = Math.max(0, Math.floor((i.maxEdge - inner) / 2 / align) * align)
  return { inner: Math.min(inner, i.maxEdge), margin }
}

/** 按行划分；每行的块高度相同，从上到下、从左到右 */
export function planTiles(width: number, height: number, inner: number, margin: number): ExportTile[][] {
  const rows: ExportTile[][] = []
  for (let y = 0; y < height; y += inner) {
    const h = Math.min(inner, height - y)
    const row: ExportTile[] = []
    for (let x = 0; x < width; x += inner) {
      const w = Math.min(inner, width - x)
      const x0 = Math.max(0, x - margin)
      const y0 = Math.max(0, y - margin)
      const x1 = Math.min(width, x + w + margin)
      const y1 = Math.min(height, y + h + margin)
      row.push({ inner: { x, y, width: w, height: h }, target: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
    }
    rows.push(row)
  }
  return rows
}
