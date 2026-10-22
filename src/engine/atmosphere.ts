/**
 * 雾与尘埃的 TSL 节点（docs/Plan.md §3.7 M8.8c），参数由 src/atmosphere/params.ts 换算。
 * 雾分层加在景深之前：背景预处理 pass 按背景深度、立绘层调整 pass 按立绘深度，公式与 opticalDepth 一致。
 */
import * as THREE from 'three/webgpu'
import { abs, atan, dot, exp, float, Fn, If, Loop, length, max, min, mix, mx_fractal_noise_float, pow, select, sqrt, uniform, uniformArray, vec3 } from 'three/tsl'
import type { AtmosphereParams } from '@/atmosphere/service'
import { MAX_LIGHTS } from '@/lighting/model'
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from './nodes'

/** 每个光源占两个 vec4：(类型, 方向或位置)、(颜色 × 强度, 0)；类型 0 为方向光、1 为点光源 */
const LIGHT_VEC4S = 2
type IntNode = THREE.Node<'int'>
/** 雾的 HG 相函数的各向异性参数：前向散射，看向光源的方向最亮 */
export const FOG_PHASE_G = 0.6
/** 点光源光晕的核心半径（相对灯到相机的距离） */
const LAMP_CORE = 0.1
/** 不均匀度沿视线的采样点数 */
const NOISE_SAMPLES = 5

/** docSize：文档尺寸（与摆放共用的统一量） */
export function createAtmosphereUniforms(docSize: Vec2Node) {
  return {
    fog: uniform(0),
    sigma: uniform(0),
    start: uniform(0),
    falloff: uniform(0),
    color: uniform(new THREE.Vector3()),
    /** 光源散射光的强度 */
    light: uniform(0),
    /** 不均匀度与噪声尺寸（米） */
    noise: uniform(0),
    noiseSize: uniform(5),
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
    lightCount: uniform(0, 'int'),
    lights: uniformArray(
      Array.from({ length: MAX_LIGHTS * LIGHT_VEC4S }, () => new THREE.Vector4()),
      'vec4',
    ),
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

/**
 * Henyey-Greenstein 相函数相对于各向同性散射的倍数（4π × HG）。与重光照的量纲一致（辐照度 × 反照率 = 像素值）：
 * 各向同性时，散射光 = 光源颜色 × 强度 × (1 − T)。
 */
export const phase = (cos: FloatNode, g: number): FloatNode => float(1 - g * g).div(pow(max(float(1 + g * g).sub(cos.mul(2 * g)), 1e-4), 1.5))

/** 第 i 个光源的两个 vec4 */
export function lightAt(u: AtmosphereUniforms, i: IntNode): { head: Vec4Node; color: Vec3Node } {
  const base = i.mul(LIGHT_VEC4S)
  return { head: u.lights.element(base) as unknown as Vec4Node, color: (u.lights.element(base.add(1)) as unknown as Vec4Node).xyz }
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
      const tau = u.sigma.mul(span).mul(exp(u.falloff.negate().mul(h0))).mul(expRatio(u.falloff.mul(dh))).toVar()
      // 不均匀度：沿视线取几个点的分形噪声（相机坐标，单位米），按平均值调制光学厚度
      If(u.noise.greaterThan(0), () => {
        let sum: FloatNode = float(0)
        for (let k = 0; k < NOISE_SAMPLES; k++) {
          const q = dir.mul(s.add(span.mul((k + 0.5) / NOISE_SAMPLES))).div(u.noiseSize)
          sum = sum.add(max(float(1).add(mx_fractal_noise_float(q, 3).mul(u.noise.mul(2))), 0))
        }
        tau.mulAssign(sum.div(NOISE_SAMPLES))
      })
      const T = exp(tau.negate())
      // 光源的散射光：方向光按 HG 相函数；点光源沿视线对灯的距离衰减积分（各向同性），灯周围的雾发光
      const scatter = vec3(0).toVar()
      If(u.light.greaterThan(0), () => {
        // 视线上的平均消光系数，用于点光源
        const sigma = tau.div(max(span, 1e-4))
        Loop(u.lightCount, ({ i }) => {
          const { head, color } = lightAt(u, i)
          If(head.x.lessThan(0.5), () => {
            scatter.addAssign(color.mul(phase(dot(dir, head.yzw), FOG_PHASE_G)).mul(float(1).sub(T)))
          }).Else(() => {
            // 视线上离灯最近的点在 t0 处，距离为 h；光晕按 r / √(r² + h²) 衰减，正对灯时为 π × 灯的距离
            const P = head.yzw
            const far = length(P)
            const t0 = dot(P, dir)
            const r = far.mul(LAMP_CORE)
            const c = sqrt(max(r.mul(r).add(max(dot(P, P).sub(t0.mul(t0)), 0)), 1e-6))
            const glow = far.mul(r).div(c).mul(atan(distance.sub(t0).div(c)).sub(atan(s.sub(t0).div(c))))
            const reach = exp(sigma.negate().mul(min(max(t0.sub(s), 0), span)))
            scatter.addAssign(color.mul(sigma.mul(glow).mul(reach)))
          })
        })
      })
      // 天空默认不加雾
      const amount = input.sky ? float(1).sub(input.sky.mul(float(1).sub(u.sky))) : float(1)
      const alpha = input.alpha ?? float(1)
      result.assign(mix(input.color, u.color.mul(alpha), float(1).sub(T).mul(amount)).add(scatter.mul(u.light.mul(amount).mul(alpha))))
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
  const lights = view.lights.slice(0, MAX_LIGHTS)
  u.lightCount.value = lights.length
  const array = u.lights.array as THREE.Vector4[]
  lights.forEach((l, i) => {
    array[i * LIGHT_VEC4S].set(l.type === 'directional' ? 0 : 1, ...l.vector)
    array[i * LIGHT_VEC4S + 1].set(...l.color, 0)
  })
  if (!fog) return
  u.sigma.value = fog.sigma
  u.start.value = fog.start
  u.falloff.value = fog.falloff
  u.color.value.set(...fog.color)
  u.light.value = fog.light
  u.noise.value = fog.noise
  u.noiseSize.value = fog.noiseSize
  u.sky.value = fog.sky ? 1 : 0
}
