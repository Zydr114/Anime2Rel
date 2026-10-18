import { create } from 'zustand'

/** 遮挡区域在界面上的颜色（按区域序号） */
export const REGION_COLORS: readonly [number, number, number][] = [
  [244, 114, 182],
  [56, 189, 248],
  [250, 204, 21],
  [74, 222, 128],
]

export const regionColor = (index: number, alpha = 1) => `rgba(${REGION_COLORS[index % REGION_COLORS.length].join(', ')}, ${alpha})`

export type BrushTool = 'brush' | 'eraser'

/** 遮挡区域画笔的界面状态。不参与撤销。 */
interface RegionToolState {
  /** 正在编辑的区域；null 时画布上不显示画笔 */
  active: string | null
  tool: BrushTool
  /** 画笔直径（屏幕像素） */
  size: number

  setActive: (id: string | null) => void
  setTool: (tool: BrushTool) => void
  setSize: (size: number) => void
}

export const useRegionTool = create<RegionToolState>()((set) => ({
  active: null,
  tool: 'brush',
  size: 40,
  setActive: (active) => set({ active }),
  setTool: (tool) => set({ tool }),
  setSize: (size) => set({ size }),
}))
