import { create } from 'zustand'
import type { BackgroundInfo, CharacterInfo, FusionStats, NormalMap } from '@/fusion/protocol'

/** 融合 Worker 的计算结果与立绘步骤的界面状态。不参与撤销。 */
interface FusionState {
  background: { id: string; info: BackgroundInfo } | null
  character: { id: string; info: CharacterInfo } | null
  normals: { id: string; map: NormalMap } | null
  stats: FusionStats | null
  /** 前后对比：显示直接贴上去的立绘（不做融合、景深和遮挡） */
  compare: boolean
  /** 在画布上显示立绘的融合法线 */
  showNormals: boolean
  /** 在画布上用红色显示深度遮挡的遮罩 */
  showMask: boolean

  setBackground: (v: FusionState['background']) => void
  setCharacter: (v: FusionState['character']) => void
  setNormals: (v: FusionState['normals']) => void
  setStats: (v: FusionStats | null) => void
  setCompare: (on: boolean) => void
  setShowNormals: (on: boolean) => void
  setShowMask: (on: boolean) => void
}

export const useFusion = create<FusionState>()((set) => ({
  background: null,
  character: null,
  normals: null,
  stats: null,
  compare: false,
  showNormals: false,
  showMask: false,

  setBackground: (background) => set({ background }),
  setCharacter: (character) => set({ character }),
  setNormals: (normals) => set({ normals }),
  setStats: (stats) => set({ stats }),
  setCompare: (compare) => set({ compare }),
  setShowNormals: (showNormals) => set({ showNormals }),
  setShowMask: (showMask) => set({ showMask }),
}))

/** 当前立绘不透明区域的包围盒；融合 Worker 尚未处理该立绘时为 undefined。 */
export function characterBBox(id: string | undefined): CharacterInfo['bbox'] | undefined {
  const c = useFusion.getState().character
  return c && c.id === id ? c.info.bbox : undefined
}
