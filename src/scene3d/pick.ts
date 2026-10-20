/**
 * 3D 视图中点选表面（docs/Plan.md §3.7 M8.6a）：沿视线步进，在原相机的深度中找到第一处从表面前方穿到后方的位置。
 * 与 3D 视图中的网格一样：背景按校准后的深度，立绘按浮雕的起伏；穿到表面后方很远时视为从深度跳变的空缺中穿过，继续向前。
 * 照片之外的地方退回到标定的地面。
 */
import { sceneDepth, type DepthScale } from '@/algo/camera'
import type { Point, Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { cameraFocal, projectPoint } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import { add } from '@/camera/vec'
import type { DepthResult } from '@/depth/protocol'
import { DEPTH_SHIFT, reliefDepth } from '@/focus/dof'
import { characterRelief } from '@/focus/params'
import { characterUV } from '@/fusion/placement'
import type { CharacterInfo } from '@/fusion/protocol'
import { assetPixels, sampleDepth } from '@/lighting/sampling'
import type { DocState } from '@/state/store'
import { cameraFromWorld, directionToCamera } from './space'

/** 场景表面：文档像素处沿原相机光轴的距离 */
export interface SurfaceModel {
  camera: CameraDoc
  size: Size
  /** 背景的距离，天空为 Infinity */
  background: (p: Point) => number
  /** 立绘的距离，不透明区域之外为 null */
  character: (p: Point) => number | null
}

export interface SurfaceHit {
  point: Vec3
  /** 所在的文档像素；在照片之外的地面上时为 null */
  doc: Point | null
  on: 'background' | 'character' | 'ground'
}

/** 每步前进当前距离的比例 */
const STEP = 0.01
/** 穿到表面后方超过该比例时视为从空缺中穿过，与 3D 视图剔除深度跳变的阈值一致 */
const JUMP = 0.25
const REFINE = 20
const SKY = 0.5
const OPAQUE = 128

export function surfaceModel(doc: DocState, scale: DepthScale, background: DepthResult | undefined, character: DepthResult | undefined, info: CharacterInfo | undefined): SurfaceModel | null {
  const bg = doc.background
  if (!bg) return null
  const relief = characterRelief({ doc, background, character, info })
  // 浮雕的伪深度以立绘平面为基准缩放到校准后的距离，与 3D 视图中的立绘一致
  const k = sceneDepth(relief.plane, scale) * (relief.plane + DEPTH_SHIFT)
  const pixels = doc.character ? assetPixels(doc.character.id) : null
  return {
    camera: doc.camera,
    size: bg,
    background: (p) => {
      const s = sampleDepth(background, p, bg)
      return s.sky > SKY ? Infinity : sceneDepth(s.depth, scale)
    },
    character: (p) => {
      if (!pixels) return null
      const { point: uv, inside } = characterUV(doc, p)
      if (!inside) return null
      const x = Math.min(pixels.width - 1, Math.max(0, Math.floor(uv.x * pixels.width)))
      const y = Math.min(pixels.height - 1, Math.max(0, Math.floor(uv.y * pixels.height)))
      if (pixels.data[(y * pixels.width + x) * 4 + 3] < OPAQUE) return null
      const r = character ? sampleDepth(character, uv, { width: 1, height: 1 }).depth : relief.reference
      return k / (reliefDepth(relief.plane, r, relief.reference, relief.scale) + DEPTH_SHIFT)
    },
  }
}

/**
 * 视线（世界坐标，dir 为单位向量）在 [near, far] 内碰到的第一个表面；没有碰到时为 null。
 * 照片之外画着地面网格的地方也可以点：标定的地面 y = 0 同样算作表面。
 */
export function pickSurface(m: SurfaceModel, ray: { origin: Vec3; dir: Vec3 }, near: number, far: number): SurfaceHit | null {
  const f = cameraFocal(m.camera, m.size)
  const pixel = (point: Vec3) => {
    const x = cameraFromWorld(m.camera, point)
    const doc = projectPoint(x, m.size, f)
    return { x, doc: doc && doc.x >= 0 && doc.y >= 0 && doc.x <= m.size.width && doc.y <= m.size.height ? doc : null }
  }
  const probe = (t: number) => {
    const point = add(ray.origin, ray.dir, t)
    const { x, doc } = pixel(point)
    if (!doc) return null
    const b = m.background(doc)
    const c = m.character(doc)
    const on: SurfaceHit['on'] = c !== null && c < b ? 'character' : 'background'
    const s = on === 'character' ? c! : b
    return { t, point, doc, on, surface: s, gap: -x[2] - s }
  }
  const ground = ray.dir[1] !== 0 ? -ray.origin[1] / ray.dir[1] : -1
  const limit = ground > near ? Math.min(far, ground) : far
  let front: number | null = null
  for (let t = near; t < limit; t *= 1 + STEP) {
    const q = probe(t)
    if (!q || !Number.isFinite(q.surface)) {
      front = q ? t : null
      continue
    }
    if (q.gap < 0) {
      front = t
      continue
    }
    if (front !== null && q.gap <= JUMP * q.surface) {
      // 在前一步（表面前方）和这一步之间二分
      let lo = front
      let hi = t
      for (let i = 0; i < REFINE; i++) {
        const mid = (lo + hi) / 2
        const r = probe(mid)
        if (r && Number.isFinite(r.surface) && r.gap >= 0) hi = mid
        else lo = mid
      }
      const hit = probe(hi) ?? q
      return { point: hit.point, doc: hit.doc, on: hit.on }
    }
    front = null
  }
  if (ground <= near || ground >= far) return null
  const point = add(ray.origin, ray.dir, ground)
  return { point, doc: pixel(point).doc, on: 'ground' }
}

/** 视线方向在原相机画面中的位置（远处的天空）；不在原相机前方时为 null */
export function skyPixel(camera: CameraDoc, size: Size, dir: Vec3): Point | null {
  return projectPoint(directionToCamera(camera, dir), size, cameraFocal(camera, size))
}
