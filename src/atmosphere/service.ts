/**
 * 当前文档的雾与尘埃参数（docs/Plan.md §3.7 M8.8c）。各部分按输入缓存，输入不变时返回同一个对象，
 * 引擎据此判断是否需要重算背景预处理与景深（拖动立绘时只有接地点处的透过率变化）。
 */
import { srgbToLinear } from '@/algo/color'
import type { Vec3 } from '@/algo/sh'
import { depthScaleFor } from '@/camera/depthScale'
import type { DepthResult } from '@/depth/protocol'
import { characterDepth, characterGround } from '@/fusion/placement'
import { assetPixels } from '@/lighting/sampling'
import { getDepthResult } from '@/state/depth'
import { characterInfo } from '@/state/fusion'
import type { DocState } from '@/state/store'
import { dustActive, fogActive } from './model'
import { atmosphereView, dustParams, fogParams, fogTransmittance, type AtmosphereView, type DustParams, type FogParams } from './params'

export interface AtmosphereParams {
  view: AtmosphereView
  /** 雾关闭时为 null */
  fog: FogParams | null
  /** 接地点处雾的透过率：站立阴影按它减淡 */
  contact: number
  /** 尘埃关闭时为 null */
  dust: DustParams | null
}

/** 天空至少占采样点的这个比例时，雾色取天空的平均颜色；否则取最远这个比例的景物 */
const SKY_SHARE = 0.02
const FAR_SHARE = 0.05
/** 采样点数的目标 */
const SAMPLES = 20000
const NEUTRAL: Vec3 = [0.7, 0.7, 0.7]

/** 自动的雾色（线性）：天空的平均颜色；天空太少时取最远 5% 景物的平均颜色。背景图片未就绪时为 null */
export function autoFogColor(backgroundId: string, depth: DepthResult): Vec3 | null {
  const img = assetPixels(backgroundId)
  if (!img) return null
  const { width: gw, height: gh } = depth.guideSize
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / SAMPLES)))
  const samples: { color: Vec3; depth: number; sky: number }[] = []
  for (let y = Math.floor(step / 2); y < img.height; y += step)
    for (let x = Math.floor(step / 2); x < img.width; x += step) {
      const i = (y * img.width + x) * 4
      const g = Math.min(gh - 1, Math.floor(((y + 0.5) / img.height) * gh)) * gw + Math.min(gw - 1, Math.floor(((x + 0.5) / img.width) * gw))
      const color = [0, 1, 2].map((c) => srgbToLinear(img.data[i + c] / 255)) as Vec3
      samples.push({ color, depth: depth.depth[g], sky: depth.sky?.[g] ?? 0 })
    }
  const mean = (list: typeof samples, weight: (s: (typeof samples)[number]) => number): Vec3 | null => {
    const sum = [0, 0, 0]
    let total = 0
    for (const s of list) {
      const w = weight(s)
      for (let c = 0; c < 3; c++) sum[c] += s.color[c] * w
      total += w
    }
    return total > 0 ? (sum.map((v) => v / total) as Vec3) : null
  }
  const sky = samples.filter((s) => s.sky > 0.5)
  if (sky.length >= SKY_SHARE * samples.length) return mean(sky, (s) => s.sky) ?? NEUTRAL
  const far = [...samples].sort((a, b) => a.depth - b.depth).slice(0, Math.max(1, Math.round(FAR_SHARE * samples.length)))
  return mean(far, () => 1) ?? NEUTRAL
}

const colorCache = new WeakMap<DepthResult, { id: string; color: Vec3 }>()
let viewCache: { inputs: unknown[]; view: AtmosphereView } | null = null
let fogCache: { inputs: unknown[]; fog: FogParams } | null = null
let dustCache: { inputs: unknown[]; dust: DustParams } | null = null

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** 没有背景或背景深度时为 null：雾和尘埃都按深度计算 */
export function currentAtmosphereParams(doc: DocState): AtmosphereParams | null {
  const bg = doc.background
  const depth = getDepthResult(bg?.id)
  if (!bg || !depth) return null
  const { fog: fogDoc, dust: dustDoc } = doc.atmosphere
  const viewInputs = [doc.camera, bg, depth, doc.lighting.lights]
  if (!viewCache || !same(viewCache.inputs, viewInputs)) {
    viewCache = { inputs: viewInputs, view: atmosphereView(doc.camera, bg, depthScaleFor(doc.camera, bg, depth), doc.lighting.lights) }
  }
  const view = viewCache.view
  let fog: FogParams | null = null
  if (fogActive(fogDoc)) {
    let auto = colorCache.get(depth)
    if (auto?.id !== bg.id) {
      const color = autoFogColor(bg.id, depth)
      auto = { id: bg.id, color: color ?? NEUTRAL }
      if (color) colorCache.set(depth, auto)
    }
    const fogInputs = [fogDoc, auto.color]
    if (!fogCache || !same(fogCache.inputs, fogInputs)) fogCache = { inputs: fogInputs, fog: fogParams(fogDoc, auto.color) }
    fog = fogCache.fog
  }
  let contact = 1
  if (fog && doc.character) {
    const bbox = characterInfo(doc)?.bbox
    contact = fogTransmittance(fog, view, characterGround(doc, bg, bbox), characterDepth(doc, depth, bbox), bg)
  }
  let dust: DustParams | null = null
  if (dustActive(dustDoc)) {
    const { blades, rotation } = doc.focus.dof
    const dustInputs = [dustDoc, blades, rotation]
    if (!dustCache || !same(dustCache.inputs, dustInputs)) dustCache = { inputs: dustInputs, dust: dustParams(dustDoc, doc.focus.dof) }
    dust = dustCache.dust
  }
  return { view, fog, contact, dust }
}
