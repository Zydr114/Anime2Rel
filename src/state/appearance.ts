import { create } from 'zustand'

const REDUCE_EFFECTS_KEY = 'a2r.ui.reduceEffects'

function load(): boolean {
  try {
    return localStorage.getItem(REDUCE_EFFECTS_KEY) === '1'
  } catch {
    return false
  }
}

/** 界面外观的设置，保存在浏览器中。不参与撤销。 */
interface AppearanceState {
  /** 减少特效：玻璃面板改为不透明，不做折射和背景模糊 */
  reduceEffects: boolean
  setReduceEffects: (on: boolean) => void
}

export const useAppearance = create<AppearanceState>()((set) => ({
  reduceEffects: load(),
  setReduceEffects: (on) => {
    try {
      localStorage.setItem(REDUCE_EFFECTS_KEY, on ? '1' : '0')
    } catch {
      // 隐私模式等情况下无法持久化，忽略
    }
    set({ reduceEffects: on })
  },
}))
