/** 焦点深度与景深着色器参数（docs/Plan.md §3.4），GPU 实现见 src/engine/dof.ts。 */
import { layerToDoc, type Point } from '@/algo/geometry'
import type { DepthResult } from '@/depth/protocol'
import { characterBox, characterDepth } from '@/fusion/placement'
import type { CharacterInfo } from '@/fusion/protocol'
import { sampleDepth } from '@/lighting/sampling'
import type { DocState } from '@/state/store'
import { bokehKernel, circleOfConfusion, reliefDepth, reliefScale, type KernelPoint } from './dof'
import { OCCLUSION_MODES } from './model'

/** 散景采样点数 */
export const BOKEH_SAMPLES = 48

export interface FocusInputs {
  doc: DocState
  /** 背景与立绘的深度结果；未就绪时为 undefined */
  background: DepthResult | undefined
  character: DepthResult | undefined
  /** 融合 Worker 给出的立绘信息；未就绪时为 undefined */
  info: CharacterInfo | undefined
}

/** 立绘深度：平面深度 + (起伏 − 基准) × 比例，见 reliefDepth */
export interface CharacterRelief {
  plane: number
  reference: number
  scale: number
}

export function characterRelief({ doc, background, character, info }: FocusInputs): CharacterRelief {
  const plane = characterDepth(doc, background, info?.bbox)
  const ch = doc.character
  const bg = doc.background
  const reference = info?.reliefMedian ?? 0.5
  if (!ch || !bg || !character) return { plane, reference, scale: 0 }
  const box = info?.bbox ?? { y0: 0, y1: 1 }
  const height = (box.y1 - box.y0) * ch.height * doc.charTransform.scale
  return { plane, reference, scale: reliefScale(doc.focus.thickness, height, plane, bg, doc.lighting.fovDeg) }
}

/** 立绘 UV 处的自身起伏（引导分辨率，最近邻） */
function sampleRelief(result: DepthResult, u: number, v: number): number {
  const { width, height } = result.guideSize
  const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)))
  const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)))
  return result.depth[y * width + x]
}

/** 焦点的归一化逆深度 */
export function focusDepth(input: FocusInputs, relief = characterRelief(input)): number {
  const { doc } = input
  const target = doc.focus.target
  if (!target) return relief.plane
  if (target.kind === 'background') return doc.background ? sampleDepth(input.background, target, doc.background).depth : relief.plane
  const r = input.character ? sampleRelief(input.character, target.u, target.v) : relief.reference
  return reliefDepth(relief.plane, r, relief.reference, relief.scale)
}

/** 焦点标记在文档中的位置；自动对焦时为立绘不透明区域的中心，没有立绘时为 null。 */
export function focusPoint(doc: DocState, info: CharacterInfo | undefined): Point | null {
  const target = doc.focus.target
  const ch = doc.character
  if (target?.kind === 'background') return { x: target.x, y: target.y }
  if (!ch) return null
  if (target) return layerToDoc(doc.charTransform, { x: (target.u - 0.5) * ch.width, y: (target.v - 0.5) * ch.height })
  const box = characterBox(doc, info?.bbox)
  return { x: box.reduce((s, p) => s + p.x, 0) / 4, y: box.reduce((s, p) => s + p.y, 0) / 4 }
}

export interface FocusParams {
  /** 景深是否生效（开启且光圈大于 0） */
  dof: boolean
  focus: number
  aperture: number
  range: number
  kernel: KernelPoint[]
  relief: CharacterRelief
  /** 立绘各处弥散圆半径的上限（相对图像长边），决定立绘层的采样范围 */
  characterCoc: number
  occlusion: { enabled: boolean; mode: number; tolerance: number; softness: number }
}

export function focusParams(input: FocusInputs): FocusParams {
  const { dof, occlusion } = input.doc.focus
  const relief = characterRelief(input)
  const focus = focusDepth(input, relief)
  const enabled = dof.enabled && dof.aperture > 0
  const aperture = enabled ? dof.aperture : 0
  const coc = (r: number) => Math.abs(circleOfConfusion(reliefDepth(relief.plane, r, relief.reference, relief.scale), focus, aperture, dof.range))
  return {
    dof: enabled,
    focus,
    aperture,
    range: dof.range,
    kernel: bokehKernel(BOKEH_SAMPLES, dof.blades, dof.rotation),
    relief,
    characterCoc: Math.max(coc(0), coc(1), coc(relief.reference)),
    occlusion: { enabled: occlusion.enabled, mode: OCCLUSION_MODES.indexOf(occlusion.mode), tolerance: occlusion.tolerance, softness: occlusion.softness },
  }
}
