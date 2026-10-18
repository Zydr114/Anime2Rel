/**
 * 基础调整的 TSL 节点（docs/Plan.md §3.5），公式和常数与 src/grade/color.ts 一致。
 * 背景层、立绘层、全局各用一套统一量；输入输出都是线性 sRGB。
 */
import * as THREE from 'three/webgpu'
import { abs, atan, cos, exp2, float, floor, length, log2, max, select, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { toHalf } from '@/algo/half'
import {
  BLACK_STOPS,
  BLACKS_RANGE,
  CONTRAST_STRENGTH,
  CURVE_SIZE,
  HSL_CENTERS,
  HSL_CHROMA_EDGE,
  HSL_HUE_RANGE,
  HSL_LUMINANCE_RANGE,
  HSL_SPANS,
  MID_GRAY,
  SKIN_HUE,
  SKIN_PROTECT,
  SKIN_RANGE,
  VIBRANCE_CHROMA,
  WHITE_STOPS,
  WHITES_RANGE,
} from '@/grade/color'
import type { AdjustParams } from '@/grade/params'
import { fromOklab, material, sampleAt, srgbDecode, srgbEncode, toOklab, type FloatNode, type Vec3Node, type Vec4Node } from './nodes'

const DEG = Math.PI / 180

function curveTexture(): THREE.DataTexture {
  const data = new Uint16Array(CURVE_SIZE * 4)
  for (let i = 0; i < CURVE_SIZE; i++) {
    const v = toHalf(i / (CURVE_SIZE - 1))
    data.set([v, v, v, toHalf(1)], i * 4)
  }
  const t = new THREE.DataTexture(data, CURVE_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType)
  t.colorSpace = THREE.NoColorSpace
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

export function createAdjustUniforms() {
  const curveMap = curveTexture()
  return {
    /** 0 时直接输出原色（没有调整，或前后对比显示调色前） */
    enabled: uniform(0),
    /** 白平衡矩阵乘以曝光增益 */
    wb: uniform(new THREE.Matrix3()),
    contrast: uniform(0),
    whites: uniform(0),
    blacks: uniform(0),
    vibrance: uniform(0),
    saturation: uniform(0),
    /** 各色相段的色相偏移、饱和度、明度 */
    hsl: HSL_CENTERS.map(() => uniform(new THREE.Vector3())),
    curveActive: uniform(0),
    curveSlope: uniform(new THREE.Vector3(1, 1, 1)),
    curveMap,
    curve: texture(curveMap),
  }
}

export type AdjustUniforms = ReturnType<typeof createAdjustUniforms>

/** 单通道对比度，与 applyContrast 一致 */
function contrast1(c: FloatNode, k: FloatNode): FloatNode {
  const y = log2(max(c, 1e-6).div(MID_GRAY))
  const end = select(y.greaterThanEqual(0), float(WHITE_STOPS), float(BLACK_STOPS))
  const t = y.div(end)
  const s = y.add(k.mul(y).mul(float(1).sub(t.mul(t))))
  const above = float(WHITE_STOPS).add(float(1).sub(k.mul(2)).mul(y.sub(WHITE_STOPS)))
  return float(MID_GRAY).mul(exp2(select(t.greaterThan(1), above, select(t.lessThan(-1), y, s))))
}

/** 色相差 a − b（度），折算到 [−180, 180) */
function hueDelta(a: FloatNode, b: FloatNode | number): FloatNode {
  const d = a.sub(b).add(540)
  return d.sub(floor(d.div(360)).mul(360)).sub(180)
}

/** 查找表中的一个通道 */
function curve1(u: AdjustUniforms, e: FloatNode, channel: 'r' | 'g' | 'b'): FloatNode {
  const x = max(e, 0).mul((CURVE_SIZE - 1) / CURVE_SIZE).add(0.5 / CURVE_SIZE)
  const lut = sampleAt(u.curve, vec2(x, 0.5))[channel]
  const end = sampleAt(u.curve, vec2(1 - 0.5 / CURVE_SIZE, 0.5))[channel]
  return select(e.greaterThan(1), end.add(e.sub(1).mul(u.curveSlope[channel === 'r' ? 'x' : channel === 'g' ? 'y' : 'z'])), lut)
}

/** 逐像素的基础调整，与 adjustPixel 一致 */
export function adjustColor(u: AdjustUniforms, input: Vec3Node): Vec3Node {
  let c: Vec3Node = max(u.wb.mul(input), vec3(0))
  const k = u.contrast.mul(CONTRAST_STRENGTH)
  c = vec3(contrast1(c.x, k), contrast1(c.y, k), contrast1(c.z, k))

  // 白色、黑色
  const e = srgbEncode(c)
  const wb = e
    .add(smoothstep(0.5, 1, e).mul(u.whites.mul(WHITES_RANGE)))
    .add(float(1).sub(smoothstep(0, 0.5, e)).mul(u.blacks.mul(BLACKS_RANGE)))
  c = srgbDecode(max(wb, vec3(0)))

  // HSL、自然饱和度、饱和度（Oklch）
  const lab = toOklab(c)
  const C = length(vec2(lab.y, lab.z))
  const h = atan(lab.z, lab.y).div(DEG)
  let hue: FloatNode = float(0)
  let sat: FloatNode = float(0)
  let lum: FloatNode = float(0)
  HSL_CENTERS.forEach((center, i) => {
    const d = hueDelta(h, center)
    const [before, after] = HSL_SPANS[i]
    const w = float(1).sub(smoothstep(0, 1, select(d.lessThan(0), d.negate().div(before), d.div(after))))
    hue = hue.add(w.mul(u.hsl[i].x))
    sat = sat.add(w.mul(u.hsl[i].y))
    lum = lum.add(w.mul(u.hsl[i].z))
  })
  const h2 = h.add(hue.mul(HSL_HUE_RANGE))
  const C1 = C.mul(max(sat.add(1), 0))
  const L2 = lab.x.mul(float(1).add(lum.mul(HSL_LUMINANCE_RANGE).mul(smoothstep(HSL_CHROMA_EDGE[0], HSL_CHROMA_EDGE[1], C))))
  const skin = float(1).sub(smoothstep(SKIN_RANGE[0], SKIN_RANGE[1], abs(hueDelta(h2, SKIN_HUE))))
  const boost = u.vibrance.mul(float(1).sub(smoothstep(0, VIBRANCE_CHROMA, C1))).mul(float(1).sub(skin.mul(SKIN_PROTECT)))
  const vib = select(u.vibrance.greaterThan(0), boost, u.vibrance)
  const C2 = C1.mul(max(vib.add(1), 0)).mul(max(u.saturation.add(1), 0))
  c = max(fromOklab(vec3(L2, C2.mul(cos(h2.mul(DEG))), C2.mul(sin(h2.mul(DEG))))), vec3(0))

  // 曲线
  const e2 = srgbEncode(c)
  const curved = srgbDecode(max(vec3(curve1(u, e2.x, 'r'), curve1(u, e2.y, 'g'), curve1(u, e2.z, 'b')), vec3(0)))
  c = select(u.curveActive.greaterThan(0.5), curved, c)

  return select(u.enabled.greaterThan(0.5), c, input)
}

/** 背景层：原图 → 调整后的线性背景 */
export function createBackgroundAdjustPass(u: AdjustUniforms, background: THREE.TextureNode) {
  return material(vec4(adjustColor(u, background.rgb), 1))
}

/** 立绘层：融合后的立绘（预乘 alpha）→ 调整后的立绘 */
export function createCharacterAdjustPass(u: AdjustUniforms, character: Vec4Node) {
  const straight = character.rgb.div(max(character.a, 1e-4))
  return material(vec4(adjustColor(u, straight).mul(character.a), character.a))
}

/** 全局：合成结果 → 调整后的结果 */
export function createGlobalAdjustPass(u: AdjustUniforms, composited: Vec4Node) {
  return material(vec4(adjustColor(u, composited.rgb), 1))
}

/** 写入一级调整的统一量；enabled 为 false 时直接输出原色 */
export function applyAdjustParams(u: AdjustUniforms, p: AdjustParams, enabled: boolean): void {
  u.enabled.value = enabled && p.active ? 1 : 0
  const m = p.wb
  u.wb.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
  u.contrast.value = p.contrast
  u.whites.value = p.whites
  u.blacks.value = p.blacks
  u.vibrance.value = p.vibrance
  u.saturation.value = p.saturation
  u.hsl.forEach((node, i) => node.value.set(p.hsl.hue[i], p.hsl.saturation[i], p.hsl.luminance[i]))
  u.curveActive.value = p.curve ? 1 : 0
  if (p.curve && u.curveMap.userData.lut !== p.curve) {
    const data = u.curveMap.image.data as Uint16Array
    for (let i = 0; i < data.length; i++) data[i] = toHalf(p.curve.data[i])
    u.curveMap.userData.lut = p.curve
    u.curveMap.needsUpdate = true
    u.curveSlope.value.set(...p.curve.slope)
  }
}
