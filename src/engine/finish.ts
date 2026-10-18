/**
 * 终处理 pass：全局基础调整之后的显示空间处理（docs/Plan.md M5 实现方案）。
 * 目前包括色轮和分离色调，公式与 src/grade/creative.ts 一致。输入输出都是线性 sRGB。
 */
import * as THREE from 'three/webgpu'
import { float, max, pow, select, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { SPLIT_BLACK, SPLIT_WIDTH, type CreativeParams } from '@/grade/creative'
import { fromOklab, material, srgbDecode, srgbEncode, toOklab, type Vec3Node, type Vec4Node } from './nodes'

export function createFinishUniforms() {
  return {
    /** 0 时不做全局调色（没有调色，或前后对比显示调色前） */
    creative: uniform(0),
    lift: uniform(new THREE.Vector3()),
    invGamma: uniform(new THREE.Vector3(1, 1, 1)),
    gain: uniform(new THREE.Vector3(1, 1, 1)),
    shadowTint: uniform(new THREE.Vector2()),
    highlightTint: uniform(new THREE.Vector2()),
    pivot: uniform(0.5),
  }
}

export type FinishUniforms = ReturnType<typeof createFinishUniforms>

function creative(u: FinishUniforms, c: Vec3Node): Vec3Node {
  // 色轮：编码值上的 lift、gain、gamma
  const e = srgbEncode(max(c, vec3(0)))
  const wheels = pow(max(u.gain.mul(e.add(u.lift.mul(max(vec3(1).sub(e), vec3(0))))), vec3(0)), u.invGamma)

  // 分离色调：Oklab 中按亮度加上暗部、亮部的偏色
  const lab = toOklab(srgbDecode(wheels))
  const wh = smoothstep(u.pivot.sub(SPLIT_WIDTH), u.pivot.add(SPLIT_WIDTH), lab.x)
  const ws = float(1).sub(wh).mul(smoothstep(0, SPLIT_BLACK, lab.x))
  const ab = vec2(lab.y, lab.z).add(u.shadowTint.mul(ws)).add(u.highlightTint.mul(wh))
  return max(fromOklab(vec3(lab.x, ab.x, ab.y)), vec3(0))
}

export function createFinishPass(u: FinishUniforms, input: Vec4Node) {
  return material(vec4(select(u.creative.greaterThan(0.5), creative(u, input.rgb), input.rgb), 1))
}

export function applyFinishParams(u: FinishUniforms, p: CreativeParams | null, enabled: boolean): void {
  u.creative.value = enabled && p?.active ? 1 : 0
  if (!p) return
  u.lift.value.set(...p.lift)
  u.invGamma.value.set(...p.invGamma)
  u.gain.value.set(...p.gain)
  u.shadowTint.value.set(...p.shadowTint)
  u.highlightTint.value.set(...p.highlightTint)
  u.pivot.value = p.pivot
}
