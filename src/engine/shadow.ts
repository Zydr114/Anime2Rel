/**
 * 站立阴影的 TSL 材质：输出背景的颜色倍率（rgb），参数由 src/fusion/shadow.ts 换算。
 * 所有位置都在文档像素空间计算，预览和导出的分辨率不影响结果。
 *
 * 两种投影方式（M8.8d）：平面的解析做法（射线与地面求交）与贴合表面的屏幕空间步进。
 * 步进方式要读取立绘深度，因此阴影 pass 排在立绘深度之后、立绘着色之前（Engine.renderDocument）。
 */
import * as THREE from 'three/webgpu'
import { Loop, abs, cos, dot, float, length, log2, max, min, mix, pow, select, sin, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { DEPTH_SHIFT } from '@/focus/dof'
import type { ShadowParams } from '@/fusion/shadow'
import { SURFACE_STEPS } from '@/fusion/shadow'
import { sampleLevel } from './dof'
import { material, type FloatNode, type Vec3Node } from './nodes'
import type { Placement } from './passes'

type TextureNode = THREE.TextureNode

/** 贴合表面的基础容差（米）：深度误差与步长的补偿，避免表面自身的深度噪声造成自遮挡 */
const SURFACE_BIAS = 0.03
/** 容差随步长增加的比例 */
const SURFACE_BIAS_STEP = 0.3

export function createShadowUniforms() {
  return {
    /** 0 时合成不使用阴影（阴影关闭、前后对比、法线视图） */
    enabled: uniform(0),
    ground: uniform(new THREE.Vector2()),
    groundZ: uniform(1),
    /** 深度校准 1/z = a·d + b 的 a、b 与最远距离的倒数 */
    depthScale: uniform(new THREE.Vector3(1, DEPTH_SHIFT, 0)),
    focal: uniform(1),
    normal: uniform(new THREE.Vector3(0, 1, 0)),
    contactStrength: uniform(0),
    contactCenter: uniform(new THREE.Vector2()),
    contactDir: uniform(new THREE.Vector2(1, 0)),
    contactAxes: uniform(new THREE.Vector2(1, 1)),
    contactSoftness: uniform(0.5),
    contactTint: uniform(new THREE.Vector3(1, 1, 1)),
    castStrength: uniform(0),
    along: uniform(new THREE.Vector3(0, 0, -1)),
    lateral: uniform(new THREE.Vector3(1, 0, 0)),
    tanElevation: uniform(1),
    castSoftness: uniform(0.3),
    castTint: uniform(new THREE.Vector3(1, 1, 1)),
    /** 贴合表面：0 方向光（surfaceLight 为指向光源的单位向量），1 点光源（为相机空间位置） */
    surfaceType: uniform(0),
    surfaceLight: uniform(new THREE.Vector3(0, 1, 0)),
    /** 立绘厚度、第一步的长度与步长比（米） */
    surfaceThickness: uniform(0.1),
    surfaceFirst: uniform(0.02),
    surfaceRatio: uniform(1.2),
    /** 步进区域的裁剪矩形（文档像素）：x0、y0、x1、y1 */
    cullRect: uniform(new THREE.Vector4(0, 0, 1e6, 1e6)),
  }
}

export type ShadowUniforms = ReturnType<typeof createShadowUniforms>

/**
 * @param character 立绘纹理（立绘 UV，带 mipmap），投影按受影点到遮挡点的距离选用 mip 做半影模糊
 * @param background 背景深度与天空遮罩：阴影只落在与地面平面深度一致、不是天空的地方
 * @param characterDepth 立绘深度（文档像素，r 为归一化逆深度，a 为 alpha）：贴合表面用它判断遮挡
 * @param method 平面（解析求交，与 M8.8c 一致）或贴合表面（屏幕空间步进）
 */
export function createShadowPass(
  u: ShadowUniforms,
  placement: Placement,
  character: TextureNode,
  background: { depth: FloatNode; sky: FloatNode },
  characterDepth: TextureNode,
  method: 'plane' | 'surface',
) {
  const pu = placement.uniforms
  const p = placement.p
  const half = pu.docSize.mul(0.5)

  // 接触阴影：以脚部为中心、与地平线平行的椭圆
  const d = p.sub(u.contactCenter)
  const r = length(vec2(dot(d, u.contactDir), dot(d, vec2(u.contactDir.y.negate(), u.contactDir.x))).div(u.contactAxes))
  const contact = float(1).sub(smoothstep(float(1).sub(mix(0.25, 1, u.contactSoftness)), 1, r))

  // 当前像素的视线（相机空间，z 为 -1，即沿光轴的距离 t）
  const ray = vec3(p.x.sub(half.x).div(u.focal), half.y.sub(p.y).div(u.focal), -1)
  const inverseDepth = background.depth.mul(u.depthScale.x).add(u.depthScale.y)
  const zBackground = float(1).div(max(inverseDepth, max(u.depthScale.z, 1e-6)))
  const notSky = float(1).sub(background.sky)

  // 当前像素的视线与地面平面的交点；接触阴影只落在与地面平面深度一致的地方
  const g3 = vec3(u.ground.x.sub(half.x).div(u.focal).mul(u.groundZ), half.y.sub(u.ground.y).div(u.focal).mul(u.groundZ), u.groundZ.negate())
  const denom = dot(u.normal, ray)
  const t = dot(u.normal, g3).div(min(denom, -1e-5))
  const hit = step(denom, -1e-5).mul(step(0, t))
  const onGround = float(1).sub(smoothstep(0.2, 0.45, abs(zBackground.sub(t)).div(max(t, 1e-4)))).mul(hit).mul(notSky)

  // 平面方式：遮挡结果仍按“是否落在地面平面上”筛选；贴合表面的受影点可以是任何可见表面
  const cast = method === 'plane' ? planeCast(u, placement, character, ray, t).mul(u.castStrength).mul(onGround) : surfaceCast(u, placement, character, characterDepth, ray, zBackground, notSky).mul(u.castStrength)
  const mult = mix(vec3(1), u.contactTint, contact.mul(u.contactStrength).mul(onGround)).mul(mix(vec3(1), u.castTint, cast))
  return material(vec4(mult, 1))
}

/**
 * 平面方式：把立绘当作立在接地点上、朝向光源的竖直平面，按离脚的高度取立绘上的点。
 * 地面上沿背离光源方向距离 s 的点，对应立绘上高 s·tan(仰角) 的位置。
 */
function planeCast(u: ShadowUniforms, placement: Placement, character: TextureNode, ray: Vec3Node, t: FloatNode): FloatNode {
  const pu = placement.uniforms
  const half = pu.docSize.mul(0.5)
  const g3 = vec3(u.ground.x.sub(half.x).div(u.focal).mul(u.groundZ), half.y.sub(u.ground.y).div(u.focal).mul(u.groundZ), u.groundZ.negate())

  // 交点相对接地点：沿背离光源方向的距离换算为立绘上的高度，横向距离保持不变
  const delta = ray.mul(t).sub(g3)
  const unit = u.focal.div(u.groundZ)
  const height = dot(delta, u.along).mul(u.tanElevation).mul(unit)
  const side = dot(delta, u.lateral).mul(unit)
  const c = cos(pu.charRotation)
  const s = sin(pu.charRotation)
  const onCharacter = u.ground.add(vec2(c, s).mul(side)).add(vec2(s, c.negate()).mul(height))
  const uv = placement.toCharUV(onCharacter)
  const insideUV = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
  const blur = height.mul(mix(0.02, 0.27, u.castSoftness))
  const lod = log2(max(blur.div(pu.charScale), 1))
  return sampleLevel(character, uv, lod).a.mul(insideUV).mul(step(0, height))
}

/**
 * 贴合表面：从受影点朝主光源按几何增长的步长前进，每一步投影回文档像素，
 * 若这一步的距离落在该像素处立绘占据的 [正面, 正面 + 厚度] 区间内就算被遮挡。
 * 影子因此贴着台阶、斜坡、墙面弯折；近处步长小，接触处有细小的阴影。
 */
function surfaceCast(
  u: ShadowUniforms,
  placement: Placement,
  character: TextureNode,
  characterDepth: TextureNode,
  ray: Vec3Node,
  zBackground: FloatNode,
  notSky: FloatNode,
): FloatNode {
  const pu = placement.uniforms
  const half = pu.docSize.mul(0.5)
  const cur = ray.mul(zBackground).toVar()
  const travelled = float(0).toVar()
  const occluded = float(0).toVar()

  Loop(SURFACE_STEPS, ({ i }) => {
    const next = u.surfaceFirst.mul(pow(u.surfaceRatio, float(i)))
    const len = next.sub(travelled).toVar()
    travelled.assign(next)
    // 方向光的方向固定；灯的每一步方向略有变化
    const dir = select(u.surfaceType.equal(0), u.surfaceLight, u.surfaceLight.sub(cur).normalize())
    cur.addAssign(dir.mul(len))

    const distance = cur.z.negate()
    const safe = max(distance, 1e-3)
    const q = vec2(half.x.add(cur.x.div(safe).mul(u.focal)), half.y.sub(cur.y.div(safe).mul(u.focal))).toVar()
    const uv = q.div(pu.docSize)
    const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1)).mul(step(1e-3, distance))

    const front = float(1).div(max(sampleLevel(characterDepth, uv).r.mul(u.depthScale.x).add(u.depthScale.y), 1e-6))
    const bias = float(SURFACE_BIAS).add(len.mul(SURFACE_BIAS_STEP))
    const near = smoothstep(front.sub(bias), front, distance)
    const back = float(1).sub(smoothstep(front.add(u.surfaceThickness), front.add(u.surfaceThickness).add(bias), distance))
    // 半影：离受影点越远越模糊，按行进距离与立绘尺寸换算 mip
    const blur = travelled.mul(u.focal.div(safe)).mul(mix(0.02, 0.27, u.castSoftness))
    const lod = log2(max(blur.div(pu.charScale), 1))
    const alpha = sampleLevel(character, placement.toCharUV(q), lod).a
    occluded.assign(max(occluded, alpha.mul(near).mul(back).mul(inside)))
  })

  const rect = u.cullRect
  const inRect = step(rect.x, placement.p.x).mul(step(placement.p.x, rect.z)).mul(step(rect.y, placement.p.y)).mul(step(placement.p.y, rect.w))
  return occluded.mul(inRect).mul(notSky)
}

export function applyShadowParams(u: ShadowUniforms, params: ShadowParams): void {
  u.ground.value.set(params.ground.x, params.ground.y)
  u.groundZ.value = params.groundZ
  u.depthScale.value.set(params.depthScale.a, params.depthScale.b, 1 / params.depthScale.far)
  u.focal.value = params.focal
  u.normal.value.set(...params.normal)
  const { contact, cast } = params
  u.contactStrength.value = contact.strength
  u.contactCenter.value.set(contact.center.x, contact.center.y)
  u.contactDir.value.set(contact.dir.x, contact.dir.y)
  u.contactAxes.value.set(...contact.axes)
  u.contactSoftness.value = contact.softness
  u.contactTint.value.set(...contact.tint)
  u.castStrength.value = cast.strength
  u.along.value.set(...cast.along)
  u.lateral.value.set(...cast.lateral)
  u.tanElevation.value = cast.tanElevation
  u.castSoftness.value = cast.softness
  u.castTint.value.set(...cast.tint)
  const surface = params.surface
  if (surface) {
    u.surfaceType.value = surface.type
    u.surfaceLight.value.set(...surface.vector)
    u.surfaceThickness.value = surface.thickness
    u.surfaceFirst.value = surface.first
    u.surfaceRatio.value = surface.ratio
    if (surface.rect) u.cullRect.value.set(...surface.rect)
    else u.cullRect.value.set(0, 0, 1e6, 1e6)
  } else {
    // 贴合表面的步进参数没有就绪时一律不裁剪；渲染也只会用平面材质
    u.cullRect.value.set(0, 0, 1e6, 1e6)
  }
}
