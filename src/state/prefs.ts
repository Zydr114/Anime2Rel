import { create } from 'zustand'

const KEY = 'a2r.ui.prefs'

/** 界面偏好（docs/Plan.md §3.7 M8.7），记在浏览器中，不进工程文件，不参与撤销 */
export interface Prefs {
  /** 在视图左下角显示操作提示 */
  opHints: boolean
  /** 操作提示收起成一个按钮 */
  opHintsCollapsed: boolean
}

const DEFAULT_PREFS: Prefs = { opHints: true, opHintsCollapsed: false }

function load(): Prefs {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const saved = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    // 缺少或类型不对的项取默认值
    return Object.fromEntries(Object.entries(DEFAULT_PREFS).map(([k, d]) => [k, typeof saved[k] === typeof d ? saved[k] : d])) as unknown as Prefs
  } catch {
    return DEFAULT_PREFS
  }
}

interface PrefsState extends Prefs {
  setPrefs: (update: Partial<Prefs>) => void
}

export const usePrefs = create<PrefsState>()((set, get) => ({
  ...load(),
  setPrefs: (update) => {
    set(update)
    const prefs = Object.fromEntries(Object.keys(DEFAULT_PREFS).map((k) => [k, get()[k as keyof Prefs]]))
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch {
      // 隐私模式等情况下无法持久化，忽略
    }
  },
}))
