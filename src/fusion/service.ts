/**
 * 主线程侧的立绘融合调度（docs/Plan.md §3.3）：把背景和立绘送入融合 Worker，
 * 生成立绘法线，并在立绘移动、缩放或参数变化时重新计算立绘周围的背景统计；立绘变形后重新统计不透明区域的几何。
 */
import * as Comlink from 'comlink'
import { depthScaleFor } from '@/camera/depthScale'
import { guideSize } from '@/depth/pipeline'
import type { DepthResult } from '@/depth/protocol'
import { getAsset } from '@/state/assets'
import { getDepthResult, useDepth } from '@/state/depth'
import { characterInfo, useFusion } from '@/state/fusion'
import { getAnalysis } from '@/state/lighting'
import { useApp, type DocState } from '@/state/store'
import { fusionParams, whiteAdaptation, type FusionParams } from './params'
import { characterBox, characterDepth } from './placement'
import type { FusionWorkerApi, MatteMap, NormalMap } from './protocol'
import { isIdentityWarp } from './warp'
import { shadowParams, type ShadowParams } from './shadow'

/** 法线参数变化后的防抖时间 */
const NORMALS_DEBOUNCE = 150

let worker: Comlink.Remote<FusionWorkerApi> | null = null

function remote(): Comlink.Remote<FusionWorkerApi> {
  worker ??= Comlink.wrap<FusionWorkerApi>(new Worker(new URL('../workers/fusion.worker.ts', import.meta.url), { type: 'module', name: 'fusion' }))
  return worker
}

function report(e: unknown): void {
  console.error('[fusion]', e)
}

/** 已送入 Worker 的资源与深度结果；深度结果变化（就绪或重新估计）时重新送入 */
interface Sent {
  id: string
  depth: DepthResult | undefined
}
let sentBackground: Sent | null = null
let sentCharacter: Sent | null = null

async function syncBackground(): Promise<void> {
  const bg = useApp.getState().doc.background
  const depth = getDepthResult(bg?.id)
  if (sentBackground?.id === bg?.id && sentBackground?.depth === depth) return
  if (sentBackground?.id !== bg?.id) useFusion.getState().setBackground(null)
  const asset = bg && getAsset(bg.id)
  if (!asset) {
    sentBackground = null
    return
  }
  const sent = (sentBackground = { id: asset.id, depth })
  const bitmap = await createImageBitmap(asset.bitmap)
  const info = await remote().setBackground(
    Comlink.transfer({ id: asset.id, bitmap, depth: depth?.depth ?? null, sky: depth?.sky ?? null, depthSize: depth?.guideSize ?? null }, [bitmap]),
  )
  if (sentBackground !== sent) return
  useFusion.getState().setBackground({ id: asset.id, info })
  requestStats()
}

async function syncCharacter(): Promise<void> {
  const ch = useApp.getState().doc.character
  const depth = getDepthResult(ch?.id)
  if (sentCharacter?.id === ch?.id && sentCharacter?.depth === depth) return
  if (sentCharacter?.id !== ch?.id) {
    const fusion = useFusion.getState()
    fusion.setCharacter(null)
    fusion.setWarped(null)
    fusion.setNormals(null)
    fusion.setMatte(null)
  }
  const asset = ch && getAsset(ch.id)
  if (!asset) {
    sentCharacter = null
    return
  }
  const sent = (sentCharacter = { id: asset.id, depth })
  // 与立绘深度结果同一分辨率，深度法线可以逐像素混合
  const size = depth?.guideSize ?? guideSize(asset.bitmap.width, asset.bitmap.height)
  const bitmap = await createImageBitmap(asset.bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high', premultiplyAlpha: 'none' })
  const info = await remote().setCharacter(Comlink.transfer({ id: asset.id, bitmap, depthNormal: depth?.normal ?? null, depth: depth?.depth ?? null }, [bitmap]))
  if (sentCharacter !== sent) return
  useFusion.getState().setCharacter({ id: asset.id, info })
  requestWarp()
  void runNormals()
  if (useFusion.getState().matte?.id !== asset.id) void runMatte(asset.id)
  requestStats()
}

let normalsRun = 0
let normalsTimer: ReturnType<typeof setTimeout> | undefined

async function runNormals(): Promise<void> {
  clearTimeout(normalsTimer)
  const character = useFusion.getState().character
  if (!character || useApp.getState().doc.character?.id !== character.id) return
  const run = ++normalsRun
  const { inflateRadius, ...weights } = useApp.getState().doc.fusion.normals
  try {
    const map = await remote().normals({ id: character.id, weights, inflateRadius })
    if (run === normalsRun && useFusion.getState().character?.id === character.id) useFusion.getState().setNormals({ id: character.id, map })
  } catch (e) {
    report(e)
  }
}

async function runMatte(id: string): Promise<void> {
  try {
    const map = await remote().matte(id)
    if (useFusion.getState().character?.id === id) useFusion.getState().setMatte({ id, map })
  } catch (e) {
    report(e)
  }
}

/** 计算期间又有变化时，完成后用最新状态再算一次 */
function coalesce(run: () => Promise<void>): () => void {
  let busy = false
  let dirty = false
  return () => {
    dirty = true
    if (busy) return
    busy = true
    void (async () => {
      while (dirty) {
        dirty = false
        await run().catch(report)
      }
      busy = false
    })()
  }
}

/** 立绘变形后的几何（包围盒、每行的边界），与移动立绘时的统计一样随拖动更新 */
const requestWarp = coalesce(async () => {
  const { doc } = useApp.getState()
  const character = useFusion.getState().character
  if (!character || doc.character?.id !== character.id || isIdentityWarp(doc.charWarp)) return
  const geometry = await remote().warpGeometry({ id: character.id, warp: doc.charWarp })
  if (useFusion.getState().character?.id !== character.id) return
  useFusion.getState().setWarped({ id: character.id, geometry })
  requestStats()
})


/** 立绘周围的背景统计 */
const requestStats = coalesce(runStats)

async function runStats(): Promise<void> {
  const { doc } = useApp.getState()
  const { background, character } = useFusion.getState()
  const bg = doc.background
  if (!bg || !doc.character || background?.id !== bg.id || character?.id !== doc.character.id) {
    useFusion.getState().setStats(null)
    return
  }
  const bbox = characterInfo(doc)?.bbox
  const box = characterBox(doc, bbox)
  const xs = box.map((p) => p.x / bg.width)
  const ys = box.map((p) => p.y / bg.height)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const stats = await remote().stats({
    backgroundId: bg.id,
    characterId: character.id,
    cat: whiteAdaptation(doc.fusion.colorMatch, background.info.whitePoint),
    region: { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 },
    depth: characterDepth(doc, getDepthResult(bg.id), bbox),
  })
  const now = useFusion.getState()
  if (now.background?.id === bg.id && now.character?.id === character.id) now.setStats(stats)
}

/** 编辑器打开期间自动更新融合数据；返回取消订阅函数。 */
export function startAutoFusion(): () => void {
  const sync = () => {
    syncBackground().catch(report)
    syncCharacter().catch(report)
  }
  sync()
  const offDepth = useDepth.subscribe((s, prev) => {
    if (s.resultsVersion !== prev.resultsVersion) {
      sync()
      requestStats()
    }
  })
  const offApp = useApp.subscribe((s, prev) => {
    const doc = s.doc
    const old = prev.doc
    if (doc.background?.id !== old.background?.id || doc.character?.id !== old.character?.id) sync()
    if (doc.charWarp !== old.charWarp) requestWarp()
    if (doc.fusion.normals !== old.fusion.normals) {
      clearTimeout(normalsTimer)
      normalsTimer = setTimeout(() => void runNormals(), NORMALS_DEBOUNCE)
    }
    if (
      doc.charTransform !== old.charTransform ||
      doc.charWarp !== old.charWarp ||
      doc.fusion.depth !== old.fusion.depth ||
      doc.fusion.colorMatch.whiteBalance !== old.fusion.colorMatch.whiteBalance ||
      doc.background?.id !== old.background?.id ||
      doc.character?.id !== old.character?.id
    )
      requestStats()
  })
  return () => {
    offDepth()
    offApp()
    clearTimeout(normalsTimer)
  }
}

/** 按当前文档和融合数据换算着色器参数；背景或立绘尚未送入 Worker 时返回 null。 */
export function currentFusionParams(doc: DocState): FusionParams | null {
  const bg = doc.background
  const fusion = useFusion.getState()
  if (!bg || !doc.character || fusion.background?.id !== bg.id || fusion.character?.id !== doc.character.id) return null
  const bbox = characterInfo(doc)?.bbox
  const box = characterBox(doc, bbox)
  return fusionParams({
    fusion: doc.fusion,
    lighting: doc.lighting,
    fovDeg: doc.camera.fovDeg,
    size: bg,
    background: fusion.background.info,
    stats: fusion.stats,
    ambient: getAnalysis(bg.id)?.ambient,
    center: { x: box.reduce((s, p) => s + p.x, 0) / 4, y: box.reduce((s, p) => s + p.y, 0) / 4 },
    depth: characterDepth(doc, getDepthResult(bg.id), bbox),
    depthScale: depthScaleFor(doc.camera, bg, getDepthResult(bg.id)),
  })
}

/** 当前的站立阴影参数；立绘信息未就绪时不画阴影 */
export function currentShadowParams(doc: DocState): ShadowParams | null {
  const bg = doc.background
  const info = characterInfo(doc)
  if (!bg || !info) return null
  return shadowParams({ doc, background: getDepthResult(bg.id), info, ambient: getAnalysis(bg.id)?.ambient })
}

/** 当前立绘去除残留底色用的数据 */
export function currentMatte(doc: DocState): MatteMap | null {
  const matte = useFusion.getState().matte
  return matte && matte.id === doc.character?.id ? matte.map : null
}

/** 当前立绘的融合法线 */
export function currentNormals(doc: DocState): NormalMap | null {
  const normals = useFusion.getState().normals
  return normals && normals.id === doc.character?.id ? normals.map : null
}
