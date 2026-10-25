/**
 * 投影的阴影贴图（docs/Plan.md M8.8d）的 TSL 实现，几何与参数见 src/fusion/shadowMap.ts、src/fusion/shadow.ts。
 *
 * 生成：每个纹素沿光线穿过立绘占据体积的包围盒，等间隔步进；每一步投影回文档像素、换算到立绘纹理坐标，
 * 判断是否在 [正面, 正面 + 身体厚度] 内。立绘的 alpha 取与步长相当的 mip 级别，细的部分变淡而不会漏判。
 * 纹素记录覆盖率 C 与第一次被挡处沿光线的距离 s，存为 (C, C·s)，生成 mipmap 后按受影点到遮挡点的距离选取级别做半影。
 * 贴图只依赖立绘、摆放和主光源，与渲染目标无关：预览、整幅导出、分块导出用同一张。
 */
import * as THREE from 'three/webgpu'
import { Break, Fn, If, Loop, abs, dot, float, length, log2, max, min, normalize, screenUV, select, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl'
import type { ShadowMapInfo } from '@/fusion/shadow'
import { sampleLevel } from './dof'
import { material, type FloatNode, type Vec3Node, type Vec4Node } from './nodes'
import type { Placement } from './passes'

type TextureNode = THREE.TextureNode
type Vec2Node = THREE.Node<'vec2'>

/** 每个纹素沿光线的步数 */
export const SHADOW_MAP_STEPS = 64
/** 估计遮挡距离时所用 mip 级别的纹素大小（相对人物高度） */
const COARSE = 0.03

export function createShadowMapUniforms() {
  const v3 = () => uniform(new THREE.Vector3())
  return {
    point: uniform(0),
    light: v3(),
    e1: uniform(new THREE.Vector3(1, 0, 0)),
    e2: uniform(new THREE.Vector3(0, 1, 0)),
    forward: uniform(new THREE.Vector3(0, 0, -1)),
    rect: uniform(new THREE.Vector4(0, 0, 1, 1)),
    range: uniform(new THREE.Vector2(0, 1)),
    boxMin: v3(),
    boxMax: v3(),
    planeZ: uniform(1),
    relief: uniform(0),
    reference: uniform(0.5),
    body: uniform(0.25),
    height: uniform(1.6),
    focal: uniform(1),
    /** 贴图边长（纹素） */
    size: uniform(1),
    /** 单位遮挡距离的半影半径，与平面方式的柔和度换算相同 */
    softness: uniform(0.1),
    /** 立绘自身的投影强度；没有贴图时为 0 */
    self: uniform(0),
    /** 主光源在重光照光源中的序号，−1 为没有 */
    lightIndex: uniform(-1),
  }
}

export type ShadowMapUniforms = ReturnType<typeof createShadowMapUniforms>

/** 立绘纹理坐标处的起伏 r：与立绘深度相同的计算，sample 为该处立绘的采样结果（引导图） */
export type ReliefAt = (uv: Vec2Node, sample: Vec4Node) => FloatNode

/**
 * 生成阴影贴图的材质，渲染到边长为 size 的正方形目标上（带 mipmap）。
 * @param character 立绘纹理（立绘纹理坐标，带 mipmap）
 */
export function createShadowMapPass(u: ShadowMapUniforms, placement: Placement, character: TextureNode, reliefAt: ReliefAt) {
  const pu = placement.uniforms
  const node = Fn(() => {
    const a = u.rect.x.add(screenUV.x.mul(u.rect.z))
    const b = u.rect.y.add(screenUV.y.mul(u.rect.w))
    const lateral = u.e1.mul(a).add(u.e2.mul(b))
    const isPoint = u.point.greaterThan(0.5)
    const origin = select(isPoint, u.light, lateral)
    const dir = select(isPoint, normalize(u.forward.add(lateral)), u.forward)

    // 光线与包围盒的交段；方向光的起点在 s = 0 的平面上，参数 t 就是 s
    const nonZero = (v: FloatNode) => select(abs(v).lessThan(1e-6), float(1e-6), v)
    const safe = vec3(nonZero(dir.x), nonZero(dir.y), nonZero(dir.z))
    const ta = u.boxMin.sub(origin).div(safe)
    const tb = u.boxMax.sub(origin).div(safe)
    const near = min(ta, tb)
    const far = max(ta, tb)
    const t0 = max(max(near.x, near.y), max(near.z, select(isPoint, float(0), float(-1e9))))
    const t1 = min(min(far.x, far.y), far.z)
    const stepLen = max(t1.sub(t0), 0).div(SHADOW_MAP_STEPS)
    // 一个纹素在光源空间中的宽度（米），灯的贴图坐标是正切，按距离换算
    const texel = u.rect.z.div(u.size)

    const coverage = float(0).toVar()
    const hit = float(0).toVar()
    If(t1.greaterThan(t0), () => {
      Loop(SHADOW_MAP_STEPS, ({ i }) => {
        const t = t0.add(float(i).add(0.5).mul(stepLen))
        const x = origin.add(dir.mul(t))
        const dist = x.z.negate()
        const q = vec2(pu.docSize.x.mul(0.5).add(x.x.div(max(dist, 1e-4)).mul(u.focal)), pu.docSize.y.mul(0.5).sub(x.y.div(max(dist, 1e-4)).mul(u.focal)))
        const uv = placement.toCharUV(q)
        const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1)).mul(step(1e-3, dist))
        // 采样的范围取步长与纹素宽度中较大的一个，换算到立绘纹素
        const footprint = max(stepLen, texel.mul(select(isPoint, t, float(1)))).mul(u.focal).div(max(dist, 1e-4))
        const sample = sampleLevel(character, uv, log2(max(footprint.div(pu.charScale), 1)))
        const alpha = sample.a.mul(inside)
        If(alpha.greaterThan(0.02), () => {
          const front = u.planeZ.sub(reliefAt(uv, sample).sub(u.reference).mul(u.relief))
          const back = front.add(u.body)
          // 前后边界按半个步长柔化，光线擦过时不会忽有忽无
          const soft = max(stepLen.mul(0.5), u.height.mul(0.005))
          const within = smoothstep(front.sub(soft), front.add(soft), dist).mul(float(1).sub(smoothstep(back.sub(soft), back.add(soft), dist)))
          const occ = smoothstep(0.3, 0.7, alpha).mul(within)
          If(occ.greaterThan(coverage), () => {
            coverage.assign(occ)
            hit.assign(t)
          })
        })
        If(coverage.greaterThan(0.99), () => {
          Break()
        })
      })
    })
    return vec4(coverage, coverage.mul(hit.sub(u.range.x).div(u.range.y)), 0, 1)
  })
  return material(node())
}

/**
 * 受影点 x（相机空间，米）被立绘挡住主光源的比例 [0,1]。
 * 先在较粗的 mip 上估计遮挡点的平均距离，按它与受影点的距离定半影半径，再在相应的 mip 上取覆盖率；
 * 比遮挡点更靠近光源（s 更小）的受影点不受影响。bias 为米。
 */
export function shadowLookup(u: ShadowMapUniforms, map: TextureNode, x: Vec3Node, bias: FloatNode): FloatNode {
  const isPoint = u.point.greaterThan(0.5)
  const y = x.sub(u.light)
  const depth = max(dot(y, u.forward), 1e-6)
  const a = select(isPoint, dot(y, u.e1).div(depth), dot(x, u.e1))
  const b = select(isPoint, dot(y, u.e2).div(depth), dot(x, u.e2))
  const s = select(isPoint, length(y), dot(x, u.forward))
  const uv = vec2(a.sub(u.rect.x).div(u.rect.z), b.sub(u.rect.y).div(u.rect.w))
  const sn = s.sub(u.range.x).div(u.range.y)
  const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
  // 贴图坐标 1 对应的米数：灯按受影点的距离换算
  const metres = u.rect.z.mul(select(isPoint, s, float(1)))

  const coarse = sampleLevel(map, uv, log2(max(u.height.mul(COARSE).div(metres).mul(u.size), 1)))
  const blocker0 = coarse.g.div(max(coarse.r, 1e-4))
  const radius = max(sn.sub(blocker0), 0).mul(u.range.y).mul(u.softness).div(metres)
  const fine = sampleLevel(map, uv, log2(max(radius.mul(u.size), 1)))
  const blocker = fine.g.div(max(fine.r, 1e-4))
  const offset = bias.div(u.range.y)
  return fine.r.mul(smoothstep(blocker.add(offset), blocker.add(offset.mul(2)), sn)).mul(inside).mul(step(1e-4, coarse.r))
}

/** 贴图边长（u.size）在渲染贴图时由引擎设置 */
export function applyShadowMapParams(u: ShadowMapUniforms, map: ShadowMapInfo | null, softness: number, focal: number): void {
  u.self.value = map?.self ?? 0
  u.lightIndex.value = map ? map.lightIndex : -1
  if (!map) return
  u.point.value = map.point ? 1 : 0
  u.light.value.set(...map.light)
  u.e1.value.set(...map.e1)
  u.e2.value.set(...map.e2)
  u.forward.value.set(...map.forward)
  u.rect.value.set(...map.rect)
  u.range.value.set(...map.range)
  u.boxMin.value.set(...map.boxMin)
  u.boxMax.value.set(...map.boxMax)
  u.planeZ.value = map.planeZ
  u.relief.value = map.relief
  u.reference.value = map.reference
  u.body.value = map.body
  u.height.value = map.height
  u.focal.value = focal
  u.softness.value = 0.02 + 0.25 * softness
}
