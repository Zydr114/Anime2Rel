import { create } from 'zustand'
import { conformCustomFlare, flareElementsForFile, type CustomFlare } from '@/grade/flare'
import { readFlares, writeFlares } from '@/io/storage'

/** 自定义光晕最多保留的个数 */
export const MAX_CUSTOM_FLARES = 20

/** 自定义光晕的列表。不参与撤销，保存在浏览器中，下次打开页面时载入。 */
interface FlareLibrary {
  custom: CustomFlare[]
  /** 同名的光晕会被替换 */
  add: (flare: CustomFlare) => void
  remove: (name: string) => void
}

function save(list: CustomFlare[]) {
  // 存储不可用（例如隐私模式）时只在本次打开页面期间保留
  writeFlares(list.map((f) => ({ name: f.name, elements: flareElementsForFile(f.elements) }))).catch(() => {})
}

export const useFlares = create<FlareLibrary>()((set, get) => ({
  custom: [],
  add: (flare) => {
    set((s) => ({ custom: [...s.custom.filter((f) => f.name !== flare.name), flare].slice(-MAX_CUSTOM_FLARES) }))
    save(get().custom)
  },
  remove: (name) => {
    set((s) => ({ custom: s.custom.filter((f) => f.name !== name) }))
    save(get().custom)
  },
}))

if (typeof indexedDB !== 'undefined') {
  readFlares()
    .then((list) => {
      const saved = list.flatMap((v) => conformCustomFlare(v) ?? [])
      // 载入完成前刚保存的光晕排在后面，同名时以它为准
      useFlares.setState((s) => ({ custom: [...saved.filter((f) => !s.custom.some((g) => g.name === f.name)), ...s.custom].slice(-MAX_CUSTOM_FLARES) }))
    })
    .catch(() => {})
}
