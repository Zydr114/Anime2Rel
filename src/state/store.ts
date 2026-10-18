import { create } from 'zustand'
import type { AssetRef } from './assets'
import { defaultLayerTransform, fitView, NO_INSETS, type Insets, type LayerTransform, type Size, type ViewTransform } from '@/algo/geometry'
import { DEFAULT_FOCUS, DEFAULT_STYLE, MAX_REGIONS, newRegionId, type BrushStroke, type FocusDoc, type FocusSection, type OcclusionRegion, type OcclusionStyle } from '@/focus/model'
import { DEFAULT_FUSION, type FusionDoc, type FusionSection } from '@/fusion/model'
import { DEFAULT_LIGHTING, MAX_LIGHTS, type Light, type LightingDoc } from '@/lighting/model'

export type StepId = 'assets' | 'depth' | 'light' | 'character' | 'focus' | 'adjust' | 'effects' | 'export'

/** 可撤销的文档状态。所有字段必须可序列化（资源只保存引用）。 */
export interface DocState {
  background: AssetRef | null
  character: AssetRef | null
  charTransform: LayerTransform
  lighting: LightingDoc
  fusion: FusionDoc
  focus: FocusDoc
}

const HISTORY_LIMIT = 100

const emptyTransform: LayerTransform = { x: 0, y: 0, scale: 1, rotation: 0, flipX: false }

export const initialDoc: DocState = {
  background: null,
  character: null,
  charTransform: emptyTransform,
  lighting: DEFAULT_LIGHTING,
  fusion: DEFAULT_FUSION,
  focus: DEFAULT_FOCUS,
}

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

  setLighting: (update: Partial<Omit<LightingDoc, 'lights'>>) => void
  /** 添加光源；达到上限时返回 false */
  addLight: (light: Light) => boolean
  updateLight: (id: string, update: Partial<Omit<Light, 'id'>>) => void
  removeLight: (id: string) => void
  /**
   * 用分析得到的候选替换全部光源。record 为 false 时原地替换、不产生撤销记录：
   * 换背景后的首次自动分析属于“换背景”这一步的结果，撤销时应与背景一起回退。
   */
  replaceLights: (lights: Light[], analyzedFor: string, record: boolean) => void

  updateFusion: <K extends FusionSection>(section: K, update: Partial<FusionDoc[K]>) => void
  /** 立绘所在深度；null 为自动 */
  setCharDepth: (depth: number | null) => void
  /** 接地点（立绘 UV）；null 为自动 */
  setCharGround: (ground: FusionDoc['ground']) => void
  resetFusion: () => void

  updateFocus: <K extends FocusSection>(section: K, update: Partial<FocusDoc[K]>) => void
  setFocus: (update: Partial<Pick<FocusDoc, 'target' | 'thickness'>>) => void
  /** 恢复默认的景深与遮挡参数，保留焦点和画好的遮挡区域 */
  resetFocus: () => void
  /** 添加遮挡区域，返回其 id；达到上限时返回 null */
  addRegion: () => string | null
  updateRegion: (id: string, update: Partial<OcclusionStyle>) => void
  removeRegion: (id: string) => void
  addRegionStroke: (id: string, stroke: BrushStroke) => void

  setView: (view: ViewTransform) => void
  setViewport: (size: Size) => void
  setViewInsets: (insets: Insets) => void
  fitToView: () => void
  setStep: (step: StepId) => void
}

const pushPast = (past: DocState[], doc: DocState) => [...past.slice(-(HISTORY_LIMIT - 1)), doc]

function setRegions(get: () => AppState, update: (regions: OcclusionRegion[]) => OcclusionRegion[]): void {
  get().setDoc((d) => ({ ...d, focus: { ...d.focus, occlusion: { ...d.focus.occlusion, regions: update(d.focus.occlusion.regions) } } }))
}

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
        // 更换尺寸不同的背景时，按比例保持立绘、背景焦点和遮挡区域的相对位置
        if (!d.background || !sizeChanged) return { ...d, background: asset }
        const k = asset.width / d.background.width
        const ky = asset.height / d.background.height
        const t = d.charTransform
        const target = d.focus.target
        const regions = d.focus.occlusion.regions.map((r) => ({
          ...r,
          strokes: r.strokes.map((st) => ({ ...st, radius: st.radius * Math.min(k, ky), points: st.points.map((v, i) => v * (i % 2 ? ky : k)) })),
        }))
        const focus = {
          ...d.focus,
          target: target?.kind === 'background' ? { ...target, x: target.x * k, y: target.y * ky } : target,
          occlusion: { ...d.focus.occlusion, regions },
        }
        const charTransform = d.character ? { ...t, x: t.x * k, y: t.y * ky, scale: t.scale * Math.min(k, ky) } : t
        return { ...d, background: asset, charTransform, focus }
      })
    }
    if (sizeChanged) set({ view: fitView(asset, viewport, undefined, viewInsets) })
  },

  setCharacter: (asset) => {
    get().setDoc((d) => {
      // 立绘上的焦点和接地点只对原来的立绘有意义
      const focus = d.focus.target?.kind === 'character' ? { ...d.focus, target: null } : d.focus
      const fusion = d.fusion.ground ? { ...d.fusion, ground: null } : d.fusion
      if (!asset) return { ...d, character: null, focus, fusion }
      const keep = d.character && d.character.width === asset.width && d.character.height === asset.height
      const charTransform = keep || !d.background ? d.charTransform : defaultLayerTransform(d.background, asset)
      return { ...d, character: asset, charTransform, focus, fusion }
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

  setLighting: (update) => {
    get().setDoc((d) => ({ ...d, lighting: { ...d.lighting, ...update } }))
  },

  addLight: (light) => {
    if (get().doc.lighting.lights.length >= MAX_LIGHTS) return false
    get().setDoc((d) => ({ ...d, lighting: { ...d.lighting, lights: [...d.lighting.lights, light] } }))
    return true
  },

  updateLight: (id, update) => {
    get().setDoc((d) => {
      const lights = d.lighting.lights.map((l) => (l.id === id ? { ...l, ...update } : l))
      return { ...d, lighting: { ...d.lighting, lights } }
    })
  },

  removeLight: (id) => {
    get().setDoc((d) => {
      const lights = d.lighting.lights.filter((l) => l.id !== id)
      return lights.length === d.lighting.lights.length ? d : { ...d, lighting: { ...d.lighting, lights } }
    })
  },

  replaceLights: (lights, analyzedFor, record) => {
    const update = (d: DocState): DocState => ({ ...d, lighting: { ...d.lighting, lights: lights.slice(0, MAX_LIGHTS), analyzedFor } })
    if (record) get().setDoc(update)
    else set({ doc: update(get().doc) })
  },

  updateFusion: (section, update) => {
    get().setDoc((d) => ({ ...d, fusion: { ...d.fusion, [section]: { ...d.fusion[section], ...update } } }))
  },

  setCharDepth: (depth) => {
    get().setDoc((d) => ({ ...d, fusion: { ...d.fusion, depth } }))
  },

  setCharGround: (ground) => {
    get().setDoc((d) => ({ ...d, fusion: { ...d.fusion, ground } }))
  },

  resetFusion: () => {
    get().setDoc((d) => ({ ...d, fusion: { ...DEFAULT_FUSION, depth: d.fusion.depth, ground: d.fusion.ground } }))
  },

  updateFocus: (section, update) => {
    get().setDoc((d) => ({ ...d, focus: { ...d.focus, [section]: { ...d.focus[section], ...update } } }))
  },

  setFocus: (update) => {
    get().setDoc((d) => ({ ...d, focus: { ...d.focus, ...update } }))
  },

  resetFocus: () => {
    get().setDoc((d) => ({ ...d, focus: { ...DEFAULT_FOCUS, target: d.focus.target, occlusion: { ...DEFAULT_FOCUS.occlusion, regions: d.focus.occlusion.regions } } }))
  },

  addRegion: () => {
    if (get().doc.focus.occlusion.regions.length >= MAX_REGIONS) return null
    const region: OcclusionRegion = { ...DEFAULT_STYLE, id: newRegionId(), strokes: [] }
    setRegions(get, (regions) => [...regions, region])
    return region.id
  },

  updateRegion: (id, update) => {
    setRegions(get, (regions) => regions.map((r) => (r.id === id ? { ...r, ...update } : r)))
  },

  removeRegion: (id) => {
    setRegions(get, (regions) => regions.filter((r) => r.id !== id))
  },

  addRegionStroke: (id, stroke) => {
    setRegions(get, (regions) => regions.map((r) => (r.id === id ? { ...r, strokes: [...r.strokes, stroke] } : r)))
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
