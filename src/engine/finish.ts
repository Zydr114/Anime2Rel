/**
 * 终处理 pass：全局基础调整之后的显示空间处理（docs/Plan.md M5 实现方案）。
 * 目前包括色轮、分离色调、LUT 和混色层，公式与 src/grade/creative.ts 一致。输入输出都是线性 sRGB。
 */
import * as THREE from 'three/webgpu'
import { clamp, float, max, mix, pow, select, smoothstep, texture, texture3D, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { toHalf } from '@/algo/half'
import type { CubeLut } from '@/grade/cube'
import { MASK_FEATHER, RAMP_SIZE, SPLIT_BLACK, SPLIT_WIDTH, type CreativeParams } from '@/grade/creative'
import type { RegisteredLut } from '@/grade/luts'
import { MAX_BLEND_LAYERS } from '@/grade/model'
import { blend, blendLuma } from './blend'
import { fromOklab, material, sampleAt, srgbDecode, srgbEncode, toOklab, type Vec3Node, type Vec4Node } from './nodes'

/** LUT → RGBA 半精度三维纹理，线性插值 */
function lutTexture(lut: Pick<CubeLut, 'size' | 'data'>): THREE.Data3DTexture {
  const count = lut.size ** 3
  const data = new Uint16Array(count * 4)
  const one = toHalf(1)
  for (let i = 0; i < count; i++) {
    data[i * 4] = toHalf(lut.data[i * 3])
    data[i * 4 + 1] = toHalf(lut.data[i * 3 + 1])
    data[i * 4 + 2] = toHalf(lut.data[i * 3 + 2])
    data[i * 4 + 3] = one
  }
  const t = new THREE.Data3DTexture(data, lut.size, lut.size, lut.size)
  t.format = THREE.RGBAFormat
  t.type = THREE.HalfFloatType
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping
  t.unpackAlignment = 1
  t.needsUpdate = true
  return t
}

/** 混色层的颜色查找表：RAMP_SIZE × MAX_BLEND_LAYERS，每层一行 */
function rampTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(RAMP_SIZE * MAX_BLEND_LAYERS * 4), RAMP_SIZE, MAX_BLEND_LAYERS, THREE.RGBAFormat, THREE.HalfFloatType)
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

const IDENTITY_LUT = { size: 2, data: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]) }

export function createFinishUniforms() {
  const lutPlaceholder = lutTexture(IDENTITY_LUT)
  const rampMap = rampTexture()
  return {
    /** 0 时不做全局调色（没有调色，或前后对比显示调色前） */
    creative: uniform(0),
    lift: uniform(new THREE.Vector3()),
    invGamma: uniform(new THREE.Vector3(1, 1, 1)),
    gain: uniform(new THREE.Vector3(1, 1, 1)),
    shadowTint: uniform(new THREE.Vector2()),
    highlightTint: uniform(new THREE.Vector2()),
    pivot: uniform(0.5),
    /** LUT 强度，没有 LUT 时为 0 */
    lutAmount: uniform(0),
    lutSize: uniform(2),
    lutMin: uniform(new THREE.Vector3(0, 0, 0)),
    lutMax: uniform(new THREE.Vector3(1, 1, 1)),
    lut: texture3D(lutPlaceholder),
    lutPlaceholder,
    /** 当前上传的 LUT */
    lutState: { id: null as string | null, texture: null as THREE.Data3DTexture | null },
    /** 各混色层：模式序号、不透明度、蒙版下限、上限 */
    layers: Array.from({ length: MAX_BLEND_LAYERS }, () => uniform(new THREE.Vector4(0, 0, 0, 1))),
    rampMap,
    ramp: texture(rampMap),
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
  const split = srgbEncode(max(fromOklab(vec3(lab.x, ab.x, ab.y)), vec3(0)))

  // LUT：编码值按定义域换算到网格坐标，超出范围的值裁剪
  const x = clamp(split.sub(u.lutMin).div(u.lutMax.sub(u.lutMin)), 0, 1)
  const uvw = x.mul(u.lutSize.sub(1).div(u.lutSize)).add(float(0.5).div(u.lutSize))
  const graded = mix(split, u.lut.sample(uvw).rgb, u.lutAmount)
  return srgbDecode(max(blendLayers(u, graded), vec3(0)))
}

/** 混色层：从下往上依次叠加。混合在裁剪到 [0,1] 的底色上进行，按亮度蒙版和不透明度与原值混合 */
function blendLayers(u: FinishUniforms, e: Vec3Node): Vec3Node {
  let base = e
  u.layers.forEach((p, i) => {
    const cb = clamp(base, 0, 1)
    const l = blendLuma(cb)
    const cs = sampleAt(u.ramp, vec2(l.mul((RAMP_SIZE - 1) / RAMP_SIZE).add(0.5 / RAMP_SIZE), (i + 0.5) / MAX_BLEND_LAYERS)).rgb
    const lower = select(p.z.lessThanEqual(0), float(1), smoothstep(p.z.sub(MASK_FEATHER), p.z.add(MASK_FEATHER), l))
    const upper = select(p.w.greaterThanEqual(1), float(1), float(1).sub(smoothstep(p.w.sub(MASK_FEATHER), p.w.add(MASK_FEATHER), l)))
    base = mix(base, blend(p.x, cb, cs), p.y.mul(lower).mul(upper))
  })
  return base
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
  u.lutAmount.value = p.lut && u.lutState.id === p.lut.id ? p.lut.intensity : 0
  p.layers.forEach((l, i) => u.layers[i].value.set(...l))
  if (u.rampMap.userData.ramp !== p.ramp) {
    const data = u.rampMap.image.data as Uint16Array
    for (let i = 0; i < data.length; i++) data[i] = toHalf(p.ramp[i])
    u.rampMap.userData.ramp = p.ramp
    u.rampMap.needsUpdate = true
  }
}

/** 切换使用的 LUT；同一个 LUT 不会重复上传。需在 applyFinishParams 之前调用 */
export function setFinishLut(u: FinishUniforms, lut: RegisteredLut | null): void {
  const id = lut?.id ?? null
  if (u.lutState.id === id) return
  u.lutState.texture?.dispose()
  u.lutState.texture = lut ? lutTexture(lut) : null
  u.lutState.id = id
  u.lut.value = u.lutState.texture ?? u.lutPlaceholder
  if (!lut) return
  u.lutSize.value = lut.size
  u.lutMin.value.set(...lut.domainMin)
  u.lutMax.value.set(...lut.domainMax)
}

export function disposeFinish(u: FinishUniforms): void {
  u.lutState.texture?.dispose()
  u.lutPlaceholder.dispose()
  u.rampMap.dispose()
}
