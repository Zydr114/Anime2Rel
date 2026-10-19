/**
 * 基础调整的 TSL 节点（docs/Plan.md §3.5），公式和常数与 src/grade/color.ts 一致。
 * 背景层、立绘层、全局各用一套统一量；输入输出都是线性 sRGB。
 *
 * 局部调整（高光、阴影、清晰度、锐化）先把这一级的输入画成 log2 亮度的 mip 金字塔（tone），
 * 再在 1/4 分辨率上算出两个尺度的快速引导滤波系数（coef），调整 pass 据此重建基底。
 * 三级依次渲染，共用 tone，各用一张 coef。分块导出时 coef 取自预览分辨率的整幅渲染，tone 逐块渲染（锐化使用）。
 */
import * as THREE from 'three/webgpu'
import { abs, atan, cos, dot, exp2, float, floor, length, log2, max, mix, screenUV, select, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { toHalf } from '@/algo/half'
import {
  BLACK_STOPS,
  BLACKS_RANGE,
  CLARITY_EPS,
  CLARITY_GAIN,
  CLARITY_MIDTONES,
  CLARITY_RADIUS,
  CONTRAST_STRENGTH,
  CURVE_SIZE,
  HSL_CENTERS,
  HSL_CHROMA_EDGE,
  HSL_HUE_RANGE,
  HSL_LUMINANCE_RANGE,
  HSL_SPANS,
  HIGHLIGHTS_RANGE,
  HIGHLIGHTS_STOPS,
  LOG_FLOOR,
  LUMA,
  MID_GRAY,
  SHADOWS_RANGE,
  SHADOWS_STOPS,
  SHARPEN_GAIN,
  SHARPEN_RADIUS,
  SKIN_HUE,
  SKIN_PROTECT,
  SKIN_RANGE,
  TONE_EPS,
  TONE_RADIUS,
  VIBRANCE_CHROMA,
  WHITE_STOPS,
  WHITES_RANGE,
} from '@/grade/color'
import type { AdjustParams } from '@/grade/params'
import { fromOklab, material, sampleAt, srgbDecode, srgbEncode, toOklab, type FloatNode, type TextureNode, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'

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
    /** 有局部调整（tone、toneCoef 是这一级的数据） */
    local: uniform(0),
    highlights: uniform(0),
    shadows: uniform(0),
    clarity: uniform(0),
    sharpen: uniform(0),
    curveActive: uniform(0),
    curveSlope: uniform(new THREE.Vector3(1, 1, 1)),
    curveMap,
    curve: texture(curveMap),
  }
}

export type AdjustUniforms = ReturnType<typeof createAdjustUniforms>

/** 局部调整使用的纹理和尺寸 */
export interface LocalTone {
  /** 当前渲染目标的尺寸（像素）、输出图像的尺寸与长边 */
  size: THREE.UniformNode<'vec2', THREE.Vector2>
  outSize: THREE.UniformNode<'vec2', THREE.Vector2>
  long: THREE.UniformNode<'float', number>
  /** log2(输出长边 / coef 的长边)：不分块时 coef 为 1/4 分辨率，即 2 */
  coefShift: THREE.UniformNode<'float', number>
  /** 输出图像的 UV，coef 按它采样 */
  uv: Vec2Node
  /** (y·a, y²·a, a)，y 为 log2 亮度，a 为不透明度（立绘层以外为 1），与渲染目标同尺寸，带 mip */
  tone: TextureNode
  /** 两个尺度的引导滤波系数 (a, b)：基底 = a·y + b。整幅图像，带 mip */
  coef: TextureNode
}

export function createLocalUniforms() {
  return { size: uniform(new THREE.Vector2(1, 1)), outSize: uniform(new THREE.Vector2(1, 1)), long: uniform(1), coefShift: uniform(2) }
}

const logLuma = (c: Vec3Node): FloatNode => log2(max(dot(c, vec3(...LUMA)), LOG_FLOOR))

/** 边长约为 2 × 半径（相对长边）的盒式均值对应的 mip 层级 */
const boxLod = (lt: LocalTone, radius: number): FloatNode => log2(max(lt.long.mul(2 * radius), 1))

/** 盒式均值：在 lod 层级上取 uv 周围四个对角的样本，平滑 mip 的块状边界。offsetLod 为 size 像素下的层级，决定采样间距。 */
function boxMean(t: TextureNode, uv: Vec2Node, size: Vec2Node, offsetLod: FloatNode, lod: FloatNode): Vec4Node {
  const d = vec2(exp2(offsetLod).mul(0.5)).div(size)
  const at = (x: number, y: number) => sampleAt(t, uv.add(d.mul(vec2(x, y))), lod)
  return at(-1, -1).add(at(1, -1)).add(at(-1, 1)).add(at(1, 1)).mul(0.25)
}

/** 这一级的输入 → (y·a, y²·a, a)。y 按白平衡和曝光之后的颜色计算 */
export function createTonePass(u: AdjustUniforms, color: Vec3Node, alpha: FloatNode = float(1)) {
  const y = logLuma(max(u.wb.mul(color), vec3(0)))
  return material(vec4(y.mul(alpha), y.mul(y).mul(alpha), alpha, 1))
}

/** tone → 两个尺度的引导滤波系数。几乎没有不透明像素的地方取恒等系数（基底等于像素本身），立绘边缘因此平滑地退化为逐像素调整。 */
export function createToneCoefPass(lt: LocalTone) {
  const coef = (radius: number, eps: number): Vec2Node => {
    const lod = boxLod(lt, radius)
    const m = boxMean(lt.tone, screenUV, lt.size, lod, lod)
    const w = max(m.z, 1e-4)
    const mean = m.x.div(w)
    const variance = max(m.y.div(w).sub(mean.mul(mean)), 0)
    const a = variance.div(variance.add(eps))
    const valid = smoothstep(0.01, 0.1, m.z)
    return vec2(mix(1, a, valid), mean.sub(a.mul(mean)).mul(valid))
  }
  return material(vec4(coef(TONE_RADIUS, TONE_EPS), coef(CLARITY_RADIUS, CLARITY_EPS)))
}

/** 局部调整的亮度偏移（档），与 localShift 一致。c 为白平衡和曝光之后的颜色 */
function localShift(u: AdjustUniforms, lt: LocalTone, c: Vec3Node): FloatNode {
  const y = logLuma(c)
  const mid = Math.log2(MID_GRAY)
  // 系数纹理的层级比输出分辨率低 coefShift
  const toneLod = boxLod(lt, TONE_RADIUS)
  const clarityLod = boxLod(lt, CLARITY_RADIUS)
  const toneCoef = boxMean(lt.coef, lt.uv, lt.outSize, toneLod, toneLod.sub(lt.coefShift))
  const clarityCoef = boxMean(lt.coef, lt.uv, lt.outSize, clarityLod, clarityLod.sub(lt.coefShift))
  const toneBase = toneCoef.x.mul(y).add(toneCoef.y)
  const clarityBase = clarityCoef.z.mul(y).add(clarityCoef.w)

  const b = toneBase.sub(mid)
  const shadows = float(1).sub(smoothstep(SHADOWS_RANGE[0], SHADOWS_RANGE[1], b)).mul(u.shadows.mul(SHADOWS_STOPS))
  const highlights = smoothstep(HIGHLIGHTS_RANGE[0], HIGHLIGHTS_RANGE[1], b).mul(u.highlights.mul(HIGHLIGHTS_STOPS))
  const midtones = float(1).sub(smoothstep(CLARITY_MIDTONES[0], CLARITY_MIDTONES[1], abs(clarityBase.sub(mid))))
  const clarity = u.clarity.mul(CLARITY_GAIN).mul(midtones).mul(y.sub(clarityBase))

  // 锐化：3×3 二项式模糊（间距为锐化半径），按不透明度加权；中心也取自 tone，平坦区域的细节严格为 0
  const r = vec2(max(lt.long.mul(SHARPEN_RADIUS), 1)).div(lt.size)
  let sum: Vec4Node = vec4(0)
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) sum = sum.add(sampleAt(lt.tone, screenUV.add(r.mul(vec2(dx, dy))), float(0)).mul((2 - Math.abs(dx)) * (2 - Math.abs(dy))))
  const center = sampleAt(lt.tone, screenUV, float(0))
  const detail = center.x.div(max(center.z, 1e-4)).sub(sum.x.div(max(sum.z, 1e-4)))
  const sharpen = u.sharpen.mul(SHARPEN_GAIN).mul(detail)

  return select(u.local.greaterThan(0.5), shadows.add(highlights).add(clarity).add(sharpen), float(0))
}

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

/** 逐像素的基础调整，与 adjustPixel 一致；局部调整的亮度偏移加在白平衡与曝光之后 */
export function adjustColor(u: AdjustUniforms, lt: LocalTone, input: Vec3Node): Vec3Node {
  const balanced = max(u.wb.mul(input), vec3(0))
  let c: Vec3Node = balanced.mul(exp2(localShift(u, lt, balanced)))
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

/** 立绘层的输入是预乘 alpha 的融合结果 */
export const unpremultiply = (c: Vec4Node): Vec3Node => c.rgb.div(max(c.a, 1e-4))

/** 背景层：原图 → 调整后的线性背景 */
export function createBackgroundAdjustPass(u: AdjustUniforms, lt: LocalTone, background: THREE.TextureNode) {
  return material(vec4(adjustColor(u, lt, background.rgb), 1))
}

/** 立绘层：融合后的立绘（预乘 alpha）→ 调整后的立绘 */
export function createCharacterAdjustPass(u: AdjustUniforms, lt: LocalTone, character: Vec4Node) {
  return material(vec4(adjustColor(u, lt, unpremultiply(character)).mul(character.a), character.a))
}

/** 全局：合成结果 → 调整后的结果 */
export function createGlobalAdjustPass(u: AdjustUniforms, lt: LocalTone, composited: Vec4Node) {
  return material(vec4(adjustColor(u, lt, composited.rgb), 1))
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
  u.local.value = p.local ? 1 : 0
  u.highlights.value = p.highlights
  u.shadows.value = p.shadows
  u.clarity.value = p.clarity
  u.sharpen.value = p.sharpen
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
