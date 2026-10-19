import { create } from 'zustand'
import type { Engine } from '@/engine/Engine'

/** 引擎实例和初始化状态。引擎随视口画布创建，界面其它部分通过这里访问。 */
interface EngineState {
  engine: Engine | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
  setEngine: (engine: Engine | null) => void
  setError: (error: string) => void
}

export const useEngine = create<EngineState>()((set) => ({
  engine: null,
  status: 'loading',
  error: null,
  setEngine: (engine) => set({ engine, status: engine ? 'ready' : 'loading', error: null }),
  setError: (error) => set({ engine: null, status: 'error', error }),
}))

/** 解码时使用的尺寸上限：引擎就绪前按 WebGPU 的保底值 8192 处理。 */
export function textureLimit(): number {
  return useEngine.getState().engine?.maxTextureSize ?? 8192
}

/** 等引擎初始化结束（成功或失败）：解码图片前需要知道纹理尺寸上限 */
export function whenEngineReady(): Promise<void> {
  if (useEngine.getState().status !== 'loading') return Promise.resolve()
  return new Promise((resolve) => {
    const off = useEngine.subscribe((s) => {
      if (s.status === 'loading') return
      off()
      resolve()
    })
  })
}
