/** 由融合参数与统计量换算出的着色器参数（docs/Plan.md §3.3），纯函数，便于单测。 */
import { adaptationMatrix, type Mat3 } from '@/algo/cat'
import type { Vec3 } from '@/algo/sh'
import type { FusionDoc } from './model'

/** 白平衡适配矩阵：立绘按 D65 绘制，适配到按强度插值的背景白点。 */
export function whiteAdaptation(colorMatch: FusionDoc['colorMatch'], background: Vec3): Mat3 {
  const k = colorMatch.whiteBalance
  return adaptationMatrix([1, 1, 1], background.map((c) => 1 + (c - 1) * k))
}
