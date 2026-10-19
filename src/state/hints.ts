import { create } from 'zustand'

const KEY = 'a2r.ui.dismissedHints'

function load(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 初次使用的提示：关闭后记在浏览器中，不再显示。不参与撤销。 */
interface HintsState {
  dismissed: readonly string[]
  dismiss: (id: string) => void
}

export const useHints = create<HintsState>()((set, get) => ({
  dismissed: load(),
  dismiss: (id) => {
    const dismissed = [...get().dismissed.filter((x) => x !== id), id]
    try {
      localStorage.setItem(KEY, JSON.stringify(dismissed))
    } catch {
      // 隐私模式等情况下无法持久化，忽略
    }
    set({ dismissed })
  },
}))
