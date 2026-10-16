import { create } from 'zustand'
import type { AssetRef } from './assets'
import { defaultLayerTransform, fitView, NO_INSETS, type Insets, type LayerTransform, type Size, type ViewTransform } from '@/algo/geometry'

export type StepId = 'assets' | 'depth' | 'light' | 'character' | 'focus' | 'adjust' | 'effects' | 'export'

/** 可撤销的文档状态。所有字段必须可序列化（资源只保存引用）。 */
export interface DocState {
  background: AssetRef | null
  character: AssetRef | null
  charTransform: LayerTransform
}

const HISTORY_LIMIT = 100

const emptyTransform: LayerTransform = { x: 0, y: 0, scale: 1, rotation: 0, flipX: false }

export const initialDoc: DocState = { background: null, character: null, charTransform: emptyTransform }

interface AppState {
  doc: DocState
  past: DocState[]
  future: DocState[]
  /** 连续操作（拖拽、滑块）开始时的文档快照；非空表示处于一次连续操作中 */
  gestureBase: DocState | null

  view: ViewTransform
  viewport: Size
  /** 浮动面板遮挡的视口边距，用于“适应窗口” */
  viewInsets: Insets
  step: StepId

  setDoc: (update: Partial<DocState> | ((doc: DocState) => DocState)) => void
  beginGesture: () => void
  endGesture: () => void
  undo: () => void
  redo: () => void

  setBackground: (asset: AssetRef) => void
  setCharacter: (asset: AssetRef | null) => void
  setCharTransform: (update: Partial<LayerTransform>) => void
  resetCharTransform: () => void

  setView: (view: ViewTransform) => void
  setViewport: (size: Size) => void
  setViewInsets: (insets: Insets) => void
  fitToView: () => void
  setStep: (step: StepId) => void
}

const pushPast = (past: DocState[], doc: DocState) => [...past.slice(-(HISTORY_LIMIT - 1)), doc]

export const useApp = create<AppState>()((set, get) => ({
  doc: initialDoc,
  past: [],
  future: [],
  gestureBase: null,

  view: { zoom: 1, panX: 0, panY: 0 },
  viewport: { width: 1, height: 1 },
  viewInsets: NO_INSETS,
  step: 'assets',

  setDoc: (update) => {
    const { doc, gestureBase, past } = get()
    const next = typeof update === 'function' ? update(doc) : { ...doc, ...update }
    if (next === doc) return
    if (gestureBase) set({ doc: next })
    else set({ doc: next, past: pushPast(past, doc), future: [] })
  },

  beginGesture: () => {
    if (!get().gestureBase) set({ gestureBase: get().doc })
  },

  endGesture: () => {
    const { gestureBase, doc, past } = get()
    if (!gestureBase) return
    if (gestureBase === doc) set({ gestureBase: null })
    else set({ gestureBase: null, past: pushPast(past, gestureBase), future: [] })
  },

  undo: () => {
    const { past, doc, future, gestureBase } = get()
    if (gestureBase || past.length === 0) return
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future] })
  },

  redo: () => {
    const { past, doc, future, gestureBase } = get()
    if (gestureBase || future.length === 0) return
    set({ doc: future[0], past: pushPast(past, doc), future: future.slice(1) })
  },

  setBackground: (asset) => {
    const { doc, viewport, viewInsets } = get()
    const sizeChanged = !doc.background || doc.background.width !== asset.width || doc.background.height !== asset.height
    if (!doc.background) {
      // 首次导入背景是文档的起点，不进入撤销历史（避免撤销回到没有背景的空状态）
      const charTransform = doc.character ? defaultLayerTransform(asset, doc.character) : doc.charTransform
      set({ doc: { ...doc, background: asset, charTransform }, past: [], future: [] })
    } else {
      get().setDoc((d) => {
        // 更换尺寸不同的背景时，按比例保持立绘的相对位置和大小
        if (!d.character || !d.background || !sizeChanged) return { ...d, background: asset }
        const k = asset.width / d.background.width
        const ky = asset.height / d.background.height
        const t = d.charTransform
        return { ...d, background: asset, charTransform: { ...t, x: t.x * k, y: t.y * ky, scale: t.scale * Math.min(k, ky) } }
      })
    }
    if (sizeChanged) set({ view: fitView(asset, viewport, undefined, viewInsets) })
  },

  setCharacter: (asset) => {
    get().setDoc((d) => {
      if (!asset) return { ...d, character: null }
      const keep = d.character && d.character.width === asset.width && d.character.height === asset.height
      const charTransform = keep || !d.background ? d.charTransform : defaultLayerTransform(d.background, asset)
      return { ...d, character: asset, charTransform }
    })
  },

  setCharTransform: (update) => {
    get().setDoc((d) => ({ ...d, charTransform: { ...d.charTransform, ...update } }))
  },

  resetCharTransform: () => {
    const { background, character } = get().doc
    if (!background || !character) return
    get().setDoc((d) => ({ ...d, charTransform: defaultLayerTransform(background, character) }))
  },

  setView: (view) => set({ view }),
  setViewport: (viewport) => set({ viewport }),
  setViewInsets: (viewInsets) => set({ viewInsets }),
  fitToView: () => {
    const { doc, viewport, viewInsets } = get()
    if (doc.background) set({ view: fitView(doc.background, viewport, undefined, viewInsets) })
  },
  setStep: (step) => set({ step }),
}))
