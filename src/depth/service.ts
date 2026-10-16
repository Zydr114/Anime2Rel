/**
 * 主线程侧的深度估计调度：懒加载 Worker、按设置加载模型、串行执行估计任务，
 * 并在文档的背景或立绘变化时自动估计。
 */
import * as Comlink from 'comlink'
import type { DepthKind } from './pipeline'
import type { DepthWorkerApi, LoadProgress } from './protocol'
import { getAsset } from '@/state/assets'
import { clearDepthResults, getDepthResult, setDepthResult, useDepth } from '@/state/depth'
import { useApp } from '@/state/store'

let worker: Comlink.Remote<DepthWorkerApi> | null = null
let queue: Promise<unknown> = Promise.resolve()
/** 设置变化或重新加载时递增，旧代次的任务直接丢弃 */
let generation = 0
const pending = new Set<string>()

function remote(): Comlink.Remote<DepthWorkerApi> {
  worker ??= Comlink.wrap<DepthWorkerApi>(new Worker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module', name: 'depth' }))
  return worker
}

function siteBase(): string {
  return new URL('./', document.baseURI).href
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task, task).catch((e) => console.error('[depth]', e))
}

/** 按当前设置加载模型；已就绪时直接返回。 */
async function ensureModel(gen: number): Promise<boolean> {
  const depth = useDepth.getState()
  if (depth.model.state === 'ready') return true
  if (depth.model.state === 'error') return false
  depth.setModel({ state: 'loading', phase: 'runtime', loaded: 0, total: 0 })
  const onProgress = Comlink.proxy((p: LoadProgress) => {
    if (gen === generation) useDepth.getState().setModel({ state: 'loading', ...p })
  })
  try {
    const result = await remote().load({ siteBase: siteBase(), ...depth.settings }, onProgress)
    if (gen !== generation) return false
    useDepth.getState().setModel(result.ok ? { state: 'ready', info: result.info } : { state: 'error', message: result.message, failures: result.failures })
    return result.ok
  } catch (e) {
    if (gen === generation) useDepth.getState().setModel({ state: 'error', message: e instanceof Error ? e.message : String(e), failures: [] })
    return false
  }
}

/** 为某个资源请求深度估计；已有结果或已在队列中时忽略。 */
export function requestDepth(assetId: string, kind: DepthKind): void {
  if (getDepthResult(assetId) || pending.has(assetId)) return
  pending.add(assetId)
  const gen = generation
  useDepth.getState().setJob(assetId, { state: 'queued' })
  enqueue(async () => {
    try {
      if (gen !== generation) return
      if (!(await ensureModel(gen))) {
        if (gen === generation) useDepth.getState().setJob(assetId, { state: 'error', message: '模型未能加载' })
        return
      }
      const asset = getAsset(assetId)
      if (!asset || gen !== generation) return
      useDepth.getState().setJob(assetId, { state: 'running' })
      const bitmap = await createImageBitmap(asset.bitmap)
      const result = await remote().estimate(Comlink.transfer(bitmap, [bitmap]), kind)
      if (gen !== generation) return
      setDepthResult(assetId, result)
      useDepth.getState().setJob(assetId, { state: 'done', timings: result.timings, device: result.device, precision: result.precision })
    } catch (e) {
      if (gen === generation) useDepth.getState().setJob(assetId, { state: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (gen === generation) pending.delete(assetId)
    }
  })
}

/** 为当前文档中的背景和立绘请求深度估计。 */
function requestForDocument(): void {
  const { background, character } = useApp.getState().doc
  if (background) requestDepth(background.id, 'background')
  if (character) requestDepth(character.id, 'character')
}

/**
 * 丢弃模型和所有结果，按当前设置重新加载并估计。
 * 用于修改模型设置、出错后重试和“重新估计”。
 */
export function reloadDepth(): void {
  generation++
  pending.clear()
  clearDepthResults()
  const depth = useDepth.getState()
  depth.resetJobs()
  depth.setModel({ state: 'idle' })
  const gen = generation
  enqueue(async () => {
    if (gen === generation) await remote().unload()
  })
  requestForDocument()
}

/** 清除浏览器中缓存的模型和运行时，然后重新加载。 */
export async function clearModelCache(): Promise<boolean> {
  const ok = await remote().clearCache()
  reloadDepth()
  return ok
}

export function modelCacheSize(): Promise<number> {
  return remote().cacheSize()
}

/** 编辑器打开期间自动估计；返回取消订阅函数。 */
export function startAutoDepth(): () => void {
  requestForDocument()
  return useApp.subscribe((s, prev) => {
    if (s.doc.background?.id !== prev.doc.background?.id || s.doc.character?.id !== prev.doc.character?.id) requestForDocument()
  })
}
