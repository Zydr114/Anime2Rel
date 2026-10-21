/**
 * 画布的底色（docs/Plan.md §3.7 M8.7b）：二维视图中文档之外的区域、3D 视图中场景之外的方向。
 * 二维视图用中性灰，不影响对图像颜色的判断。随界面主题变化，深色主题下与之前相同。
 */
import type { Vec3 } from '@/algo/sh'

export type Backdrop = 'light' | 'dark'

/** 文档之外的颜色（sRGB 0–255）：深色 #1a1a1a，浅色 #d6d6d6 */
export const SURROUND: Record<Backdrop, number> = { dark: 26, light: 214 }

/** 3D 视图中场景之外的穹顶颜色（线性），从下方渐变到上方 */
export const DOME: Record<Backdrop, { low: Vec3; high: Vec3 }> = {
  dark: { low: [0.016, 0.018, 0.024], high: [0.05, 0.06, 0.08] },
  light: { low: [0.4, 0.41, 0.43], high: [0.62, 0.64, 0.68] },
}
