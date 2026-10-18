/**
 * 分层景深与深度遮挡的 TSL 材质（docs/Plan.md §3.4），参数由 src/focus/params.ts 换算。
 *
 * 背景、立绘、遮挡层各自按自己的弥散圆做 gather 模糊，最后再合成，立绘边缘不会有光晕和渗色。
 * gather 参考 Gustafsson《Bokeh depth of field in a single pass》：样本的弥散圆覆盖到当前像素才计入；
 * 比当前像素远的样本最多扩散到当前像素弥散圆的两倍，模糊的远景不会盖住清晰的近景，模糊的近景可以扩散到清晰的远景上。
 * 采样半径取周围 16×16 像素块内弥散圆的最大值，按采样间距选用 mipmap 级别做预模糊。
 */
import * as THREE from 'three/webgpu'
import { abs, float, floor, Fn, If, log2, Loop, max, min, mix, screenCoordinate, screenUV, select, sign, smoothstep, uniform, uniformArray, vec2, vec4 } from 'three/tsl'
import { DEPTH_SHIFT, MIN_PSEUDO_DEPTH } from '@/focus/dof'
import { BOKEH_SAMPLES, type FocusParams } from '@/focus/params'
import { material, type FloatNode, type Vec4Node } from './nodes'

type Vec2Node = THREE.Node<'vec2'>
type TextureNode = THREE.TextureNode

/** 弥散圆最大值的统计块大小（像素） */
export const TILE = 16
/** 遮挡层边缘的最小模糊半径（像素），用于抗锯齿 */
const OCCLUSION_AA = 1

export function createDofUniforms() {
  return {
    /** 当前渲染目标与弥散圆统计块纹理的尺寸 */
    targetSize: uniform(new THREE.Vector2(1, 1)),
    tileSize: uniform(new THREE.Vector2(1, 1)),
    targetLong: uniform(1),
    focus: uniform(0.5),
    aperture: uniform(0),
    range: uniform(0),
    kernel: uniformArray(
      Array.from({ length: BOKEH_SAMPLES }, () => new THREE.Vector4()),
      'vec4',
    ),
    planeZ: uniform(1 / (0.5 + DEPTH_SHIFT)),
    reliefReference: uniform(0.5),
    reliefScale: uniform(0),
    /** 立绘弥散圆的上限（相对图像长边） */
    characterCoc: uniform(0),
    occlusion: uniform(0),
    occlusionMode: uniform(0),
    tolerance: uniform(0.05),
    softness: uniform(0.03),
    /** 1 时合成直接使用未模糊的图层（景深关闭、前后对比、法线视图） */
    bypass: uniform(1),
    showMask: uniform(0),
  }
}

export type DofUniforms = ReturnType<typeof createDofUniforms>

/** 在其他坐标和 mip 层级上采样同一张纹理。显式层级可以在非一致控制流中使用。 */
export function sampleLevel(t: TextureNode, uv: Vec2Node, lod: FloatNode | number = 0): Vec4Node {
  return t.sample(uv).level(typeof lod === 'number' ? float(lod) : lod) as unknown as Vec4Node
}

/** 弥散圆半径（当前渲染目标的像素，正值为近景），与 src/focus/dof.ts 的 circleOfConfusion 一致 */
export function cocPx(u: DofUniforms, depth: FloatNode): FloatNode {
  const delta = depth.sub(u.focus)
  return sign(delta).mul(u.aperture).mul(max(abs(delta).sub(u.range), 0)).mul(u.targetLong)
}

/** 立绘某处的归一化逆深度，与 src/focus/dof.ts 的 reliefDepth 一致 */
export function reliefDepthNode(u: DofUniforms, relief: FloatNode): FloatNode {
  const z = u.planeZ.sub(relief.sub(u.reliefReference).mul(u.reliefScale))
  return float(1).div(max(z, MIN_PSEUDO_DEPTH)).sub(DEPTH_SHIFT)
}

interface GatherInput {
  center: Vec4Node
  centerCoc: FloatNode
  /** 采样半径（像素） */
  radius: FloatNode
  /** 样本弥散圆的下限（像素） */
  minSize?: number
  sample: (uv: Vec2Node, lod: FloatNode) => { color: Vec4Node; coc: FloatNode }
}

/** gather 模糊；需在 Fn 中调用。 */
function gather(u: DofUniforms, input: GatherInput): Vec4Node {
  const result = input.center.toVar()
  If(input.radius.greaterThan(0.5), () => {
    const R = input.radius
    // 采样间距约为 R·√(π/N)，用相近尺度的 mip 做预模糊
    const lod = max(log2(R.mul(Math.sqrt(Math.PI / BOKEH_SAMPLES))), 0)
    const half = max(R.mul(0.5 / Math.sqrt(BOKEH_SAMPLES)), 0.5)
    const limit = abs(input.centerCoc).mul(2)
    const color = input.center.toVar()
    const total = float(1).toVar()
    Loop(BOKEH_SAMPLES, ({ i }) => {
      const k = u.kernel.element(i) as unknown as Vec4Node
      const s = input.sample(screenUV.add(k.xy.mul(R).div(u.targetSize)), lod)
      const size = abs(s.coc).toVar()
      If(s.coc.lessThan(input.centerCoc), () => {
        size.assign(min(size, limit))
      })
      if (input.minSize) size.assign(max(size, input.minSize))
      const ring = k.z.mul(R)
      const m = smoothstep(ring.sub(half), ring.add(half), size)
      color.addAssign(mix(color.div(total), s.color, m).mul(k.w))
      total.addAssign(k.w)
    })
    result.assign(color.div(total))
  })
  return result
}

/** 周围 3×3 个统计块的弥散圆最大值 */
function tileRadius(u: DofUniforms, tiles: TextureNode): FloatNode {
  const tile = floor(screenCoordinate.xy.div(TILE))
  let r: FloatNode = float(0)
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) r = max(r, sampleLevel(tiles, tile.add(vec2(dx + 0.5, dy + 0.5)).div(u.tileSize)).r)
  return r
}

/** 背景预处理：rgb = 背景颜色，a = 弥散圆半径 */
export function createPrepPass(u: DofUniforms, background: Vec4Node, depth: FloatNode) {
  return material(vec4(background.rgb, cocPx(u, depth)))
}

/** 每个 16×16 像素块内弥散圆半径绝对值的最大值 */
export function createTilePass(u: DofUniforms, prep: TextureNode) {
  const node = Fn(() => {
    const base = floor(screenCoordinate.xy).mul(TILE)
    const m = float(0).toVar()
    const range = { start: 0, end: TILE, type: 'int' } as const
    Loop(range, range, ({ i, j }) => {
      const uv = base.add(vec2(float(i), float(j))).add(0.5).div(u.targetSize)
      m.assign(max(m, abs(sampleLevel(prep, uv).a)))
    })
    return vec4(m, 0, 0, 1)
  })
  return material(node())
}

/** 背景景深 */
export function createBackgroundDofPass(u: DofUniforms, prep: TextureNode, tiles: TextureNode) {
  const node = Fn(() => {
    const center = sampleLevel(prep, screenUV)
    const radius = max(tileRadius(u, tiles), abs(center.a))
    const out = gather(u, {
      center: vec4(center.rgb, 1),
      centerCoc: center.a,
      radius,
      sample: (uv, lod) => {
        const s = sampleLevel(prep, uv, lod)
        return { color: vec4(s.rgb, 1), coc: s.a }
      },
    })
    return vec4(out.rgb, 1)
  })
  return material(node())
}

/**
 * 立绘深度：r = 归一化逆深度，g = 遮挡强度，b = 弥散圆半径，a = 立绘 alpha。
 * 透明处按立绘平面计算：模糊时立绘的边缘以平面的弥散圆向外扩散；
 * 遮罩在立绘矩形内连续，剪影边缘不会因为遮罩截断而透出立绘。
 */
export function createCharacterDepthPass(u: DofUniforms, input: { alpha: FloatNode; inside: FloatNode; relief: FloatNode; hasRelief: FloatNode; background: FloatNode }) {
  const plane = float(1).div(u.planeZ).sub(DEPTH_SHIFT)
  const depth = select(input.alpha.greaterThan(0.004), mix(plane, reliefDepthNode(u, input.relief), input.hasRelief), plane)
  const delta = input.background.sub(depth)
  const mask = smoothstep(u.tolerance.sub(u.softness.mul(0.5)), u.tolerance.add(u.softness.mul(0.5)), delta).mul(u.occlusion).mul(input.inside)
  return material(vec4(depth, mask, cocPx(u, depth), input.alpha))
}

/** 立绘层景深（预乘 alpha） */
export function createCharacterDofPass(u: DofUniforms, layer: TextureNode, depth: TextureNode) {
  const node = Fn(() =>
    gather(u, {
      center: sampleLevel(layer, screenUV),
      centerCoc: sampleLevel(depth, screenUV).b,
      radius: u.characterCoc.mul(u.targetLong),
      sample: (uv, lod) => ({ color: sampleLevel(layer, uv, lod), coc: sampleLevel(depth, uv, lod).b }),
    }),
  )
  return material(node())
}

/** 遮挡层：比立绘近的背景像素（预乘 alpha = 遮挡强度），按背景的弥散圆模糊 */
export function createOcclusionPass(u: DofUniforms, prep: TextureNode, tiles: TextureNode, depth: TextureNode) {
  const node = Fn(() => {
    const center = sampleLevel(prep, screenUV)
    const m = sampleLevel(depth, screenUV).g
    return gather(u, {
      center: vec4(center.rgb.mul(m), m),
      centerCoc: center.a,
      radius: max(max(tileRadius(u, tiles), abs(center.a)), OCCLUSION_AA),
      minSize: OCCLUSION_AA,
      sample: (uv, lod) => {
        const s = sampleLevel(prep, uv, lod)
        const ms = sampleLevel(depth, uv, lod).g
        return { color: vec4(s.rgb.mul(ms), ms), coc: s.a }
      },
    })
  })
  return material(node())
}

/** 把换算好的参数写入统一量；返回影响背景景深的参数是否变化 */
export function applyFocusParams(u: DofUniforms, params: FocusParams): boolean {
  const changed = u.focus.value !== params.focus || u.aperture.value !== params.aperture || u.range.value !== params.range
  let kernelChanged = false
  params.kernel.forEach(([x, y, r, w], i) => {
    const v = u.kernel.array[i] as THREE.Vector4
    if (v.x !== x || v.y !== y || v.z !== r || v.w !== w) kernelChanged = true
    v.set(x, y, r, w)
  })
  u.focus.value = params.focus
  u.aperture.value = params.aperture
  u.range.value = params.range
  u.planeZ.value = 1 / (params.relief.plane + DEPTH_SHIFT)
  u.reliefReference.value = params.relief.reference
  u.reliefScale.value = params.relief.scale
  u.characterCoc.value = params.characterCoc
  u.occlusion.value = params.occlusion.enabled ? 1 : 0
  u.occlusionMode.value = params.occlusion.mode
  u.tolerance.value = params.occlusion.tolerance
  u.softness.value = Math.max(params.occlusion.softness, 1e-4)
  return changed || kernelChanged
}
