/**
 * 镜头光晕（docs/Plan.md §3.7 M8.2），元素参数见 src/grade/flare.ts。
 * 可见度 pass 在光源周围取样，结果写入 1×1 的渲染目标；终处理 pass 逐像素解析计算各元素，乘以可见度后叠加。
 * 坐标以画面长边为单位（uv · aspect），分块导出时按输出图像的 uv 计算，没有接缝；可见度沿用代理渲染的结果。
 */
import { abs, atan, cos, exp, float, floor, fract, hash, If, int, length, Loop, max, mix, pow, saturate, sin, smoothstep, sqrt, step, vec2, vec3, vec4 } from 'three/tsl'
import type * as THREE from 'three/webgpu'
import { FLARE_STRIDE } from '@/grade/flare'
import { sampleAt, type FloatNode, type TextureNode, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'
import type { PostUniforms } from './post'

/** 每个元素占的 vec4 个数 */
export const FLARE_VEC4S = FLARE_STRIDE / 4
/** 可见度的采样数与采样范围（半径，相对长边） */
const VISIBILITY_SAMPLES = 24
const VISIBILITY_RADIUS = 0.012
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** 元素在半径的这个倍数之外没有贡献，跳过计算 */
const ELEMENT_REACH = 1.2
const TAU = Math.PI * 2

/**
 * 光晕的可见度：光源周围的圆盘内取样，被立绘挡住、或（方向光）落在非天空处的比例越大越暗。
 * 画面外的采样点不计；全部在画面外时可见度为 1，由移出画面的淡出处理。
 * character 为立绘层（需有 mipmap），skyMap 为背景的深度辅助图（g 为天空），hasSky 为 0 时不可用。
 */
export function flareVisibility(u: PostUniforms, character: TextureNode, skyMap: TextureNode, hasSky: FloatNode): Vec4Node {
  const lod = max(u.sourceLod, 0)
  const skyWeight = u.flareSky.mul(hasSky)
  let total: FloatNode = float(0)
  let hidden: FloatNode = float(0)
  for (let i = 0; i < VISIBILITY_SAMPLES; i++) {
    const rho = VISIBILITY_RADIUS * Math.sqrt((i + 0.5) / VISIBILITY_SAMPLES)
    const phi = i * GOLDEN_ANGLE
    const q = u.flareLight.add(vec2(rho * Math.cos(phi), rho * Math.sin(phi)).div(u.aspect))
    const inFrame = step(0, q.x).mul(step(q.x, 1)).mul(step(0, q.y)).mul(step(q.y, 1))
    const occluded = max(sampleAt(character, q, lod).a, skyWeight.mul(float(1).sub(sampleAt(skyMap, q, float(0)).g)))
    total = total.add(inFrame)
    hidden = hidden.add(occluded.mul(inFrame))
  }
  return vec4(vec3(float(1).sub(hidden.div(max(total, 1e-4)))), 1)
}

/** 旋转 −angle：把元素的方向转到 x 轴上 */
function unrotate(v: Vec2Node, angle: FloatNode): Vec2Node {
  const c = cos(angle)
  const s = sin(angle)
  return vec2(v.x.mul(c).add(v.y.mul(s)), v.y.mul(c).sub(v.x.mul(s)))
}

/** [0,1) 的随机数，key 为非负整数值 */
const random = (key: FloatNode) => hash(key.add(0.5))

/** 色相 [0,1) → 饱和的颜色（0 为红） */
function hueColor(h: FloatNode): Vec3Node {
  return saturate(abs(fract(vec3(h).add(vec3(1, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1))
}

/** 光辉：光源处的径向辉光，柔和度越大越宽 */
function glow(r: FloatNode, soft: FloatNode): FloatNode {
  const a = mix(0.05, 0.5, soft)
  return float(1).div(r.div(a).pow(2).add(1)).mul(saturate(float(1).sub(r)).pow(2))
}

/** 光环：半径处的细环 */
function ring(r: FloatNode, soft: FloatNode): FloatNode {
  const x = r.sub(1).div(mix(0.03, 0.4, soft))
  return exp(x.mul(x).negate())
}

/** 星芒：count 条射线，长度随种子变化，宽度随距离收窄 */
function streaks(r: FloatNode, theta: FloatNode, soft: FloatNode, count: FloatNode, seed: FloatNode): FloatNode {
  const n = max(count, 1)
  const seg = float(TAU).div(n)
  const j = floor(theta.div(seg).add(0.5))
  const index = j.sub(n.mul(floor(j.add(0.5).div(n))))
  const delta = theta.sub(j.mul(seg))
  const len = mix(0.35, 1, random(seed.mul(64).add(index)))
  const t = saturate(r.div(len))
  const width = mix(0.004, 0.04, soft).mul(float(1).sub(t)).add(1e-4)
  const d = r.mul(abs(sin(delta))).div(width)
  return exp(d.mul(d).negate()).mul(float(1).sub(t).pow(2))
}

/** 横向拉丝：沿旋转方向的细长光条，中间亮、两端渐隐 */
function anamorphic(q: Vec2Node, soft: FloatNode): FloatNode {
  return exp(abs(q.y).div(mix(0.004, 0.06, soft)).negate()).mul(pow(saturate(float(1).sub(abs(q.x))), 1.5))
}

/** 鬼影：圆形（sides < 3）或正多边形光斑，边缘略亮，柔和度控制边缘的过渡 */
function ghost(r: FloatNode, theta: FloatNode, soft: FloatNode, sides: FloatNode): FloatNode {
  const rp = r.toVar()
  If(sides.greaterThan(2.5), () => {
    const seg = float(TAU).div(sides)
    const a = theta.sub(seg.mul(floor(theta.div(seg)))).sub(seg.mul(0.5))
    rp.assign(r.mul(cos(a)).div(cos(float(Math.PI).div(sides))))
  })
  const e = mix(0.03, 0.6, soft)
  return float(1).sub(smoothstep(float(1).sub(e), 1, rp)).mul(mix(0.6, 1, rp.mul(rp)))
}

/** 彩虹环：环带从内到外由紫到红，dispersion 为 0 时是白色的环 */
function rainbow(r: FloatNode, soft: FloatNode, dispersion: FloatNode): { f: FloatNode; tint: Vec3Node } {
  const x = r.sub(1).div(mix(0.06, 0.4, soft))
  const t = saturate(x.mul(0.5).add(0.5))
  return { f: exp(x.mul(x).negate()), tint: mix(vec3(1), hueColor(float(1).sub(t).mul(0.75)), dispersion) }
}

/** 闪点：半径内随机分布的十字小星，大小、亮度随种子变化 */
function sparkles(q: Vec2Node, rotation: FloatNode, soft: FloatNode, count: FloatNode, seed: FloatNode): FloatNode {
  const sum = float(0).toVar()
  // 嵌套的循环需要另起变量名，否则与外层的 i 同名（类型声明中没有 name）
  const range = { start: int(0), end: int(count), type: 'int', name: 's' } as unknown as Parameters<typeof Loop>[0]
  Loop(range, (inputs) => {
    const key = seed.mul(64).add(float((inputs as unknown as { s: THREE.Node<'int'> }).s).mul(4))
    const angle = random(key).mul(TAU)
    const rho = sqrt(random(key.add(1))).mul(0.85)
    const size = mix(0.05, 0.14, random(key.add(2)))
    const brightness = mix(0.3, 1, random(key.add(3)))
    const o = unrotate(q.sub(vec2(cos(angle), sin(angle)).mul(rho)), rotation)
    const d = length(o)
    const core = exp(d.div(size.mul(0.25)).pow(2).negate())
    const w = size.mul(mix(0.03, 0.12, soft))
    const arms = exp(abs(o.y).div(w).negate())
      .mul(saturate(float(1).sub(abs(o.x).div(size))))
      .add(exp(abs(o.x).div(w).negate()).mul(saturate(float(1).sub(abs(o.y).div(size)))))
    sum.addAssign(core.mul(0.6).add(arms.mul(0.4)).mul(brightness))
  })
  return sum
}

/** 光晕在 uv（输出图像 UV）处的颜色（线性），需在 Fn 中调用 */
export function flareColor(u: PostUniforms, uv: Vec2Node): Vec3Node {
  const p = uv.mul(u.aspect)
  const light = u.flareLight.mul(u.aspect)
  const center = u.aspect.mul(0.5)
  const sum = vec3(0).toVar()
  Loop(u.flareCount, ({ i }) => {
    const base = i.mul(FLARE_VEC4S)
    const element = (k: number) => u.flareParams.element(base.add(k)) as unknown as Vec4Node
    const a = element(0)
    const b = element(1)
    const c = element(2)
    const radius = max(a.z, 1e-4)
    // 元素中心在光源与画面中心的连线上，坐标以元素半径为单位
    const q = p.sub(light.add(center.sub(light).mul(a.y))).div(radius)
    const r = length(q)
    If(r.lessThan(ELEMENT_REACH).and(a.w.greaterThan(0)), () => {
      const type = a.x
      const soft = c.x
      const rotation = b.w
      const theta = atan(q.y, q.x).sub(rotation)
      const f = float(0).toVar()
      const tint = vec3(1).toVar()
      If(type.lessThan(0.5), () => {
        f.assign(glow(r, soft))
      })
        .ElseIf(type.lessThan(1.5), () => {
          f.assign(ring(r, soft))
        })
        .ElseIf(type.lessThan(2.5), () => {
          f.assign(streaks(r, theta, soft, c.z, element(3).x))
        })
        .ElseIf(type.lessThan(3.5), () => {
          f.assign(anamorphic(unrotate(q, rotation), soft))
        })
        .ElseIf(type.lessThan(4.5), () => {
          f.assign(ghost(r, theta, soft, c.y))
        })
        .ElseIf(type.lessThan(5.5), () => {
          const rb = rainbow(r, soft, c.w)
          f.assign(rb.f)
          tint.assign(rb.tint)
        })
        .Else(() => {
          f.assign(sparkles(q, rotation, soft, c.z, element(3).x))
        })
      sum.addAssign(b.rgb.mul(tint).mul(f.mul(a.w)))
    })
  })
  return sum
}
