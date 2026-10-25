import { create } from 'zustand'

/** 设置对话框是否打开。深度模型出错时可以从侧栏直接打开。不参与撤销 */
export const useSettingsDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** 新手指引（docs/Plan.md §3.7 M8.9）：是否显示、当前页。是否看过记在 useHints 中，不参与撤销 */
export const useTour = create<{ open: boolean; page: number; show: () => void; close: () => void; setPage: (page: number) => void }>()((set) => ({
  open: false,
  page: 0,
  show: () => set({ open: true, page: 0 }),
  close: () => set({ open: false }),
  setPage: (page) => set({ page }),
}))

/** 新手指引在 useHints 中的 id：第一次进入编辑器时自动显示一次 */
export const TOUR_HINT = 'tour'
