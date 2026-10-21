import { create } from 'zustand'

const KEY = 'a2r.ui.groups'

function load(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
  } catch {
    return {}
  }
}

/** 侧栏分组的展开状态（docs/Plan.md §3.7 M8.7），按分组记在浏览器中。不进工程文件，不参与撤销。没有记录的分组按各自的默认值 */
interface GroupsState {
  open: Readonly<Record<string, boolean>>
  setOpen: (id: string, open: boolean) => void
}

export const useGroups = create<GroupsState>()((set, get) => ({
  open: load(),
  setOpen: (id, open) => {
    if (get().open[id] === open) return
    const next = { ...get().open, [id]: open }
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // 隐私模式等情况下无法持久化，忽略
    }
    set({ open: next })
  },
}))

/** 展开一个分组（选中光源、遮挡区域等对象时） */
export const openGroup = (id: string) => useGroups.getState().setOpen(id, true)
