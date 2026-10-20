/**
 * 工程：文档参数与素材原图的快照，用于 .a2r 文件和浏览器内的自动保存。
 * 清单（project.json）记录全部可撤销的参数和使用中的 LUT；素材以原始文件保存，按内容哈希引用。
 * 深度、光源分析等派生数据不保存，打开后重新计算。
 * 导入的内容不可信：逐字段检查类型并限制在界面允许的范围内（与预设相同），缺少或无效的字段取默认值。
 */
import type { LayerTransform, Point } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import type { Estimator } from '@/analysis/protocol'
import { CALIBRATION_METHODS, DEFAULT_CAMERA, FOV_RANGE, HEIGHT_RANGE, HEIGHT_SOURCES, LINE_AXES, PITCH_LIMIT, ROLL_LIMIT, type CameraDoc, type CameraLines, type Segment } from '@/camera/model'
import {
  BOKEH_BLADES,
  DEFAULT_FOCUS,
  DEFAULT_STYLE,
  MAX_REGIONS,
  newRegionId,
  OCCLUSION_MODES,
  type BrushStroke,
  type FocusDoc,
  type FocusTarget,
  type OcclusionRegion,
  type OcclusionStyle,
} from '@/focus/model'
import { DEFAULT_FUSION, RELIGHT_STYLES, type FusionDoc } from '@/fusion/model'
import { conformWarp, IDENTITY_WARP } from '@/fusion/warp'
import { conformGrade, conformPost, embedLuts, gradeForFile, lutResolver } from '@/grade/preset'
import { bool, fields, hex, num, oneOf, record, text, type Json } from '@/io/conform'
import { DEFAULT_INTENSITY, DEFAULT_LIGHTING, MAX_LIGHTS, newLightId, type Light, type LightingDoc } from '@/lighting/model'
import type { AssetRef } from './assets'
import { rescaleDoc, type DocState, type StepId } from './store'

export const PROJECT_FORMAT = 'anime2real-project'
export const PROJECT_VERSION = 1
/** 工程文件中清单的文件名 */
export const MANIFEST_NAME = 'project.json'

export class ProjectError extends Error {}

const STEPS: readonly StepId[] = ['assets', 'camera', 'depth', 'light', 'character', 'focus', 'adjust', 'effects', 'export']
const ESTIMATORS: readonly Estimator[] = ['A', 'B', 'C', 'D']
const KEY = /^[0-9a-z-]{8,80}$/
const MAX_NAME_LENGTH = 200
/** 画笔笔画的坐标个数上限（防止异常文件占满内存） */
const MAX_STROKE_POINTS = 200_000
const MAX_STROKES = 2000
/** 文档坐标的合理范围（像素） */
const COORD: readonly [number, number] = [-1e6, 1e6]

/** 清单中的一张素材 */
export interface ProjectAsset {
  /** 原始文件内容的哈希，也是工程文件中的文件名 */
  key: string
  name: string
  type: string
}

/** 文档中的一个素材位：素材 key，以及保存时的位图尺寸（文档坐标以背景位图的像素为单位） */
interface SlotRef {
  key: string
  width: number
  height: number
}

/**
 * 文档 → 清单。keys 给出背景与立绘原始文件的哈希。
 * 光源分析是否针对当前背景只记一个布尔值，打开后对应到重新登记的背景。
 */
export function projectManifest(doc: DocState, step: StepId, assets: { background: ProjectAsset; character: ProjectAsset | null }): Json {
  if (!doc.background) throw new ProjectError('还没有背景照片')
  const slot = (ref: AssetRef, asset: ProjectAsset): SlotRef => ({ key: asset.key, width: ref.width, height: ref.height })
  const { analyzedFor, ...lighting } = doc.lighting
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    step,
    assets: [assets.background, ...(assets.character ? [assets.character] : [])],
    doc: {
      background: slot(doc.background, assets.background),
      character: doc.character && assets.character ? slot(doc.character, assets.character) : null,
      charTransform: doc.charTransform,
      charWarp: doc.charWarp,
      camera: doc.camera,
      lighting: { ...lighting, analyzed: analyzedFor === doc.background.id },
      fusion: doc.fusion,
      focus: doc.focus,
      grade: gradeForFile(doc.grade),
      post: doc.post,
    },
    luts: embedLuts(doc.grade),
  }
}

/** 清单文本 → 检查过格式与版本的对象 */
export function readManifest(json: string): Json {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new ProjectError('工程清单不是有效的 JSON')
  }
  const o = record(raw)
  if (o.format !== PROJECT_FORMAT) throw new ProjectError('不是 Anime2Real 的工程文件')
  if (typeof o.version !== 'number' || o.version > PROJECT_VERSION) throw new ProjectError('工程来自更新的版本，请更新页面后再试')
  return o
}

/** 清单中列出的素材（去掉格式不对的条目） */
export function manifestAssets(manifest: Json): ProjectAsset[] {
  const list = Array.isArray(manifest.assets) ? manifest.assets : []
  return list.flatMap((v) => {
    const o = record(v)
    if (typeof o.key !== 'string' || !KEY.test(o.key)) return []
    return [{ key: o.key, name: text(o.name, 'image', MAX_NAME_LENGTH), type: typeof o.type === 'string' && /^image\/[\w.+-]+$/.test(o.type) ? o.type : '' }]
  })
}

/** 文档中背景与立绘引用的素材 key */
export function manifestSlots(manifest: Json): { background: string | null; character: string | null } {
  const doc = record(manifest.doc)
  const key = (v: unknown) => {
    const k = record(v).key
    return typeof k === 'string' && KEY.test(k) ? k : null
  }
  return { background: key(doc.background), character: key(doc.character) }
}

export const manifestStep = (manifest: Json): StepId => oneOf(manifest.step, STEPS, 'assets')

// ── 文档各部分 ──

const vec3 = (v: unknown, fallback: Vec3, lo: number, hi: number): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [num(v[0], fallback[0], lo, hi), num(v[1], fallback[1], lo, hi), num(v[2], fallback[2], lo, hi)] : fallback

function unit(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-6 ? [v[0] / len, v[1] / len, v[2] / len] : fallback
}

function conformTransform(v: unknown): LayerTransform {
  const o = record(v)
  return {
    x: num(o.x, 0, ...COORD),
    y: num(o.y, 0, ...COORD),
    scale: num(o.scale, 1, 0.005, 1000),
    rotation: num(o.rotation, 0, -1000, 1000),
    flipX: bool(o.flipX, false),
  }
}

function conformLight(v: unknown): Light | null {
  const o = record(v)
  if (o.type !== 'directional' && o.type !== 'point') return null
  const position = record(o.position)
  const origin = o.origin === null || o.origin === undefined ? null : record(o.origin)
  const fallbackDirection: Vec3 = [0, 0, 1]
  return {
    id: newLightId(),
    type: o.type,
    enabled: bool(o.enabled, true),
    direction: unit(vec3(o.direction, fallbackDirection, -1, 1), fallbackDirection),
    position: { x: num(position.x, 0, ...COORD), y: num(position.y, 0, ...COORD), depth: num(position.depth, 0.5, 0, 1) },
    color: vec3(o.color, [1, 1, 1], 0, 1),
    kelvin: typeof o.kelvin === 'number' ? num(o.kelvin, 6500, 1700, 12000) : null,
    intensity: num(o.intensity, DEFAULT_INTENSITY, 0, 10),
    softness: num(o.softness, 0.2, 0, 1),
    origin: origin && {
      sources: (Array.isArray(origin.sources) ? origin.sources : []).filter((s): s is Estimator => ESTIMATORS.includes(s as Estimator)),
      confidence: num(origin.confidence, 0, 0, 1),
    },
  }
}

/** 光源会换上新的 id，lightIds 记录文件中的 id 到新 id 的对应（供光束所选的光源使用） */
function conformLighting(v: unknown, analyzedFor: string | null, lightIds: Map<string, string>): LightingDoc {
  const o = record(v)
  const lights: Light[] = []
  for (const item of Array.isArray(o.lights) ? o.lights : []) {
    if (lights.length >= MAX_LIGHTS) break
    const light = conformLight(item)
    if (!light) continue
    const id = record(item).id
    if (typeof id === 'string') lightIds.set(id, light.id)
    lights.push(light)
  }
  return {
    lights,
    ambient: num(o.ambient, DEFAULT_LIGHTING.ambient, 0, 2),
    analyzedFor: bool(o.analyzed, false) ? analyzedFor : null,
  }
}

/** 标定线的端点（文档 UV），允许拖到画面之外一些 */
const linePoint = (v: unknown): Point | null => {
  const o = record(v)
  return typeof o.x === 'number' && typeof o.y === 'number' ? { x: num(o.x, 0, -1, 2), y: num(o.y, 0, -1, 2) } : null
}

function linePair(v: unknown): [Segment, Segment] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const segments = v.map((s) => (Array.isArray(s) && s.length === 2 ? [linePoint(s[0]), linePoint(s[1])] : []))
  return segments.every((s): s is Segment => s.length === 2 && s.every((p) => p !== null)) ? (segments as [Segment, Segment]) : null
}

function conformLines(v: unknown): CameraLines | null {
  const o = record(v)
  const first = linePair(o.first)
  const second = linePair(o.second)
  return first && second ? { first, second, secondAxis: oneOf(o.secondAxis, LINE_AXES, 'horizontal') } : null
}

/** 文件中没有相机（旧工程）时按未确认处理 */
function conformCamera(v: unknown): CameraDoc {
  const o = record(v)
  const d = DEFAULT_CAMERA
  return {
    fovDeg: num(o.fovDeg, d.fovDeg, ...FOV_RANGE),
    pitch: num(o.pitch, d.pitch, -PITCH_LIMIT, PITCH_LIMIT),
    roll: num(o.roll, d.roll, -ROLL_LIMIT, ROLL_LIMIT),
    yaw: num(o.yaw, d.yaw, -Math.PI, Math.PI),
    height: num(o.height, d.height, ...HEIGHT_RANGE),
    heightSource: oneOf(o.heightSource, HEIGHT_SOURCES, d.heightSource),
    method: oneOf(o.method, CALIBRATION_METHODS, d.method),
    lines: conformLines(o.lines),
    confirmed: bool(o.confirmed, false),
  }
}

const uv = (v: unknown): { u: number; v: number } | null => {
  const o = record(v)
  return typeof o.u === 'number' && typeof o.v === 'number' ? { u: num(o.u, 0.5, 0, 1), v: num(o.v, 1, 0, 1) } : null
}

function conformFusion(v: unknown, hasCharacter: boolean): FusionDoc {
  const o = record(v)
  const d = DEFAULT_FUSION
  return {
    colorMatch: fields(o.colorMatch, d.colorMatch),
    relight: fields(o.relight, d.relight, { celThreshold: [-0.5, 0.5], celSoftness: [0, 0.3], rim: [0, 2] }, { style: RELIGHT_STYLES }),
    normals: fields(o.normals, d.normals, { inflateRadius: [0.01, 0.2] }),
    edge: fields(o.edge, d.edge, { wrapRadius: [0.001, 0.03], feather: [0, 3], noise: [0, 2], shrink: [0, 2] }),
    shadow: fields(o.shadow, d.shadow, { contactSize: [0.3, 3] }),
    depth: typeof o.depth === 'number' ? num(o.depth, 0.5, 0, 1) : null,
    ground: hasCharacter ? uv(o.ground) : null,
  }
}

const conformStyle = (v: unknown): OcclusionStyle => ({
  ...fields(v, DEFAULT_STYLE, {}, { mode: OCCLUSION_MODES }),
  waterColor: hex(record(v).waterColor, DEFAULT_STYLE.waterColor),
})

function conformStroke(v: unknown): BrushStroke | null {
  const o = record(v)
  const points = Array.isArray(o.points) ? o.points : []
  if (points.length < 2 || points.length % 2 || points.length > MAX_STROKE_POINTS || points.some((p) => typeof p !== 'number' || !Number.isFinite(p))) return null
  return { erase: bool(o.erase, false), radius: num(o.radius, 20, 0.5, 1e4), points: points.map((p) => num(p, 0, ...COORD)) }
}

function conformRegion(v: unknown): OcclusionRegion {
  const o = record(v)
  const strokes = (Array.isArray(o.strokes) ? o.strokes.slice(0, MAX_STROKES) : []).map(conformStroke).filter((s): s is BrushStroke => s !== null)
  return { ...conformStyle(o), id: newRegionId(), strokes }
}

function conformTarget(v: unknown, hasCharacter: boolean): FocusTarget | null {
  const o = record(v)
  if (o.kind === 'character' && hasCharacter) {
    const p = uv(o)
    return p && { kind: 'character', ...p }
  }
  if (o.kind === 'background' && typeof o.x === 'number' && typeof o.y === 'number') return { kind: 'background', x: num(o.x, 0, ...COORD), y: num(o.y, 0, ...COORD) }
  return null
}

function conformFocus(v: unknown, hasCharacter: boolean): FocusDoc {
  const o = record(v)
  const d = DEFAULT_FOCUS
  const dof = record(o.dof)
  const occlusion = record(o.occlusion)
  const { enabled, tolerance, softness, snap } = d.occlusion
  return {
    dof: { ...fields(dof, d.dof, { aperture: [0, 0.05], range: [0, 0.2], rotation: [0, Math.PI] }), blades: oneOf(dof.blades, BOKEH_BLADES, 0) },
    target: conformTarget(o.target, hasCharacter),
    thickness: num(o.thickness, d.thickness, 0, 0.5),
    occlusion: {
      ...fields(occlusion, { enabled, tolerance, softness, snap }, { tolerance: [0, 0.3], softness: [0, 0.2] }),
      ...conformStyle(occlusion),
      regions: (Array.isArray(occlusion.regions) ? occlusion.regions.slice(0, MAX_REGIONS) : []).map(conformRegion),
    },
  }
}

/**
 * 清单 → 文档。slots 给出重新登记后的背景与立绘；位图尺寸与保存时不同（例如换了 GPU 纹理上限不同的设备）时按比例换算坐标。
 * 内嵌的 LUT 会被登记；LUT 数据无效时抛出 PresetError。
 */
export function conformProject(manifest: Json, slots: { background: AssetRef; character: AssetRef | null }): DocState {
  const o = record(manifest.doc)
  const { background, character } = slots
  const lightIds = new Map<string, string>()
  const lighting = conformLighting(o.lighting, background.id, lightIds)
  const doc: DocState = {
    background,
    character,
    charTransform: conformTransform(o.charTransform),
    charWarp: character ? conformWarp(o.charWarp) : IDENTITY_WARP,
    camera: conformCamera(o.camera),
    lighting,
    fusion: conformFusion(o.fusion, !!character),
    focus: conformFocus(o.focus, !!character),
    grade: conformGrade(o.grade, lutResolver(manifest.luts)),
    post: conformPost(o.post, (id) => (typeof id === 'string' ? (lightIds.get(id) ?? null) : null)),
  }
  // 立绘位图尺寸变化时保持它在文档中的大小
  const savedCharacter = record(o.character)
  if (character && typeof savedCharacter.width === 'number' && savedCharacter.width > 0) {
    doc.charTransform = { ...doc.charTransform, scale: (doc.charTransform.scale * savedCharacter.width) / character.width }
  }
  const saved = record(o.background)
  const kx = typeof saved.width === 'number' && saved.width > 0 ? background.width / saved.width : 1
  const ky = typeof saved.height === 'number' && saved.height > 0 ? background.height / saved.height : 1
  return rescaleDoc(doc, kx, ky)
}
