/**
 * 离地遮蔽与地面反光（docs/Plan.md M8.8d）：两者的强弱都按立绘每一处到标定地面的高度 h 决定。
 * 遮蔽乘在环境光上（越靠近地面越暗，朝下的法线遮蔽更多）；地面反光作为一个来自下方的面光源加进环境项，
 * 颜色取自接地点周围的地面。GPU 实现见 src/engine/fusion.ts。
 */
import { unproject, type DepthScale } from '@/algo/camera'
import { clamp, type Point } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { characterMeters } from '@/camera/character'
import { depthScaleFor } from '@/camera/depthScale'
import { cameraUp } from '@/camera/geometry'
import type { DepthResult } from '@/depth/protocol'
import { waterActive } from '@/focus/model'
import type { DocState } from '@/state/store'
import { characterDepth, characterGround } from './placement'
import type { CharacterInfo } from './protocol'
import { cutOff } from './shadow'

const FULL_BOX: CharacterInfo['bbox'] = { x0: 0, y0: 0, x1: 1, y1: 1 }
/** 遮蔽对朝下的法线加重的比例：竖直面（朝上的法线）仍有 1 − 这个比例的基础遮蔽 */
const FACING_WEIGHT = 0.6

export interface GroundingParams {
  /** 地面法线（相机空间） */
  up: Vec3
  /** 接地点（相机空间，米） */
  ground: Vec3
  /** 离地遮蔽强度 [0,1] 与范围（米） */
  ao: number
  aoRange: number
  /** 地面反光强度 [0,1]、范围（米）与颜色（线性 RGB，已乘以强度前的地面颜色） */
  bounce: number
  bounceRange: number
  bounceColor: Vec3
  /** 立绘深度（归一化逆深度）到距离的换算，用于求每个像素的 h */
  depthScale: DepthScale
}

/** 平滑台阶，与着色器的 smoothstep 一致 */
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * 离地遮蔽：环境光的可见度。h = 0 时为 1 − 强度 × (1 − 0.4 − 0.6 × facing)，
 * 超过范围后为 1；facing = max(−N·up, 0) 让朝下的面暗得更多。
 */
export function occlusionAt(h: number, range: number, ao: number, facing: number): number {
  return 1 - ao * (1 - smoothstep(0, Math.max(range, 1e-4), Math.max(h, 0))) * (1 - FACING_WEIGHT + FACING_WEIGHT * clamp(facing, 0, 1))
}

/** 地面反光：只在朝下的面上，随高度指数衰减 */
export function bounceAt(h: number, range: number, bounce: number, facing: number): number {
  return bounce * clamp(facing, 0, 1) * Math.exp(-Math.max(h, 0) / Math.max(range, 1e-4))
}

export interface GroundingInputs {
  doc: DocState
  background: DepthResult | undefined
  info: CharacterInfo | undefined
  /** 接地点周围的地面颜色（线性 RGB）；没有取到地面时为 null */
  bounceColor?: Vec3 | null
}

/** 没有立绘、两项强度都是 0、水体遮挡开启、立绘底部被裁切（且接地点为自动）、深度未按地面校准时返回 null。 */
export function groundingParams({ doc, background, info, bounceColor }: GroundingInputs): GroundingParams | null {
  const s = doc.fusion.grounding
  const bg = doc.background
  if (!bg || !doc.character || waterActive(doc.focus) || cutOff(doc, info)) return null
  if (s.ao <= 0 && s.bounce <= 0) return null
  const scale = depthScaleFor(doc.camera, bg, background)
  // h 要按米算，深度必须是按地面校准的
  if (scale.state !== 'ground') return null
  const bbox = info?.bbox ?? FULL_BOX
  const ground = characterGround(doc, bg, bbox)
  const at = unproject(ground, characterDepth(doc, background, bbox), bg, doc.camera.fovDeg, scale)
  const height = characterMeters(doc, bbox) ?? doc.camera.height * 0.6
  return {
    up: cameraUp(doc.camera),
    ground: at,
    ao: s.ao,
    aoRange: Math.max(0.01, s.aoRange * height),
    bounce: s.bounce,
    bounceRange: Math.max(0.01, s.bounceRange * height),
    bounceColor: bounceColor ?? [0, 0, 0],
    depthScale: scale,
  }
}

/** 接地点（文档像素），供地面取色用 */
export function groundingPoint(doc: DocState, info: CharacterInfo | undefined): Point {
  const bg = doc.background
  return bg ? characterGround(doc, bg, info?.bbox ?? FULL_BOX) : { x: 0, y: 0 }
}
