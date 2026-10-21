/**
 * 终处理 pass：全局基础调整之后的处理（docs/Plan.md M5 实现方案）。依次为：
 * 镜头失真与色差 → 钝化 → 光学扩散 → 柔焦 → 叠加 Bloom、Halation、光束、镜头光晕（线性 HDR）→ 暗角 → 色调映射 → 色轮、分离色调、LUT、混色层（显示空间）
 * → 半色调 → 颗粒。
 * 全局调色的公式与 src/grade/creative.ts 一致，后期参数见 src/grade/post.ts。输入输出都是线性 sRGB。
 * 失真后，画面内容（含 Bloom 等整幅的结果）都在失真后的位置采样；暗角、半色调、颗粒按输出位置计算，不随画面变形。
 */
import * as THREE from 'three/webgpu'
import {
  agxToneMapping,
  clamp,
  cos,
  dot,
  exp2,
  float,
  floor,
  Fn,
  fract,
  hash,
  If,
  length,
  log2,
  max,
  min,
  mix,
  neutralToneMapping,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { toHalf } from '@/algo/half'
import type { CubeLut } from '@/grade/cube'
import { MASK_FEATHER, RAMP_SIZE, SPLIT_BLACK, SPLIT_WIDTH, type CreativeParams } from '@/grade/creative'
import type { RegisteredLut } from '@/grade/luts'
import { MAX_BLEND_LAYERS } from '@/grade/model'
import { blend, blendLuma } from './blend'
import { flareColor } from './flare'
import { fromOklab, material, sampleAt, srgbDecode, srgbEncode, toOklab, type FloatNode, type TextureNode, type TileMapping, type Vec2Node, type Vec3Node } from './nodes'
import { softThreshold, type PostUniforms } from './post'

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

/** 色差的采样数；各通道的权重沿径向从蓝到红过渡，每个通道的权重之和为 1，强度为 0 时与原图一致 */
const ABERRATION_TAPS = 7
const ABERRATION_WEIGHTS = (() => {
  const raw = Array.from({ length: ABERRATION_TAPS }, (_, i) => {
    const x = i / (ABERRATION_TAPS - 1)
    return [Math.max(0, 2 * x - 1), 1 - Math.abs(2 * x - 1), Math.max(0, 1 - 2 * x)]
  })
  const sums = [0, 1, 2].map((c) => raw.reduce((a, w) => a + w[c], 0))
  return raw.map((w) => w.map((v, c) => v / sums[c]))
})()

/** 镜头失真：输出图像的 UV → 原画面的 UV，公式见 src/grade/distortion.ts；半对角线为单位 */
function distort(post: PostUniforms, uv: Vec2Node): Vec2Node {
  const d = uv.sub(0.5)
  const p = d.mul(post.aspect).mul(2).div(length(post.aspect))
  return d.mul(post.distortionZoom.mul(dot(p, p).mul(post.distortion).add(1))).add(0.5)
}

/** 色差：各通道按到画面中心的距离做不同的缩放；at 为失真后的位置（输出图像 UV） */
function aberration(post: PostUniforms, image: TextureNode, tile: TileMapping, at: Vec2Node): Vec3Node {
  const d = at.sub(0.5)
  let sum: Vec3Node = vec3(0)
  ABERRATION_WEIGHTS.forEach(([r, g, b], i) => {
    const t = (2 * i) / (ABERRATION_TAPS - 1) - 1
    sum = sum.add(sampleAt(image, tile.toTarget(d.mul(post.aberration.mul(t).add(1)).add(0.5)), float(0)).rgb.mul(vec3(r, g, b)))
  })
  return sum
}

/** 钝化的采样点：Vogel 螺旋（黄金角）均匀覆盖半径为 1 的圆盘 */
const SOFTEN_TAPS = 12
const SOFTEN_OFFSETS = Array.from({ length: SOFTEN_TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / SOFTEN_TAPS)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(a), r * Math.sin(a)] as const
})

/**
 * 钝化：以 at（失真后的位置）为中心的圆盘模糊减去中心的值，即被去掉的细节。
 * 采样点的间距约为半径的一半，按间距选 mip 层级，使采样点之间没有空隙（需要图像有 mipmap）
 */
function softenDetail(post: PostUniforms, image: TextureNode, tile: TileMapping, at: Vec2Node): Vec3Node {
  const lod = max(log2(post.softenRadius.mul(post.long).mul(0.5)), 0)
  const step = vec2(post.softenRadius).div(post.aspect)
  let sum: Vec3Node = vec3(0)
  for (const [x, y] of SOFTEN_OFFSETS) sum = sum.add(sampleAt(image, tile.toTarget(at.add(step.mul(vec2(x, y)))), lod).rgb)
  return sum.div(SOFTEN_TAPS).sub(sampleAt(image, tile.toTarget(at), float(0)).rgb)
}

/** 颗粒满格时的幅度（编码值） */
const GRAIN_AMPLITUDE = 0.15
const LUMA = vec3(0.2126, 0.7152, 0.0722)

/**
 * 胶片颗粒：按文档坐标划分网格（尺寸相对长边），每个格点三个通道各取一个随机数，在格点间平滑插值并保持方差不变。
 * 颗粒小于一个像素时按尺寸减弱，使缩小的预览与导出图缩小后的观感一致。中间调最明显，在编码值上叠加。
 */
function grain(post: PostUniforms, c: Vec3Node, uv: Vec2Node): Vec3Node {
  const e = srgbEncode(clamp(c, 0, 1))
  const q = uv.mul(post.aspect).div(post.grainCell)
  const i = floor(q)
  const f = fract(q)
  const s = f.mul(f).mul(f.mul(-2).add(3))
  const corners = [
    { x: 0, y: 0, w: float(1).sub(s.x).mul(float(1).sub(s.y)) },
    { x: 1, y: 0, w: s.x.mul(float(1).sub(s.y)) },
    { x: 0, y: 1, w: float(1).sub(s.x).mul(s.y) },
    { x: 1, y: 1, w: s.x.mul(s.y) },
  ]
  const norm = sqrt(corners.reduce<FloatNode>((acc, k) => acc.add(k.w.mul(k.w)), float(0)))
  const channel = (ch: number) =>
    corners.reduce<FloatNode>((acc, k) => {
      const seed = i.x.add(k.x).toUint().mul(1973).add(i.y.add(k.y).toUint().mul(9277)).add(ch * 26699)
      return acc.add(hash(seed).sub(0.5).mul(k.w))
    }, float(0)).div(norm)
  const g = channel(1)
  const n = mix(vec3(g), vec3(channel(0), g, channel(2)), post.grainColor)
  const l = dot(e, LUMA)
  const weight = mix(0.35, 1, l.mul(float(1).sub(l)).mul(4))
  const amplitude = post.grain.mul(GRAIN_AMPLITUDE).mul(min(1, post.grainCell.mul(post.long)))
  return srgbDecode(max(e.add(n.mul(amplitude.mul(weight))), vec3(0)))
}

/**
 * 余弦网屏 s = (cos u + cos v)/4 + 0.5 中低于阈值 t 的面积与 t 不成正比（最多差 7%）。
 * 按拟合的反函数换算阈值（过 0、1 两端），网点面积与墨量的误差小于 1%
 */
function screenThreshold(ink: FloatNode): FloatNode {
  const x = ink.sub(0.5)
  const x2 = x.mul(x)
  return x.mul(x2.mul(-3.7012).add(2.7161).mul(x2).add(0.5523)).add(0.5)
}

/**
 * 一个通道的网点覆盖率：px 为输出图像的像素坐标，网屏按 angle 旋转、间距为 cell 像素，低于阈值处为墨。
 * 边缘按到阈值线的距离（用梯度线性化）在一个像素内过渡；墨量接近 0 或 1 时线性化会在网点中心留下残点，按墨量淡出
 */
function dotCoverage(px: Vec2Node, cell: FloatNode, angle: number, rotation: FloatNode, ink: FloatNode): FloatNode {
  const a = rotation.add((angle * Math.PI) / 180)
  const k = float(2 * Math.PI).div(cell)
  const q = vec2(px.x.mul(cos(a)).add(px.y.mul(sin(a))), px.y.mul(cos(a)).sub(px.x.mul(sin(a)))).mul(k)
  const screen = cos(q.x).add(cos(q.y)).mul(0.25).add(0.5)
  const gradient = max(length(vec2(sin(q.x), sin(q.y))).mul(k.mul(0.25)), 1e-6)
  const cover = clamp(screenThreshold(ink).sub(screen).div(gradient).add(0.5), 0, 1).mul(smoothstep(0, 0.02, ink))
  return float(1).sub(float(1).sub(cover).mul(smoothstep(0, 0.02, float(1).sub(ink))))
}

/**
 * 半色调：在编码值上计算，网点按输出图像的像素坐标排列，分块之间没有接缝。
 * 黑白为白纸上的黑色网点（墨量 = 1 − 亮度，网格 45°）；彩色转为 CMYK，四色网格为 15°、75°、0°、45°，按减色法合成。
 * 网点在屏幕上小于约 3 像素时逐渐退回原图，避免缩小的预览中出现摩尔纹。需在 Fn 中调用。
 */
function halftone(post: PostUniforms, c: Vec3Node, out: Vec2Node): Vec3Node {
  const e = srgbEncode(clamp(c, 0, 1)).toVar()
  // 两个分支共用的节点先求值，见 createFinishPass 的说明
  const px = out.mul(post.aspect).mul(post.long).toVar()
  const cell = post.halftoneCell.mul(post.long).toVar()
  const rotation = post.halftoneAngle
  const dots = vec3(0).toVar()
  If(post.halftoneColor.greaterThan(0.5), () => {
    const k = float(1).sub(max(e.r, max(e.g, e.b)))
    const cmy = vec3(1).sub(e).sub(k).div(max(float(1).sub(k), 1e-4))
    const paper = (ink: FloatNode, angle: number) => float(1).sub(dotCoverage(px, cell, angle, rotation, ink))
    dots.assign(vec3(paper(cmy.x, 15), paper(cmy.y, 75), paper(cmy.z, 0)).mul(paper(k, 45)))
  }).Else(() => {
    dots.assign(vec3(float(1).sub(dotCoverage(px, cell, 45, rotation, float(1).sub(dot(e, LUMA))))))
  })
  const amount = post.halftone.mul(smoothstep(2, 4, cell.mul(post.screenScale)))
  return srgbDecode(mix(e, dots, amount))
}

export interface FinishInputs {
  /** 全局调整后的线性图像 */
  image: TextureNode
  /** Bloom 金字塔（rgb 为 Bloom，a 为 Halation 的亮度）与光束的结果，覆盖整幅图像 */
  bloom: THREE.Texture
  /** 光学扩散金字塔的结果：参与扩散部分的模糊 */
  diffusion: THREE.Texture
  /** 柔焦金字塔的结果：整幅图像的模糊 */
  softFocus: THREE.Texture
  rays: THREE.Texture
  /** 光晕的可见度（1×1） */
  flareVisibility: THREE.Texture
  tile: TileMapping
}

/**
 * 各阶段写成依次赋值的语句，关闭的阶段整段跳过。
 * 注意不要把共用子表达式的节点放进 select：select 会生成 if/else，子表达式只在先构建的分支里求值，另一分支读到的是未赋值的变量。
 */
export function createFinishPass(u: FinishUniforms, post: PostUniforms, inputs: FinishInputs) {
  const bloomMap = texture(inputs.bloom)
  const diffusionMap = texture(inputs.diffusion)
  const softFocusMap = texture(inputs.softFocus)
  const raysMap = texture(inputs.rays)
  const visibilityMap = texture(inputs.flareVisibility)
  const out = inputs.tile.uv
  const node = Fn(() => {
    // uv 为画面内容的采样位置（失真后），out 为输出位置
    const uv = out.toVar()
    If(post.distortion.notEqual(0), () => {
      uv.assign(distort(post, out))
    })
    const c = aberration(post, inputs.image, inputs.tile, uv).toVar()
    // 钝化：减去一部分细节；与色差分开计算，色差的彩边保留
    If(post.soften.greaterThan(0), () => {
      c.addAssign(softenDetail(post, inputs.image, inputs.tile, uv).mul(post.soften))
    })
    // 光学扩散：参与扩散的部分 c·w 按比例换成它的模糊，总亮度不变
    If(post.diffusion.greaterThan(0), () => {
      const w = softThreshold(dot(c, LUMA), post.diffusionThreshold)
      c.addAssign(sampleAt(diffusionMap, uv, float(0)).rgb.sub(c.mul(w)).mul(post.diffusion))
    })
    // 柔焦：模糊副本提亮后按“变亮”逐通道叠加
    If(post.softFocus.greaterThan(0), () => {
      const b = sampleAt(softFocusMap, uv, float(0)).rgb.mul(post.softFocusGain)
      c.assign(mix(c, max(c, b), post.softFocus))
    })
    If(post.bloom.add(post.halation).greaterThan(0), () => {
      const bloom = sampleAt(bloomMap, uv, float(0))
      c.addAssign(bloom.rgb.mul(post.bloom).add(post.halationColor.mul(bloom.a.mul(post.halation))))
    })
    If(post.rays.greaterThan(0), () => {
      c.addAssign(sampleAt(raysMap, uv, float(0)).rgb.mul(post.rays))
    })
    If(post.flare.greaterThan(0), () => {
      c.addAssign(flareColor(post, uv).mul(post.flare.mul(sampleAt(visibilityMap, vec2(0.5), float(0)).r)))
    })
    // 暗角：椭圆形，画面角落处半径为 1
    const r = length(out.sub(0.5)).mul(Math.SQRT2)
    c.mulAssign(exp2(post.vignette.mul(smoothstep(post.vignetteRange.x, post.vignetteRange.y, r))))
    If(post.toneMapping.equal(1), () => {
      c.assign(agxToneMapping(c, float(1)))
    }).ElseIf(post.toneMapping.equal(2), () => {
      c.assign(neutralToneMapping(c, float(1)))
    })
    If(u.creative.greaterThan(0.5), () => {
      c.assign(creative(u, c))
    })
    If(post.halftone.greaterThan(0), () => {
      c.assign(halftone(post, c, out))
    })
    If(post.grain.greaterThan(0), () => {
      c.assign(grain(post, c, out))
    })
    return vec4(c, 1)
  })
  return material(node())
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
