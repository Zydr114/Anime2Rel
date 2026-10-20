import { create } from 'zustand'
import type { BackgroundInfo, CharacterInfo, FusionStats, MatteMap, NormalMap, WarpedGeometry } from '@/fusion/protocol'
import { isIdentityWarp } from '@/fusion/warp'
import type { DocState } from './store'

/** 画布上编辑立绘的工具：摆放（移动、缩放、旋转），或两种变形 */
export type CharacterTool = 'transform' | 'perspective' | 'mesh'
export const CHARACTER_TOOLS: readonly CharacterTool[] = ['transform', 'perspective', 'mesh']

/** 融合 Worker 的计算结果与立绘步骤的界面状态。不参与撤销。 */
interface FusionState {
  background: { id: string; info: BackgroundInfo } | null
  /** 原立绘的信息 */
  character: { id: string; info: CharacterInfo } | null
  /** 最近一次按变形重新统计的几何；变形还在计算时沿用上一次的结果 */
  warped: { id: string; geometry: WarpedGeometry } | null
  normals: { id: string; map: NormalMap } | null
  /** 去除残留底色用的前景色与背景色 */
  matte: { id: string; map: MatteMap } | null
  stats: FusionStats | null
  /** 前后对比：显示直接贴上去的立绘（不做融合、景深和遮挡） */
  compare: boolean
  /** 在画布上显示立绘的融合法线 */
  showNormals: boolean
  /** 在画布上用红色显示深度遮挡的遮罩 */
  showMask: boolean
  tool: CharacterTool
  /** 拖动立绘时按相机透视缩放（M8.5） */
  perspectiveMove: boolean
  /** 立绘步骤中显示参考形状（种类与相机步骤共用，原点在立绘的接地点） */
  showGuide: boolean

  setBackground: (v: FusionState['background']) => void
  setCharacter: (v: FusionState['character']) => void
  setWarped: (v: FusionState['warped']) => void
  setNormals: (v: FusionState['normals']) => void
  setMatte: (v: FusionState['matte']) => void
  setStats: (v: FusionStats | null) => void
  setCompare: (on: boolean) => void
  setShowNormals: (on: boolean) => void
  setShowMask: (on: boolean) => void
  setTool: (tool: CharacterTool) => void
  setPerspectiveMove: (on: boolean) => void
  setShowGuide: (on: boolean) => void
}

export const useFusion = create<FusionState>()((set) => ({
  background: null,
  character: null,
  warped: null,
  normals: null,
  matte: null,
  stats: null,
  compare: false,
  showNormals: false,
  showMask: false,
  tool: 'transform',
  perspectiveMove: true,
  showGuide: false,

  setBackground: (background) => set({ background }),
  setCharacter: (character) => set({ character }),
  setWarped: (warped) => set({ warped }),
  setNormals: (normals) => set({ normals }),
  setMatte: (matte) => set({ matte }),
  setStats: (stats) => set({ stats }),
  setCompare: (compare) => set({ compare }),
  setShowNormals: (showNormals) => set({ showNormals }),
  setShowMask: (showMask) => set({ showMask }),
  setTool: (tool) => set({ tool }),
  setPerspectiveMove: (perspectiveMove) => set({ perspectiveMove }),
  setShowGuide: (showGuide) => set({ showGuide }),
}))

const merged = new WeakMap<WarpedGeometry, { info: CharacterInfo; result: CharacterInfo }>()

/**
 * 当前立绘的信息：立绘变形后，包围盒和每行的边界换成变形后的统计结果。
 * 融合 Worker 尚未处理该立绘时为 undefined。同样的输入返回同一个对象，可以直接用作选择器。
 */
export function effectiveInfo(s: Pick<FusionState, 'character' | 'warped'>, doc: Pick<DocState, 'character' | 'charWarp'>): CharacterInfo | undefined {
  const c = s.character
  if (!c || c.id !== doc.character?.id) return undefined
  const w = s.warped
  if (isIdentityWarp(doc.charWarp) || !w || w.id !== c.id) return c.info
  let m = merged.get(w.geometry)
  if (!m || m.info !== c.info) merged.set(w.geometry, (m = { info: c.info, result: { ...c.info, ...w.geometry } }))
  return m.result
}

/** 当前立绘的信息，见 effectiveInfo */
export function characterInfo(doc: Pick<DocState, 'character' | 'charWarp'>): CharacterInfo | undefined {
  return effectiveInfo(useFusion.getState(), doc)
}

/** 组件中读取当前立绘的信息，见 effectiveInfo */
export function useCharacterInfo(doc: Pick<DocState, 'character' | 'charWarp'>): CharacterInfo | undefined {
  return useFusion((s) => effectiveInfo(s, doc))
}
