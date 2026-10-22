/**
 * 雾与尘埃的 TSL 节点（docs/Plan.md §3.7 M8.8c），参数由 src/atmosphere/params.ts 换算。
 * 雾分层加在景深之前：背景预处理 pass 按背景深度、立绘层调整 pass 按立绘深度，公式与 opticalDepth 一致。
 */
import * as THREE from 'three/webgpu'
import { abs, atan, cos, dot, exp, float, floor, Fn, If, Loop, length, max, min, mix, mod, mx_fractal_noise_float, pow, saturate, select, smoothstep, sqrt, uint, uniform, uniformArray, vec2, vec3 } from 'three/tsl'
import { dustLayers, DUST_LAYERS } from '@/atmosphere/params'
import type { AtmosphereParams } from '@/atmosphere/service'
import { MAX_LIGHTS } from '@/lighting/model'
import { cocPx, type DofUniforms } from './dof'
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from './nodes'

/** 每个光源占两个 vec4：(类型, 方向或位置)、(颜色 × 强度, 0)；类型 0 为方向光、1 为点光源 */
const LIGHT_VEC4S = 2
type IntNode = THREE.Node<'int'>
type UintNode = THREE.Node<'uint'>
/** 雾的 HG 相函数的各向异性参数：前向散射，看向光源的方向最亮 */
export const FOG_PHASE_G = 0.6
/** 尘埃的 HG 相函数参数：比雾更偏前向，逆光时明显 */
export const DUST_PHASE_G = 0.75
/** 每层两个 vec4：(基础单元, 放大倍数, 查看范围, 0)、(近处逆距离, 远处逆距离, 0, 0) */
const LAYER_VEC4S = 2
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
    dust: uniform(0),
    dustBrightness: uniform(0),
    /** 颗粒半径（米）、随机种子 */
    dustRadius: uniform(0),
    dustSeed: uniform(0),
    /** 散景形状：叶片数（0 为圆形）、旋转、面积相对外接圆的比例 */
    blades: uniform(0),
    bladeRotation: uniform(0),
    bladeArea: uniform(1),
    dustLayers: uniformArray(
      Array.from({ length: DUST_LAYERS * LAYER_VEC4S }, () => new THREE.Vector4()),
      'vec4',
    ),
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

/** 带名字的循环：嵌套时循环变量要用不同的名字（循环体中的表达式按名字引用循环变量）。three 的类型定义里没有 name */
function loop(name: string, start: number | IntNode, end: number | IntNode, body: (i: IntNode) => void, inclusive = false): void {
  const param = { start, end, condition: inclusive ? '<=' : '<', name, type: 'int' }
  Loop(param as unknown as Parameters<typeof Loop>[0], ((inputs: Record<string, IntNode>) => body(inputs[name])) as never)
}

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

/** 视线上从起始距离到 distance（米）的光学厚度（不含不均匀度），与 src/atmosphere/params.ts 的 opticalDepth 一致 */
function opticalDepth(u: AtmosphereUniforms, dir: Vec3Node, distance: FloatNode): { tau: FloatNode; start: FloatNode; span: FloatNode } {
  // 浓度随离地高度指数衰减，沿视线积分（低于地面的部分按地面计算）
  const s = min(u.start, distance)
  const rise = dot(dir, u.up)
  const h0 = max(u.height.add(s.mul(rise)), 0)
  const span = distance.sub(s)
  const dh = max(span.mul(rise), h0.negate())
  return { tau: u.sigma.mul(span).mul(exp(u.falloff.negate().mul(h0))).mul(expRatio(u.falloff.mul(dh))), start: s, span }
}

/** 加雾：原色 × T + 雾色 × (1 − T)；雾关闭时原样返回 */
export function applyFog(u: AtmosphereUniforms, input: FogInput): Vec3Node {
  return Fn(() => {
    const result = input.color.toVar()
    If(u.fog.greaterThan(0.5), () => {
      const { dir, stretch } = viewRay(u, input.p)
      const distance = axialDistance(u, input.depth).mul(stretch)
      const optical = opticalDepth(u, dir, distance)
      const { start: s, span } = optical
      const tau = optical.tau.toVar()
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
        loop('light', 0, u.lightCount, (light) => {
          const { head, color } = lightAt(u, light)
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

/** PCG 整数哈希 */
const pcg = (v: UintNode): UintNode => {
  const state = v.mul(747796405).add(2891336453)
  const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737)
  return word.shiftRight(22).bitXor(word)
}
const toUnit = (h: UintNode): FloatNode => h.toFloat().mul(1 / 2 ** 32)
/** 单元坐标可以为负，转成无符号整数前先平移 */
const CELL_OFFSET = 1 << 20

export interface DustInput {
  /** 文档坐标 */
  p: Vec2Node
  /** 该像素合成后的归一化逆深度：立绘可见处为立绘深度，其余为背景深度 */
  surface: FloatNode
}

/**
 * 尘埃（线性 HDR，加在合成结果上）：逐层查看周围的网格单元，每个颗粒按大小与弥散圆中较大的一个画成散景圆盘，
 * 亮度按面积降低；颗粒被比它近的景物挡住。亮度 = 光源颜色 × 强度 × HG 相函数 × 雾的透过率，不加环境光。
 */
export function dustLight(u: AtmosphereUniforms, dof: DofUniforms, input: DustInput): Vec3Node {
  return Fn(() => {
    const total = vec3(0).toVar()
    If(u.dust.greaterThan(0.5), () => {
      const { p } = input
      const { dir, stretch } = viewRay(u, p)
      // 输出图像的一个像素对应的文档像素：圆盘边缘按它抗锯齿，小于它的颗粒按面积变暗
      const pixel = max(u.docSize.x, u.docSize.y).div(dof.targetLong)
      const minRadius = pixel.mul(0.5)
      // 方向光与层无关
      const sun = vec3(0).toVar()
      loop('light', 0, u.lightCount, (light) => {
        const { head, color } = lightAt(u, light)
        If(head.x.lessThan(0.5), () => {
          sun.addAssign(color.mul(phase(dot(dir, head.yzw), DUST_PHASE_G)))
        })
      })
      loop('layer', 0, DUST_LAYERS, (k) => {
        const a = u.dustLayers.element(k.mul(LAYER_VEC4S)) as unknown as Vec4Node
        const b = u.dustLayers.element(k.mul(LAYER_VEC4S).add(1)) as unknown as Vec4Node
        const cell = a.x
        const scale = a.y
        const reach = a.z.toInt()
        const coarse = cell.mul(scale)
        // 该层中心处的光照与雾的透过率（颗粒离像素很近，按像素的视线计算）
        const distance = float(2).div(b.x.add(b.y)).mul(stretch)
        const X = dir.mul(distance)
        const light = sun.toVar()
        loop('lamp', 0, u.lightCount, (lamp) => {
          const { head, color } = lightAt(u, lamp)
          If(head.x.greaterThan(0.5), () => {
            const toLamp = head.yzw.sub(X)
            const d = length(toLamp)
            const k = float(1).div(float(1).add(d.div(max(length(X), 1e-4)).pow(2)))
            light.addAssign(color.mul(phase(dot(dir, toLamp.div(max(d, 1e-4))), DUST_PHASE_G)).mul(k))
          })
        })
        const T = select(u.fog.greaterThan(0.5), exp(opticalDepth(u, dir, distance).tau.negate()), float(1))
        const layerSeed = pcg(u.dustSeed.toUint().mul(DUST_LAYERS).add(k.toUint()))
        const base = floor(p.div(coarse))
        const sum = float(0).toVar()
        loop('dy', reach.negate(), reach, (dy) => loop('dx', reach.negate(), reach, (dx) => {
          const c = base.add(vec2(dx.toFloat(), dy.toFloat()))
          const cx = c.x.add(CELL_OFFSET).toUint()
          const cy = c.y.add(CELL_OFFSET).toUint()
          // 放大的单元只保留其中一个基础单元的颗粒
          const hc = pcg(cx.add(pcg(cy.add(layerSeed))))
          const pick = floor(vec2(toUnit(hc), toUnit(pcg(hc))).mul(scale))
          const fine = c.mul(scale).add(pick)
          const h = pcg(fine.x.add(CELL_OFFSET).toUint().add(pcg(fine.y.add(CELL_OFFSET).toUint().add(layerSeed.bitXor(uint(0x9e3779b9))))))
          const h2 = pcg(h)
          const h3 = pcg(h2)
          const pos = fine.add(vec2(toUnit(h), toUnit(h2))).mul(cell)
          const w = mix(b.x, b.y, toUnit(h3))
          const depth = w.sub(u.scale.y).div(u.scale.x)
          const size = u.dustRadius.mul(u.focal).mul(w)
          const R = min(max(max(size, abs(cocPx(dof, depth)).mul(pixel)), minRadius), coarse.mul(reach.toFloat()))
          // 散景形状：与景深的核相同的正多边形（外接圆半径为 R）
          const delta = pos.sub(p)
          const sector = float(2 * Math.PI).div(max(u.blades, 3))
          const angle = mod(atan(delta.y, delta.x).sub(u.bladeRotation), sector)
          const edge = select(u.blades.greaterThan(2.5), cos(sector.mul(0.5)).div(cos(angle.sub(sector.mul(0.5)))), float(1))
          const coverage = saturate(R.mul(edge).sub(length(delta)).div(pixel).add(0.5))
          const visible = smoothstep(-0.01, 0.01, depth.sub(input.surface))
          // 总光量 ∝ 颗粒面积 × 放大倍数²，摊到圆盘面积上
          sum.addAssign(size.mul(size).mul(scale.mul(scale)).div(R.mul(R).mul(u.bladeArea)).mul(coverage).mul(visible))
        }, true), true)
        total.addAssign(light.mul(T).mul(sum))
      })
      total.mulAssign(u.dustBrightness)
    })
    return total
  })()
}

/** 多边形面积相对外接圆的比例 */
const polygonArea = (blades: number) => (blades >= 3 ? (blades * Math.sin((2 * Math.PI) / blades)) / (2 * Math.PI) : 1)

/**
 * 写入参数。enabled 为雾与尘埃是否生效（前后对比中直接贴上去的效果不显示）；
 * focus 为景深参数（尘埃的散景，null 时没有散景）。
 */
export function applyAtmosphereParams(
  u: AtmosphereUniforms,
  params: AtmosphereParams | null,
  enabled: { fog: boolean; dust: boolean },
  focus: { focus: number; aperture: number; range: number } | null,
): void {
  const fog = enabled.fog ? params?.fog : null
  const dust = enabled.dust ? params?.dust : null
  u.fog.value = fog ? 1 : 0
  u.contact.value = fog ? params!.contact : 1
  u.dust.value = dust ? 1 : 0
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
  if (fog) {
    u.sigma.value = fog.sigma
    u.start.value = fog.start
    u.falloff.value = fog.falloff
    u.color.value.set(...fog.color)
    u.light.value = fog.light
    u.noise.value = fog.noise
    u.noiseSize.value = fog.noiseSize
    u.sky.value = fog.sky ? 1 : 0
  }
  if (dust) {
    u.dustBrightness.value = dust.brightness
    u.dustRadius.value = dust.radius
    u.dustSeed.value = dust.seed
    u.blades.value = dust.blades >= 3 ? dust.blades : 0
    u.bladeRotation.value = dust.rotation
    u.bladeArea.value = polygonArea(dust.blades)
    const layers = u.dustLayers.array as THREE.Vector4[]
    dustLayers(dust, view, focus ?? { focus: 0, aperture: 0, range: 0 }).forEach((l, k) => {
      layers[k * LAYER_VEC4S].set(l.cell, l.scale, l.reach, 0)
      layers[k * LAYER_VEC4S + 1].set(l.near, l.far, 0, 0)
    })
  }
}
