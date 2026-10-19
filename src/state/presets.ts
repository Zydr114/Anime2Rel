import { create } from 'zustand'
import { parsePreset, serializePreset, type Preset } from '@/grade/preset'
import { readPresets, writePresets } from '@/io/storage'

/** 导入的预设最多保留的个数 */
const MAX_IMPORTED = 20

/** 导入的预设列表。不参与撤销，保存在浏览器中（连同内嵌的 LUT），下次打开页面时载入。 */
interface PresetLibrary {
  imported: Preset[]
  /** 同名的预设会被替换 */
  add: (preset: Preset) => void
}

export const usePresets = create<PresetLibrary>()((set, get) => ({
  imported: [],
  add: (preset) => {
    set((s) => ({ imported: [...s.imported.filter((p) => p.name !== preset.name), preset].slice(-MAX_IMPORTED) }))
    // 存储不可用（例如隐私模式）时只在本次打开页面期间保留
    writePresets(get().imported.map(serializePreset)).catch(() => {})
  },
}))

if (typeof indexedDB !== 'undefined') {
  readPresets()
    .then((texts) => {
      const saved = texts.flatMap((text) => {
        try {
          return [parsePreset(text, 'Preset')]
        } catch {
          return []
        }
      })
      // 载入完成前刚导入的预设排在后面，同名时以它为准
      usePresets.setState((s) => ({ imported: [...saved.filter((p) => !s.imported.some((q) => q.name === p.name)), ...s.imported].slice(-MAX_IMPORTED) }))
    })
    .catch(() => {})
}
