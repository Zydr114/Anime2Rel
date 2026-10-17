/**
 * 主线程侧的光源分析调度：背景的深度结果就绪后自动分析，
 * 分析完成后，如果当前光源列表不是来自这张背景，就用候选替换。
 */
import * as Comlink from 'comlink'
import { fitWithin } from '@/algo/geometry'
import type { DepthResult } from '@/depth/protocol'
import { lightsFromCandidates } from '@/lighting/model'
import { getAsset } from '@/state/assets'
import { getDepthResult, useDepth } from '@/state/depth'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import type { AnalysisWorkerApi } from './protocol'
import { ANALYSIS_MAX_EDGE } from './scene'

let worker: Comlink.Remote<AnalysisWorkerApi> | null = null
/** 每张背景最近一次分析所用的深度结果，以及该次分析的序号 */
const inputs = new Map<string, { depth: DepthResult; run: number }>()
let runs = 0

function remote(): Comlink.Remote<AnalysisWorkerApi> {
  worker ??= Comlink.wrap<AnalysisWorkerApi>(new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module', name: 'analysis' }))
  return worker
}

/**
 * 把分析候选写入文档。force 为 true 表示用户主动重新分析，产生撤销记录；
 * 否则只在光源列表不是来自这张背景时原地替换。
 */
function applyCandidates(assetId: string, force: boolean): void {
  const { doc, replaceLights } = useApp.getState()
  if (doc.background?.id !== assetId) return
  const status = useLighting.getState().analyses[assetId]
  if (status?.state !== 'done') return
  if (!force && doc.lighting.analyzedFor === assetId) return
  const lights = lightsFromCandidates(status.result.candidates, doc.background)
  replaceLights(lights, assetId, force)
  useLighting.getState().select(lights[0]?.id ?? null)
}

async function run(assetId: string, depth: DepthResult, apply: boolean): Promise<void> {
  const id = ++runs
  inputs.set(assetId, { depth, run: id })
  const lighting = useLighting.getState()
  lighting.setAnalysis(assetId, { state: 'running' })
  try {
    const asset = getAsset(assetId)
    if (!asset) return
    const size = fitWithin(asset, ANALYSIS_MAX_EDGE)
    const bitmap = await createImageBitmap(asset.bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' })
    const result = await remote().analyze(
      Comlink.transfer({ bitmap, depth: depth.depth, sky: depth.sky, depthSize: depth.guideSize, fovDeg: useApp.getState().doc.lighting.fovDeg }, [bitmap]),
    )
    if (inputs.get(assetId)?.run !== id) return
    useLighting.getState().setAnalysis(assetId, { state: 'done', result })
    applyCandidates(assetId, apply)
  } catch (e) {
    if (inputs.get(assetId)?.run === id) useLighting.getState().setAnalysis(assetId, { state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** 当前背景有新的深度结果时分析；结果已有时检查是否需要写入候选（如撤销/重做切回了背景）。 */
function check(): void {
  const bg = useApp.getState().doc.background
  if (!bg) return
  const depth = getDepthResult(bg.id)
  if (!depth) return
  if (inputs.get(bg.id)?.depth === depth) applyCandidates(bg.id, false)
  else void run(bg.id, depth, false)
}

/** 用当前设置（如视场角）重新分析当前背景，并用新候选替换光源（可撤销）。 */
export function reanalyze(): void {
  const bg = useApp.getState().doc.background
  const depth = bg && getDepthResult(bg.id)
  if (bg && depth) void run(bg.id, depth, true)
}

/** 编辑器打开期间自动分析；返回取消订阅函数。 */
export function startAutoAnalysis(): () => void {
  check()
  const offDepth = useDepth.subscribe((s, prev) => {
    if (s.resultsVersion !== prev.resultsVersion) check()
  })
  const offApp = useApp.subscribe((s, prev) => {
    if (s.doc.background?.id !== prev.doc.background?.id || s.doc.lighting.analyzedFor !== prev.doc.lighting.analyzedFor) check()
  })
  return () => {
    offDepth()
    offApp()
  }
}
