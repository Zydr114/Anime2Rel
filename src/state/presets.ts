import { create } from 'zustand'
import type { Preset } from '@/grade/preset'

/** 本次会话中导入的预设，最多保留的个数 */
const MAX_IMPORTED = 20

/** 导入的预设列表。不参与撤销，刷新页面后清空。 */
interface PresetLibrary {
  imported: Preset[]
  /** 同名的预设会被替换 */
  add: (preset: Preset) => void
}

export const usePresets = create<PresetLibrary>()((set) => ({
  imported: [],
  add: (preset) => set((s) => ({ imported: [...s.imported.filter((p) => p.name !== preset.name), preset].slice(-MAX_IMPORTED) })),
}))
