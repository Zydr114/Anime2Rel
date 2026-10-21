import { create } from 'zustand'

/** 设置对话框是否打开。深度模型出错时可以从侧栏直接打开。不参与撤销 */
export const useSettingsDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
