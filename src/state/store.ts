import { create } from 'zustand'
import type { AssetRef } from './assets'
import { defaultLayerTransform, fitView, NO_INSETS, type Insets, type LayerTransform, type Size, type ViewTransform } from '@/algo/geometry'
import { DEFAULT_FOCUS, DEFAULT_STYLE, MAX_REGIONS, newRegionId, type BrushStroke, type FocusDoc, type FocusSection, type OcclusionRegion, type OcclusionStyle } from '@/focus/model'
import { DEFAULT_FUSION, type FusionDoc, type FusionSection } from '@/fusion/model'
import {
  DEFAULT_ADJUST,
  DEFAULT_CREATIVE,
  DEFAULT_GRADE,
  MAX_BLEND_LAYERS,
  newBlendLayer,
  type BasicAdjust,
  type BlendLayer,
  type ColorWheel,
  type CreativeGrade,
  type GradeDoc,
  type GradeLevel,
  type SplitToning,
  type WheelKey,
} from '@/grade/model'
import { MAX_FLARE_ELEMENTS, newFlareElement, newFlareId, sameFlareElements, type FlareDoc, type FlareElement, type FlareElementType } from '@/grade/flare'
import { DEFAULT_POST, type PostDoc, type PostSection, type ToneMapping } from '@/grade/post'
import { matchesPreset, type Preset } from '@/grade/preset'
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
  grade: GradeDoc
  post: PostDoc
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
  grade: DEFAULT_GRADE,
  post: DEFAULT_POST,
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
  /** 是否已离开首屏进入编辑器 */
  started: boolean

  setDoc: (update: Partial<DocState> | ((doc: DocState) => DocState)) => void
  /** 打开工程：替换整个文档并清空撤销历史 */
  loadDoc: (doc: DocState, step: StepId) => void
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

  updateAdjust: (level: GradeLevel, update: Partial<BasicAdjust>) => void
  resetAdjust: (level: GradeLevel) => void
  updateWheel: (key: WheelKey, update: Partial<ColorWheel>) => void
  updateSplit: (update: Partial<SplitToning>) => void
  updateCreative: (update: Partial<Pick<CreativeGrade, 'lut' | 'lutIntensity'>>) => void
  /** 在最上面添加混色层，返回其 id；达到上限时返回 null */
  addBlendLayer: () => string | null
  updateBlendLayer: (id: string, update: Partial<Omit<BlendLayer, 'id'>>) => void
  removeBlendLayer: (id: string) => void
  /** 把混色层上移（+1）或下移（−1）一层 */
  moveBlendLayer: (id: string, delta: 1 | -1) => void
  resetCreative: () => void

  updatePost: <K extends PostSection>(section: K, update: Partial<PostDoc[K]>) => void
  /** 在最后添加光晕元素，返回其 id；达到上限时返回 null */
  addFlareElement: (type: FlareElementType) => string | null
  updateFlareElement: (id: string, update: Partial<Omit<FlareElement, 'id'>>) => void
  /** 在原元素后面插入副本，返回副本的 id；达到上限时返回 null */
  duplicateFlareElement: (id: string) => string | null
  removeFlareElement: (id: string) => void
  /** 在列表中前移（−1）或后移（+1） */
  moveFlareElement: (id: string, delta: 1 | -1) => void
  /** 换成一组元素（内置或自定义光晕，重新分配 id）并开启光晕，一次撤销记录 */
  setFlareElements: (elements: FlareElement[]) => void
  setToneMapping: (mode: ToneMapping) => void
  resetPost: () => void
  /** 套用预设（一次撤销记录）：替换三级调整、全局调色和后期参数，保留光束和光晕所选的光源 */
  applyPreset: (preset: Pick<Preset, 'grade' | 'post'>) => void

  setView: (view: ViewTransform) => void
  setViewport: (size: Size) => void
  setViewInsets: (insets: Insets) => void
  fitToView: () => void
  setStep: (step: StepId) => void
  start: () => void
}

/** 文档坐标按 (kx, ky) 缩放：立绘位置与大小、背景上的焦点、遮挡区域和点光源的位置随之变化 */
export function rescaleDoc(d: DocState, kx: number, ky: number): DocState {
  if (kx === 1 && ky === 1) return d
  const k = Math.min(kx, ky)
  const t = d.charTransform
  const target = d.focus.target
  const regions = d.focus.occlusion.regions.map((r) => ({
    ...r,
    strokes: r.strokes.map((st) => ({ ...st, radius: st.radius * k, points: st.points.map((v, i) => v * (i % 2 ? ky : kx)) })),
  }))
  const focus = {
    ...d.focus,
    target: target?.kind === 'background' ? { ...target, x: target.x * kx, y: target.y * ky } : target,
    occlusion: { ...d.focus.occlusion, regions },
  }
  const charTransform = d.character ? { ...t, x: t.x * kx, y: t.y * ky, scale: t.scale * k } : t
  const lights = d.lighting.lights.map((l) => ({ ...l, position: { ...l.position, x: l.position.x * kx, y: l.position.y * ky } }))
  return { ...d, charTransform, focus, lighting: { ...d.lighting, lights } }
}

const pushPast = (past: DocState[], doc: DocState) => [...past.slice(-(HISTORY_LIMIT - 1)), doc]

function setCreative(get: () => AppState, update: (c: CreativeGrade) => CreativeGrade): void {
  get().setDoc((d) => {
    const creative = update(d.grade.creative)
    return creative === d.grade.creative ? d : { ...d, grade: { ...d.grade, creative } }
  })
}

function setFlare(get: () => AppState, update: (f: FlareDoc) => FlareDoc): void {
  get().setDoc((d) => {
    const flare = update(d.post.flare)
    return flare === d.post.flare ? d : { ...d, post: { ...d.post, flare } }
  })
}

const withElements = (f: FlareDoc, update: (elements: FlareElement[]) => FlareElement[]): FlareDoc => {
  const elements = update(f.elements)
  return elements === f.elements ? f : { ...f, elements }
}

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
  started: false,

  setDoc: (update) => {
    const { doc, gestureBase, past } = get()
    const next = typeof update === 'function' ? update(doc) : { ...doc, ...update }
    if (next === doc) return
    if (gestureBase) set({ doc: next })
    else set({ doc: next, past: pushPast(past, doc), future: [] })
  },

  loadDoc: (doc, step) => {
    const { viewport, viewInsets } = get()
    set({ doc, past: [], future: [], gestureBase: null, step, view: doc.background ? fitView(doc.background, viewport, undefined, viewInsets) : get().view })
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
        return { ...rescaleDoc(d, asset.width / d.background.width, asset.height / d.background.height), background: asset }
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

  updateAdjust: (level, update) => {
    get().setDoc((d) => ({ ...d, grade: { ...d.grade, levels: { ...d.grade.levels, [level]: { ...d.grade.levels[level], ...update } } } }))
  },

  resetAdjust: (level) => {
    get().setDoc((d) => ({ ...d, grade: { ...d.grade, levels: { ...d.grade.levels, [level]: DEFAULT_ADJUST } } }))
  },

  updateWheel: (key, update) => {
    setCreative(get, (c) => ({ ...c, wheels: { ...c.wheels, [key]: { ...c.wheels[key], ...update } } }))
  },

  updateSplit: (update) => {
    setCreative(get, (c) => ({ ...c, split: { ...c.split, ...update } }))
  },

  updateCreative: (update) => {
    setCreative(get, (c) => ({ ...c, ...update }))
  },

  addBlendLayer: () => {
    if (get().doc.grade.creative.layers.length >= MAX_BLEND_LAYERS) return null
    const layer = newBlendLayer()
    setCreative(get, (c) => ({ ...c, layers: [...c.layers, layer] }))
    return layer.id
  },

  updateBlendLayer: (id, update) => {
    setCreative(get, (c) => {
      const layer = c.layers.find((l) => l.id === id)
      // 下拉框在撤销后被程序赋值时也会触发 change，值没有变化时不产生撤销记录
      if (!layer || (Object.keys(update) as (keyof typeof update)[]).every((k) => layer[k] === update[k])) return c
      return { ...c, layers: c.layers.map((l) => (l === layer ? { ...l, ...update } : l)) }
    })
  },

  removeBlendLayer: (id) => {
    setCreative(get, (c) => ({ ...c, layers: c.layers.filter((l) => l.id !== id) }))
  },

  moveBlendLayer: (id, delta) => {
    setCreative(get, (c) => {
      const i = c.layers.findIndex((l) => l.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= c.layers.length) return c
      const layers = [...c.layers]
      ;[layers[i], layers[j]] = [layers[j], layers[i]]
      return { ...c, layers }
    })
  },

  resetCreative: () => {
    setCreative(get, () => DEFAULT_CREATIVE)
  },

  updatePost: (section, update) => {
    get().setDoc((d) => {
      const current = d.post[section]
      // 下拉框、开关在撤销后被程序赋值时也会触发 change，值没有变化时不产生撤销记录
      if ((Object.keys(update) as (keyof typeof update)[]).every((k) => current[k] === update[k])) return d
      return { ...d, post: { ...d.post, [section]: { ...current, ...update } } }
    })
  },

  addFlareElement: (type) => {
    if (get().doc.post.flare.elements.length >= MAX_FLARE_ELEMENTS) return null
    const element = newFlareElement({ type })
    setFlare(get, (f) => withElements(f, (es) => [...es, element]))
    return element.id
  },

  updateFlareElement: (id, update) => {
    setFlare(get, (f) =>
      withElements(f, (es) => {
        const element = es.find((e) => e.id === id)
        // 下拉框在撤销后被程序赋值时也会触发 change，值没有变化时不产生撤销记录
        if (!element || (Object.keys(update) as (keyof typeof update)[]).every((k) => element[k] === update[k])) return es
        return es.map((e) => (e === element ? { ...e, ...update } : e))
      }),
    )
  },

  duplicateFlareElement: (id) => {
    const es = get().doc.post.flare.elements
    const i = es.findIndex((e) => e.id === id)
    if (i < 0 || es.length >= MAX_FLARE_ELEMENTS) return null
    const copy = { ...es[i], id: newFlareId() }
    setFlare(get, (f) => withElements(f, (list) => [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]))
    return copy.id
  },

  removeFlareElement: (id) => {
    setFlare(get, (f) => withElements(f, (es) => (es.some((e) => e.id === id) ? es.filter((e) => e.id !== id) : es)))
  },

  moveFlareElement: (id, delta) => {
    setFlare(get, (f) =>
      withElements(f, (es) => {
        const i = es.findIndex((e) => e.id === id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= es.length) return es
        const list = [...es]
        ;[list[i], list[j]] = [list[j], list[i]]
        return list
      }),
    )
  },

  setFlareElements: (elements) => {
    setFlare(get, (f) => (f.enabled && sameFlareElements(f.elements, elements) ? f : { ...f, enabled: true, elements: elements.slice(0, MAX_FLARE_ELEMENTS).map((e) => ({ ...e, id: newFlareId() })) }))
  },

  setToneMapping: (toneMapping) => {
    get().setDoc((d) => (d.post.toneMapping === toneMapping ? d : { ...d, post: { ...d.post, toneMapping } }))
  },

  resetPost: () => {
    get().setDoc((d) => ({ ...d, post: DEFAULT_POST }))
  },

  applyPreset: (preset) => {
    get().setDoc((d) =>
      matchesPreset(d.grade, d.post, preset)
        ? d
        : {
            ...d,
            grade: preset.grade,
            post: { ...preset.post, rays: { ...preset.post.rays, light: d.post.rays.light }, flare: { ...preset.post.flare, light: d.post.flare.light } },
          },
    )
  },

  setView: (view) => set({ view }),
  setViewport: (viewport) => set({ viewport }),
  setViewInsets: (viewInsets) => set({ viewInsets }),
  fitToView: () => {
    const { doc, viewport, viewInsets } = get()
    if (doc.background) set({ view: fitView(doc.background, viewport, undefined, viewInsets) })
  },
  setStep: (step) => set({ step }),
  start: () => set({ started: true }),
}))
