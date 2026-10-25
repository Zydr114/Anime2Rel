/**
 * 站立阴影（docs/Plan.md §3.4 M4 遮挡扩展）：接地点处的接触阴影，以及沿主光源方向投到地面平面上的立绘剪影。
 * GPU 实现见 src/engine/shadow.ts。
 *
 * 地面平面过接地点（接地点的 2.5D 位置），法线为标定的相机给出的上方向（M8.5，相机水平时为正上方）；光源方向是相机空间的，
 * 这样光源仰角与灯光球上看到的一致；深度估计得到的平地法线会随伪深度的偏移明显倾斜，不用来定地面朝向。投影把立绘当作立在接地点上、
 * 朝向光源的竖直平面：地面上沿“背离光源”方向距离接地点 s 的点，对应立绘上高 s·tan(仰角) 的位置。
 * 阴影颜色 = 去掉主光源后的光照 / 全部光照，晴天偏天空色；没有方向明确的光源时投影自然消失。
 *
 * 贴合表面（M8.8d）：遮挡体是立绘占据的体积，从主光源的视角生成阴影贴图（src/fusion/shadowMap.ts），受影点取自背景深度，
 * 影子随台阶、墙面弯折。立绘自身的投影查同一张贴图。离地遮蔽与地面反光（src/fusion/grounding.ts）用同一个接地点和地面平面。
 */
import { normalize, sceneDepth, unproject, type DepthScale } from '@/algo/camera'
import type { Point } from '@/algo/geometry'
import { focalLength } from '@/algo/normals'
import { shade, wrapDiffuse } from '@/algo/shading'
import { LUMA, type ShRgb, type Vec3 } from '@/algo/sh'
import { depthScaleFor } from '@/camera/depthScale'
import { cameraUp, horizonLine } from '@/camera/geometry'
import type { DepthResult } from '@/depth/protocol'
import { waterActive } from '@/focus/model'
import { effectiveLight } from '@/lighting/preview'
import type { DocState } from '@/state/store'
import type { ShadowMode } from './model'
import { characterBox, characterDepth, characterGround, characterHeight, characterOutline, groundUV, layerUVToDoc } from './placement'
import { ROW_BINS, type CharacterInfo } from './protocol'
import { BOUNCE_RADIUS, type GroundSampling } from './grounding'
import { boundingRect, occupancyCorners, shadowMapParams, type ShadowMapParams } from './shadowMap'
import { isIdentityWarp } from './warp'

const FULL_BOX: CharacterInfo['bbox'] = { x0: 0, y0: 0, x1: 1, y1: 1 }
/** 量取脚部宽度的范围：接地点以上包围盒高度的这个比例 */
const FOOT_BAND = 0.06
/** 阴影最暗不低于原亮度的这个比例（背景中总有反射光） */
const MIN_SHADOW = 0.2
/** 接触阴影在阴影颜色基础上再遮住的环境光比例 */
const CONTACT_OCCLUSION = 0.55
/** 占据体积的范围按立绘起伏 r 的这个区间估计（深度修正可能让起伏略超出 [0,1]） */
const RELIEF_RANGE = [-0.25, 1.25] as const

export interface ShadowParams {
  /** 接地点（文档像素）与该处的距离，单位与 depthScale 一致 */
  ground: Point
  groundZ: number
  /** 背景逆深度到距离的换算（深度校准） */
  depthScale: DepthScale
  /** 焦距（文档像素） */
  focal: number
  /** 地面法线（相机空间） */
  normal: Vec3
  contact: {
    strength: number
    /** 椭圆中心（文档像素）、长轴方向（与地平线平行的单位向量）与长、短半轴 */
    center: Point
    dir: Point
    axes: [number, number]
    softness: number
    /** 阴影最深处的颜色倍率 */
    tint: Vec3
  }
  cast: {
    strength: number
    /** 地面上背离光源的方向、与之垂直且朝向画面右侧的方向（相机空间单位向量） */
    along: Vec3
    lateral: Vec3
    /** 主光源相对地面的仰角正切 */
    tanElevation: number
    softness: number
    tint: Vec3
  }
  /** 实际使用的投影方式：贴合表面需要按地面校准的背景深度，否则按平面计算 */
  mode: ShadowMode
  /**
   * 立绘正面的三维位置：z正面 = planeZ − (r − reference) × relief（米）。
   * planeZ 为立绘平面的距离，relief 为立绘厚度 × 人物高度（立绘深度未就绪时为 0），height 为人物高度
   */
  figure: { planeZ: number; relief: number; reference: number; height: number }
  /** 阴影贴图：贴合表面的投影或立绘自身的投影需要它；都不需要或没有主光源时为 null */
  map: ShadowMapInfo | null
  /** 离地遮蔽与地面反光：都关闭时为 null。范围已换算到米，地面平面过接地点、法线为 normal */
  grounding: {
    point: Vec3
    occlusion: number
    occlusionRange: number
    bounce: number
    bounceRange: number
    /** 地面颜色（线性）；取不到时地面反光为 0 */
    bounceColor: Vec3
  } | null
}

export interface ShadowMapInfo extends ShadowMapParams {
  /** 身体厚度（米） */
  body: number
  /** 立绘自身的投影强度 */
  self: number
  /** 主光源在启用的光源中的序号：重光照把自身投影乘在这个光源上 */
  lightIndex: number
}

/** 贴合表面能否使用：需要背景深度，并且深度已按地面校准 */
export type SurfaceState = 'ok' | 'noDepth' | 'notCalibrated'

export function surfaceState(doc: DocState, background: DepthResult | undefined): SurfaceState {
  if (!doc.background || !background) return 'noDepth'
  return depthScaleFor(doc.camera, doc.background, background).state === 'ground' ? 'ok' : 'notCalibrated'
}

export interface ShadowInputs {
  doc: DocState
  background: DepthResult | undefined
  info: CharacterInfo | undefined
  /** 光源分析得到的环境光 SH（27 个系数）；未就绪时为 undefined */
  ambient: ArrayLike<number> | undefined
  /** 立绘的深度结果：未就绪时立绘按平的处理 */
  character?: DepthResult
  /** 接地点周围的地面颜色（融合 Worker 统计）；未就绪或取不到时为 null */
  groundColor?: Vec3 | null
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 接地点以上一小段内立绘不透明区域的左右边界（立绘 UV）；没有不透明像素时为 null。 */
export function footSpan(info: CharacterInfo, v: number): { u0: number; u1: number } | null {
  const box = info.bbox
  const top = v - FOOT_BAND * (box.y1 - box.y0)
  const [v0, v1] = info.rowSpan
  const bin = (y: number) => Math.floor(((y - v0) / (v1 - v0)) * ROW_BINS)
  let u0 = Infinity
  let u1 = -Infinity
  for (let b = Math.max(0, bin(top)); b <= Math.min(ROW_BINS - 1, bin(v)); b++) {
    if (info.rows[b * 2] < 0) continue
    u0 = Math.min(u0, info.rows[b * 2])
    u1 = Math.max(u1, info.rows[b * 2 + 1])
  }
  return u1 > u0 ? { u0, u1 } : null
}

/** 立绘底部被裁切（半身像）且接地点为自动：脚不在画面里，不画阴影 */
export function cutOff(doc: DocState, info: CharacterInfo | undefined): boolean {
  return !doc.fusion.ground && !!info && info.cut
}

/** 接地点与地面平面：接地点在水中（水体遮挡开启）或立绘是半身像且接地点为自动时为 null */
function groundFrame(doc: DocState, background: DepthResult | undefined, info: CharacterInfo | undefined) {
  const bg = doc.background
  if (!bg || !doc.character || waterActive(doc.focus) || cutOff(doc, info)) return null
  const bbox = info?.bbox ?? FULL_BOX
  const fov = doc.camera.fovDeg
  const ground = characterGround(doc, bg, bbox)
  const depth = characterDepth(doc, background, bbox)
  const scale = depthScaleFor(doc.camera, bg, background)
  const at = unproject(ground, depth, bg, fov, scale)
  const groundZ = sceneDepth(depth, scale)
  const focal = focalLength(bg.width, bg.height, fov)
  /** 人物高度（米）：不透明区域的高度按立绘平面的距离换算 */
  const height = (characterHeight(doc, bbox) * groundZ) / focal
  return { bg, bbox, fov, ground, scale, at, groundZ, focal, height, normal: cameraUp(doc.camera) }
}

/** 地面反光的取色范围（融合 Worker 按它统计地面颜色）；接地点无效时为 null */
export function groundSampling(doc: DocState, background: DepthResult | undefined, info: CharacterInfo | undefined): GroundSampling | null {
  const frame = groundFrame(doc, background, info)
  if (!frame) return null
  const { at, normal, height, focal, bg, scale } = frame
  return { point: at, up: normal, radius: BOUNCE_RADIUS * height, focal, size: { width: bg.width, height: bg.height }, depthScale: { a: scale.a, b: scale.b, far: scale.far } }
}

/** 没有立绘、各项都关闭、水体遮挡开启（接地点是水线），或立绘底部被裁切且接地点为自动时返回 null。 */
export function shadowParams({ doc, background, info, ambient, character, groundColor }: ShadowInputs): ShadowParams | null {
  const ch = doc.character
  const s = doc.fusion.shadow
  const g = doc.fusion.grounding
  if (s.contact <= 0 && s.cast <= 0 && s.self <= 0 && g.occlusion <= 0 && g.bounce <= 0) return null
  const frame = groundFrame(doc, background, info)
  if (!frame || !ch) return null
  const { bg, bbox, fov, ground, scale, at, groundZ, focal, height, normal } = frame
  const t = doc.charTransform

  // 接触阴影：宽度取脚部的不透明宽度，扁度取视线与地面法线夹角的余弦
  const { u, v } = groundUV(doc, bbox)
  const span = info ? footSpan(info, v) : null
  const uc = span ? (span.u0 + span.u1) / 2 : u
  const half = (span ? (span.u1 - span.u0) / 2 : 0.15 * (bbox.x1 - bbox.x0)) * ch.width * t.scale
  const aspect = Math.min(0.6, Math.max(0.1, Math.abs(dot(normal, normalize([-at[0], -at[1], -at[2]])))))
  const a = Math.max(2, half * s.contactSize * 1.15)
  const center = layerUVToDoc(doc, { x: uc, y: v })

  // 阴影颜色：挡住主光源（地面上贡献最大的光源）后剩下的光照与全部光照之比
  const amb: ShRgb = Float64Array.from(ambient ?? new Array<number>(27).fill(0), (x) => x * doc.lighting.ambient)
  const lights = doc.lighting.lights.filter((l) => l.enabled).map((l) => effectiveLight(l, at, bg, fov, scale))
  const contribution = lights.map((l) => wrapDiffuse(dot(normal, l.direction), l.softness) * dot(l.color, LUMA))
  const main = contribution.length ? contribution.indexOf(Math.max(...contribution)) : -1
  const total = shade(normal, amb, lights)
  const rest = shade(
    normal,
    amb,
    lights.filter((_, i) => i !== main),
  )
  const tint = total.map((x, c) => (x > 1e-6 ? Math.min(1, Math.max(MIN_SHADOW, rest[c] / x)) : 1)) as Vec3
  const contactTint = tint.map((x) => Math.max(0.1, x * (1 - CONTACT_OCCLUSION))) as Vec3

  // 投影：光源太低时影子过长、不可靠，逐渐淡出；光源在正上方时影子缩在脚下，交给接触阴影
  let cast = { strength: 0, along: [0, 0, -1] as Vec3, lateral: [1, 0, 0] as Vec3, tanElevation: 1, softness: s.castSoftness, tint }
  if (main >= 0 && s.cast > 0) {
    const L = lights[main].direction
    const sin = Math.min(0.999, dot(normal, L))
    const horizontal: Vec3 = [L[0] - sin * normal[0], L[1] - sin * normal[1], L[2] - sin * normal[2]]
    const len = Math.hypot(...horizontal)
    if (sin > 0 && len > 1e-3) {
      const along = normalize(horizontal.map((x) => -x))
      let lateral = normalize(cross(normal, along))
      if (lateral[0] < 0) lateral = lateral.map((x) => -x) as Vec3
      cast = { strength: s.cast * smoothstep(0.03, 0.15, sin), along, lateral, tanElevation: sin / Math.sqrt(1 - sin * sin), softness: s.castSoftness, tint }
    }
  }

  const mode: ShadowMode = s.mode === 'surface' && scale.state === 'ground' && !!background ? 'surface' : 'plane'
  const relief = character ? doc.focus.thickness * height : 0
  const reference = info?.reliefMedian ?? 0.5
  let map: ShadowMapInfo | null = null
  if (main >= 0 && ((mode === 'surface' && cast.strength > 0) || s.self > 0)) {
    const mainLight = doc.lighting.lights.filter((l) => l.enabled)[main]
    const body = s.bodyDepth * height
    const near = groundZ - (RELIEF_RANGE[1] - reference) * relief
    const far = groundZ + (reference - RELIEF_RANGE[0]) * relief + body
    // 不透明区域的包围盒经变形后的外框：变形是连续的，边界的像就围住了整个区域
    const outline = isIdentityWarp(doc.charWarp) ? characterBox(doc, bbox) : characterOutline(doc, 8, bbox)
    const corners = occupancyCorners(boundingRect(outline, 0.05), bg, focal, Math.max(near, groundZ * 0.05), far)
    const light =
      mainLight.type === 'directional'
        ? { point: false, vector: mainLight.direction }
        : { point: true, vector: unproject(mainLight.position, mainLight.position.depth, bg, fov, scale) }
    const params = shadowMapParams(light, corners)
    if (params) map = { ...params, body, self: s.self, lightIndex: main }
  }
  const bounce = groundColor ? g.bounce : 0
  const grounding =
    g.occlusion > 0 || bounce > 0
      ? { point: at, occlusion: g.occlusion, occlusionRange: g.occlusionRange * height, bounce, bounceRange: g.bounceRange * height, bounceColor: groundColor ?? ([0, 0, 0] as Vec3) }
      : null

  return {
    ground,
    groundZ,
    depthScale: scale,
    focal,
    normal,
    contact: { strength: s.contact, center, dir: horizonLine(doc.camera, bg).dir, axes: [a, Math.max(1.5, a * aspect)], softness: s.contactSoftness, tint: contactTint },
    cast,
    mode,
    figure: { planeZ: groundZ, relief, reference, height },
    map,
    grounding,
  }
}
