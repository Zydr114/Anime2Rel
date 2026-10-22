/**
 * 雾与尘埃的 TSL 节点（docs/Plan.md §3.7 M8.8c），参数由 src/atmosphere/params.ts 换算。
 * 雾分层加在景深之前：背景预处理 pass 按背景深度、立绘层调整 pass 按立绘深度，公式与 opticalDepth 一致。
 */
import * as THREE from 'three/webgpu'
import { abs, dot, exp, float, Fn, If, length, max, min, mix, select, uniform, vec3 } from 'three/tsl'
import type { AtmosphereParams } from '@/atmosphere/service'
import type { FloatNode, Vec2Node, Vec3Node } from './nodes'

/** docSize：文档尺寸（与摆放共用的统一量） */
export function createAtmosphereUniforms(docSize: Vec2Node) {
  return {
    fog: uniform(0),
    sigma: uniform(0),
    start: uniform(0),
    falloff: uniform(0),
    color: uniform(new THREE.Vector3()),
    /** 天空也加雾时为 1 */
    sky: uniform(0),
    /** 接地点处的透过率 */
    contact: uniform(1),
    /** 深度校准 (a, b, 1/最远距离)：沿光轴的距离 z 满足 1/z = a·d + b */
    scale: uniform(new THREE.Vector3(1, 1, 0)),
    height: uniform(1.6),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    focal: uniform(1),
    docSize,
  }
}

export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>

/** (1 − e^−x) / x，x → 0 时为 1 */
const expRatio = (x: FloatNode): FloatNode => select(abs(x).lessThan(1e-3), float(1).sub(x.mul(0.5)), float(1).sub(exp(x.negate())).div(x))

/** 文档坐标 p 处的视线（相机空间单位方向），以及沿视线的距离与沿光轴的距离之比 */
function viewRay(u: AtmosphereUniforms, p: Vec2Node): { dir: Vec3Node; stretch: FloatNode } {
  const ray = vec3(p.x.sub(u.docSize.x.mul(0.5)), u.docSize.y.mul(0.5).sub(p.y), u.focal.negate())
  const len = length(ray)
  return { dir: ray.div(len), stretch: len.div(u.focal) }
}

/** 归一化逆深度 → 沿光轴的距离（米） */
const axialDistance = (u: AtmosphereUniforms, depth: FloatNode): FloatNode => float(1).div(max(depth.mul(u.scale.x).add(u.scale.y), max(u.scale.z, 1e-6)))

export interface FogInput {
  /** 线性颜色；预乘 alpha 时同时给出 alpha，散射光按 alpha 叠加 */
  color: Vec3Node
  alpha?: FloatNode
  /** 文档坐标、归一化逆深度、天空遮罩 */
  p: Vec2Node
  depth: FloatNode
  sky?: FloatNode
}

/** 加雾：原色 × T + 雾色 × (1 − T)；雾关闭时原样返回 */
export function applyFog(u: AtmosphereUniforms, input: FogInput): Vec3Node {
  return Fn(() => {
    const result = input.color.toVar()
    If(u.fog.greaterThan(0.5), () => {
      const { dir, stretch } = viewRay(u, input.p)
      const distance = axialDistance(u, input.depth).mul(stretch)
      // 光学厚度：浓度随离地高度指数衰减，沿视线积分（低于地面的部分按地面计算）
      const s = min(u.start, distance)
      const rise = dot(dir, u.up)
      const h0 = max(u.height.add(s.mul(rise)), 0)
      const span = distance.sub(s)
      const dh = max(span.mul(rise), h0.negate())
      const tau = u.sigma.mul(span).mul(exp(u.falloff.negate().mul(h0))).mul(expRatio(u.falloff.mul(dh)))
      // 天空默认不加雾
      const amount = input.sky ? float(1).sub(input.sky.mul(float(1).sub(u.sky))) : float(1)
      const fogged = float(1).sub(exp(tau.negate())).mul(amount)
      const alpha = input.alpha ?? float(1)
      result.assign(mix(input.color, u.color.mul(alpha), fogged))
    })
    return result
  })()
}

/** 写入参数；enabled 为 false 时雾不起作用（前后对比中直接贴上去的效果） */
export function applyAtmosphereParams(u: AtmosphereUniforms, params: AtmosphereParams | null, enabled: boolean): void {
  const fog = params?.fog
  u.fog.value = enabled && fog ? 1 : 0
  u.contact.value = enabled && fog ? params.contact : 1
  if (!params) return
  const { view } = params
  u.scale.value.set(view.scale.a, view.scale.b, 1 / view.scale.far)
  u.height.value = view.height
  u.up.value.set(...view.up)
  u.focal.value = view.focal
  if (!fog) return
  u.sigma.value = fog.sigma
  u.start.value = fog.start
  u.falloff.value = fog.falloff
  u.color.value.set(...fog.color)
  u.sky.value = fog.sky ? 1 : 0
}
