/**
 * 站立阴影的 TSL 材质：输出背景的颜色倍率（rgb），参数由 src/fusion/shadow.ts 换算。
 * 所有位置都在文档像素空间计算，预览和导出的分辨率不影响结果。
 */
import * as THREE from 'three/webgpu'
import { abs, cos, dot, float, length, log2, max, min, mix, sin, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { DEPTH_SHIFT } from '@/focus/dof'
import type { ShadowParams } from '@/fusion/shadow'
import { sampleLevel } from './dof'
import { material, type FloatNode } from './nodes'
import type { Placement } from './passes'

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
  }
}

export type ShadowUniforms = ReturnType<typeof createShadowUniforms>

/**
 * @param character 立绘纹理（立绘 UV，带 mipmap），投影按离脚的高度选用 mip 做半影模糊
 * @param background 背景深度与天空遮罩：阴影只落在与地面平面深度一致、不是天空的地方
 */
export function createShadowPass(u: ShadowUniforms, placement: Placement, character: THREE.TextureNode, background: { depth: FloatNode; sky: FloatNode }) {
  const pu = placement.uniforms
  const p = placement.p

  // 接触阴影：以脚部为中心、与地平线平行的椭圆
  const d = p.sub(u.contactCenter)
  const r = length(vec2(dot(d, u.contactDir), dot(d, vec2(u.contactDir.y.negate(), u.contactDir.x))).div(u.contactAxes))
  const contact = float(1).sub(smoothstep(float(1).sub(mix(0.25, 1, u.contactSoftness)), 1, r))

  // 当前像素的视线与地面平面的交点（沿光轴的距离 t，单位与 groundZ 一致）
  const half = pu.docSize.mul(0.5)
  const ray = vec3(p.x.sub(half.x).div(u.focal), half.y.sub(p.y).div(u.focal), -1)
  const g3 = vec3(u.ground.x.sub(half.x).div(u.focal).mul(u.groundZ), half.y.sub(u.ground.y).div(u.focal).mul(u.groundZ), u.groundZ.negate())
  const denom = dot(u.normal, ray)
  const t = dot(u.normal, g3).div(min(denom, -1e-5))
  const hit = step(denom, -1e-5).mul(step(0, t))

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
  const cast = sampleLevel(character, uv, lod).a.mul(insideUV).mul(step(0, height))

  const zBackground = float(1).div(max(background.depth.mul(u.depthScale.x).add(u.depthScale.y), max(u.depthScale.z, 1e-6)))
  const valid = float(1).sub(smoothstep(0.2, 0.45, abs(zBackground.sub(t)).div(max(t, 1e-4)))).mul(float(1).sub(background.sky)).mul(hit)
  const mult = mix(vec3(1), u.contactTint, contact.mul(u.contactStrength).mul(valid)).mul(mix(vec3(1), u.castTint, cast.mul(u.castStrength).mul(valid)))
  return material(vec4(mult, 1))
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
}
