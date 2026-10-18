import { create } from 'zustand'
import { MODEL_SOURCES, PRECISIONS, type Attempt, type Device, type ModelSource, type Precision } from '@/depth/models'
import type { AttemptFailure, DepthResult, EstimateTimings, LoadPhase, ModelInfo } from '@/depth/protocol'

export type DebugView = 'composite' | 'depth' | 'normal' | 'sky' | 'focus'
export const DEBUG_VIEWS: readonly DebugView[] = ['composite', 'depth', 'normal', 'sky', 'focus']

export interface DepthSettings {
  source: ModelSource
  device: Device | 'auto'
  precision: Precision | 'auto'
}

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'loading'; phase: LoadPhase; attempt?: Attempt; loaded: number; total: number }
  | { state: 'ready'; info: ModelInfo }
  | { state: 'error'; message: string; failures: AttemptFailure[] }

export type JobStatus =
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'done'; timings: EstimateTimings; device: Device; precision: Precision }
  | { state: 'error'; message: string }

const SETTINGS_KEY = 'a2r.depth.settings'
const DEFAULT_SETTINGS: DepthSettings = { source: 'self', device: 'auto', precision: 'auto' }

function loadSettings(): DepthSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const saved = raw ? (JSON.parse(raw) as Partial<DepthSettings>) : {}
    // 旧版本或手工修改的值不在可选范围内时回到默认值
    return {
      source: MODEL_SOURCES.includes(saved.source as ModelSource) ? saved.source! : DEFAULT_SETTINGS.source,
      device: (['auto', 'webgpu', 'wasm'] as const).includes(saved.device as DepthSettings['device']) ? saved.device! : DEFAULT_SETTINGS.device,
      precision: saved.precision === 'auto' || PRECISIONS.includes(saved.precision as Precision) ? saved.precision! : DEFAULT_SETTINGS.precision,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** 深度估计的设置、模型和任务状态，以及调试视图。不参与撤销。 */
interface DepthState {
  settings: DepthSettings
  model: ModelStatus
  /** 按资源 id 记录的任务状态 */
  jobs: Record<string, JobStatus>
  /** 结果登记表的版本号，结果变化时递增，供渲染器订阅 */
  resultsVersion: number

  view: DebugView
  /** 调试视图叠加在合成结果上的不透明度 */
  overlay: number
  /** 是否使用边缘对齐后的深度（关闭时显示模型输出的直接放大，便于对比） */
  edgeAlign: boolean

  setSettings: (update: Partial<DepthSettings>) => void
  setModel: (model: ModelStatus) => void
  setJob: (assetId: string, job: JobStatus) => void
  resetJobs: () => void
  bumpResults: () => void
  setView: (view: DebugView) => void
  setOverlay: (overlay: number) => void
  setEdgeAlign: (on: boolean) => void
}

export const useDepth = create<DepthState>()((set) => ({
  settings: loadSettings(),
  model: { state: 'idle' },
  jobs: {},
  resultsVersion: 0,
  view: 'composite',
  overlay: 1,
  edgeAlign: true,

  setSettings: (update) =>
    set((s) => {
      const settings = { ...s.settings, ...update }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        // 隐私模式等情况下无法持久化，忽略
      }
      return { settings }
    }),
  setModel: (model) => set({ model }),
  setJob: (assetId, job) => set((s) => ({ jobs: { ...s.jobs, [assetId]: job } })),
  resetJobs: () => set({ jobs: {} }),
  bumpResults: () => set((s) => ({ resultsVersion: s.resultsVersion + 1 })),
  setView: (view) => set({ view }),
  setOverlay: (overlay) => set({ overlay }),
  setEdgeAlign: (edgeAlign) => set({ edgeAlign }),
}))

// 结果包含大块类型化数组，放在 store 之外，按资源 id 保存。
const results = new Map<string, DepthResult>()

export function getDepthResult(assetId: string | null | undefined): DepthResult | undefined {
  return assetId ? results.get(assetId) : undefined
}

export function setDepthResult(assetId: string, result: DepthResult): void {
  results.set(assetId, result)
  useDepth.getState().bumpResults()
}

export function clearDepthResults(): void {
  results.clear()
  useDepth.getState().bumpResults()
}
