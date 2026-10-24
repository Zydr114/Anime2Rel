/**
 * 站立阴影（docs/Plan.md §3.4 M4 遮挡扩展）：接地点处的接触阴影，以及沿主光源方向投到地面平面上的立绘剪影。
 * GPU 实现见 src/engine/shadow.ts。
 *
 * 地面平面过接地点（接地点的 2.5D 位置），法线为标定的相机给出的上方向（M8.5，相机水平时为正上方）；光源方向是相机空间的，
 * 这样光源仰角与灯光球上看到的一致；深度估计得到的平地法线会随伪深度的偏移明显倾斜，不用来定地面朝向。投影把立绘当作立在接地点上、
 * 朝向光源的竖直平面：地面上沿“背离光源”方向距离接地点 s 的点，对应立绘上高 s·tan(仰角) 的位置。
 * 阴影颜色 = 去掉主光源后的光照 / 全部光照，晴天偏天空色；没有方向明确的光源时投影自然消失。
 */
import { normalize, sceneDepth, unproject, type DepthScale } from '@/algo/camera'
import { clamp, type Point, type Size } from '@/algo/geometry'
import { focalLength } from '@/algo/normals'
import { shade, wrapDiffuse } from '@/algo/shading'
import { LUMA, type ShRgb, type Vec3 } from '@/algo/sh'
import { characterMeters } from '@/camera/character'
import { depthScaleFor, type CalibratedDepth } from '@/camera/depthScale'
import { cameraUp, horizonLine } from '@/camera/geometry'
import type { DepthResult } from '@/depth/protocol'
import { waterActive } from '@/focus/model'
import type { Light } from '@/lighting/model'
import { effectiveLight } from '@/lighting/preview'
import type { DocState } from '@/state/store'
import { characterBox, characterDepth, characterGround, groundUV, layerUVToDoc } from './placement'
import { ROW_BINS, type CharacterInfo } from './protocol'

const FULL_BOX: CharacterInfo['bbox'] = { x0: 0, y0: 0, x1: 1, y1: 1 }
/** 量取脚部宽度的范围：接地点以上包围盒高度的这个比例 */
const FOOT_BAND = 0.06
/** 阴影最暗不低于原亮度的这个比例（背景中总有反射光） */
const MIN_SHADOW = 0.2
/** 接触阴影在阴影颜色基础上再遮住的环境光比例 */
const CONTACT_OCCLUSION = 0.55
/** 贴合表面的步数（着色器中的循环次数） */
export const SURFACE_STEPS = 20
/** 贴合表面：最远距离的上限，人物高度的倍数 */
const SURFACE_REACH = 8
/** 贴合表面：首步长，人物高度的比例 */
const SURFACE_FIRST = 0.01
/** 贴合表面：裁剪矩形超过画幅的这个比例时不裁剪 */
const CULL_COVERAGE = 0.85

/**
 * 贴合表面投影（M8.8d）：背景的每个像素朝主光源步进，投影回画面检查是否落在立绘占据的深度区间内，
 * 因此影子会贴着台阶、斜坡、墙面弯折。GPU 实现见 src/engine/shadow.ts。
 */
export interface SurfaceCast {
  /** 0 方向光（vector 为指向光源的单位向量），1 点光源（vector 为相机空间位置） */
  type: 0 | 1
  vector: Vec3
  /** 立绘厚度（米）：正面到背面的距离 */
  thickness: number
  /** 第一步的长度（米）、步长比与最远距离（米） */
  first: number
  ratio: number
  reach: number
  /** 屏幕空间的裁剪矩形（文档像素）：x0、y0、x1、y1；null 为不裁剪 */
  rect: [number, number, number, number] | null
}

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
  /** 贴合表面方式下的步进参数；平面方式或无法重建三维位置时为 null */
  surface: SurfaceCast | null
}

export interface ShadowInputs {
  doc: DocState
  background: DepthResult | undefined
  info: CharacterInfo | undefined
  /** 光源分析得到的环境光 SH（27 个系数）；未就绪时为 undefined */
  ambient: ArrayLike<number> | undefined
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

/** 没有立绘、阴影都关闭、水体遮挡开启（接地点是水线），或立绘底部被裁切且接地点为自动时返回 null。 */
export function shadowParams({ doc, background, info, ambient }: ShadowInputs): ShadowParams | null {
  const bg = doc.background
  const ch = doc.character
  const s = doc.fusion.shadow
  if (!bg || !ch || (s.contact <= 0 && s.cast <= 0) || waterActive(doc.focus)) return null
  const bbox = info?.bbox ?? FULL_BOX
  if (cutOff(doc, info)) return null

  const fov = doc.camera.fovDeg
  const ground = characterGround(doc, bg, bbox)
  const depth = characterDepth(doc, background, bbox)
  const scale = depthScaleFor(doc.camera, bg, background)
  const at = unproject(ground, depth, bg, fov, scale)
  const normal = cameraUp(doc.camera)
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
  const enabledLights = doc.lighting.lights.filter((l) => l.enabled)
  const lights = enabledLights.map((l) => effectiveLight(l, at, bg, fov, scale))
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

  const focalPx = focalLength(bg.width, bg.height, fov)
  const groundZ = sceneDepth(depth, scale)
  const surface = surfaceCast({ doc, size: bg, bbox, lights: enabledLights, directions: lights.map((l) => l.direction), main, scale, at, normal, fov, focal: focalPx, zChar: groundZ })

  return {
    ground,
    groundZ,
    depthScale: scale,
    focal: focalPx,
    normal,
    contact: { strength: s.contact, center, dir: horizonLine(doc.camera, bg).dir, axes: [a, Math.max(1.5, a * aspect)], softness: s.contactSoftness, tint: contactTint },
    cast,
    surface,
  }
}

interface SurfaceInput {
  doc: DocState
  size: Size
  bbox: CharacterInfo['bbox']
  /** 启用的光源与它们在接地点处的方向（一一对应） */
  lights: Light[]
  directions: Vec3[]
  /** 投影所用主光源的下标 */
  main: number
  scale: CalibratedDepth
  /** 接地点（相机空间）与地面法线 */
  at: Vec3
  normal: Vec3
  fov: number
  focal: number
  /** 立绘平面的距离 */
  zChar: number
}

/** 贴合表面的步进参数：光源、立绘厚度、几何步长与裁剪矩形。平面方式、深度未按地面校准，或光源太低时为 null。 */
function surfaceCast({ doc, size, bbox, lights, directions, main, scale, at, normal, fov, focal, zChar }: SurfaceInput): SurfaceCast | null {
  const s = doc.fusion.shadow
  if (main < 0 || s.cast <= 0 || s.method !== 'surface' || scale.state !== 'ground') return null
  const light = lights[main]
  const height = characterMeters(doc, bbox) ?? doc.camera.height * 0.6
  // 立绘厚度与浮雕的取值范围是同一个量（src/focus/dof.ts 的 reliefScale）
  const thickness = Math.max(0.005, doc.focus.thickness) * height
  const sin = clamp(dot(normal, directions[main]), 0.06, 0.999)
  const tanElevation = sin / Math.sqrt(1 - sin * sin)
  const reachMax = Math.min(SURFACE_REACH * height, height / tanElevation)
  const vector: Vec3 = light.type === 'directional' ? directions[main] : unproject(light.position, light.position.depth, size, fov, scale)
  const toLight: Vec3 = vector.map((v, i) => v - at[i]) as Vec3
  const away: Vec3 = light.type === 'directional' ? (directions[main].map((v) => -v) as Vec3) : normalize(toLight.map((v) => -v) as Vec3)
  // 灯比影子落到的地方还近时，影子不可能超过灯的距离
  const reach = light.type === 'directional' ? reachMax : Math.min(reachMax, Math.hypot(...toLight))
  const first = SURFACE_FIRST * height
  if (!(reach > first * 1.05)) return null
  return {
    type: light.type === 'directional' ? 0 : 1,
    vector,
    thickness,
    first,
    ratio: (reach / first) ** (1 / (SURFACE_STEPS - 1)),
    reach,
    rect: surfaceRect(doc, size, bbox, zChar, thickness, away, reach, focal),
  }
}

/**
 * 立绘的三维包围盒沿背离光源的方向延长最远距离，投影回画面得到的矩形（文档像素）。
 * 有点落到相机后方、或矩形盖住了大半画幅时返回 null，表示不裁剪。
 */
function surfaceRect(doc: DocState, size: Size, bbox: CharacterInfo['bbox'], zChar: number, thickness: number, away: Vec3, reach: number, focal: number): [number, number, number, number] | null {
  const halfW = size.width / 2
  const halfH = size.height / 2
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const depth = Math.min(Math.max(zChar, 0.05), 1e6)
  for (const c of characterBox(doc, bbox)) {
    const rx = (c.x - halfW) / focal
    const ry = (halfH - c.y) / focal
    for (const z of [depth - thickness, depth + thickness]) {
      for (const k of [0, reach]) {
        const x = rx * z + away[0] * k
        const y = ry * z + away[1] * k
        const w = z - away[2] * k
        if (!(w > 0.05)) return null
        const sx = halfW + (x / w) * focal
        const sy = halfH - (y / w) * focal
        x0 = Math.min(x0, sx)
        y0 = Math.min(y0, sy)
        x1 = Math.max(x1, sx)
        y1 = Math.max(y1, sy)
      }
    }
  }
  const pad = 2
  const rect: [number, number, number, number] = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(size.width, x1 + pad), Math.min(size.height, y1 + pad)]
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) return [0, 0, 0, 0]
  return (rect[2] - rect[0]) * (rect[3] - rect[1]) > CULL_COVERAGE * size.width * size.height ? null : rect
}
