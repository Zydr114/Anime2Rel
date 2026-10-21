/**
 * 后期效果中需要多个 pass 的部分（docs/Plan.md M5 实现方案）：Bloom 与 Halation 共用一个 mip 金字塔，光束为低分辨率的径向模糊。
 * 光学扩散、柔焦（M8.8a）各用一个同样的金字塔。
 * 轮廓光束（M8.1）在光束遮罩中加入立绘的轮廓光，轮廓光由融合节点在光束的分辨率上单独渲染一次。
 * 镜头光晕（M8.2）的可见度在这里渲染到 1×1 的目标，见 src/engine/flare.ts。
 * 各金字塔第 0 级的长边固定为 BLOOM_SIZE，与渲染分辨率无关，所以预览与导出的光晕相同；第 0 级由全分辨率图像的 mip 预滤波得到。
 * 结果在终处理 pass（src/engine/finish.ts）中叠加。
 */
import * as THREE from 'three/webgpu'
import { clamp, dot, exp, float, length, log, max, min, mix, screenUV, texture, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl'
import type { Size } from '@/algo/geometry'
import { MAX_FLARE_ELEMENTS } from '@/grade/flare'
import type { PostParams } from '@/grade/post'
import { FLARE_VEC4S, flareVisibility } from './flare'
import { material, sampleAt, type FloatNode, type TextureNode, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'

/** 金字塔第 0 级的长边（像素） */
export const BLOOM_SIZE = 1024
/** 金字塔级数：最粗一级的长边为 BLOOM_SIZE / 2^(BLOOM_LEVELS − 1) */
export const BLOOM_LEVELS = 8
/** 光束每个 pass 的采样数和 pass 数：等效于 RAYS_SAMPLES^RAYS_PASSES 个采样 */
const RAYS_SAMPLES = 8
const RAYS_PASSES = 3
/** 光束强度满格时的倍数 */
const RAYS_GAIN = 1
/** 轮廓光束强度满格时的倍数：轮廓光只是一条窄带，径向模糊后比大片的天空弱得多 */
const RIM_RAYS_GAIN = 32
/** 光束的发光区域按到光源的距离（相对长边）衰减：1 / (1 + (d / R)²)，近似前向散射的相函数 */
const RAYS_PHASE_RADIUS = 0.3
/** Halation 强度满格时的倍数（只取扩散到高光外的部分，比 Bloom 弱） */
const HALATION_GAIN = 2
/** 沿光线的衰减 exp(−RAYS_DECAY · 距离 / 长度)；采样范围到 RAYS_REACH 倍长度为止（此时权重已可忽略），且不超过到光源距离的 RAYS_MAX_SPAN */
const RAYS_DECAY = 3
const RAYS_REACH = 2
const RAYS_MAX_SPAN = 0.97
const LUMA = vec3(0.2126, 0.7152, 0.0722)

function halfTarget(): THREE.RenderTarget {
  return new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
}

/** 各级金字塔的尺寸，只与文档的宽高比有关 */
export function bloomSizes(doc: Size): Size[] {
  const s = BLOOM_SIZE / Math.max(doc.width, doc.height)
  return Array.from({ length: BLOOM_LEVELS }, (_, k) => ({
    width: Math.max(1, Math.round((doc.width * s) / 2 ** k)),
    height: Math.max(1, Math.round((doc.height * s) / 2 ** k)),
  }))
}

export function createPostUniforms() {
  return {
    /** log2(渲染长边 / BLOOM_SIZE)：从全分辨率图像采样第 0 级时使用的 mip 层级 */
    sourceLod: uniform(0),
    /** 渲染尺寸相对长边的比例 */
    aspect: uniform(new THREE.Vector2(1, 1)),
    /** 渲染长边（像素） */
    long: uniform(1),
    bloomThreshold: uniform(1),
    halationThreshold: uniform(1),
    /** Bloom、Halation 的散射 */
    scatter: uniform(new THREE.Vector2(0.6, 0.5)),
    raysThreshold: uniform(1),
    raysLength: uniform(0.5),
    raysLight: uniform(new THREE.Vector2(0.5, 0)),
    /** 1 为只让天空发光（且有深度） */
    skyOnly: uniform(0),
    /** 光束遮罩中亮部与轮廓光的权重 */
    raysSky: uniform(0),
    raysRim: uniform(0),
    /** 光晕的光源位置（文档 UV）；1 为方向光，落在非天空处时视为被遮挡 */
    flareLight: uniform(new THREE.Vector2(0.5, 0.5)),
    flareSky: uniform(0),

    // 以下由终处理 pass 使用；强度为 0 时不叠加
    bloom: uniform(0),
    /** 光学扩散移到周围的比例、线性亮度阈值、散射 */
    diffusion: uniform(0),
    diffusionThreshold: uniform(0),
    diffusionScatter: uniform(0.6),
    /** 柔焦的强度、散射、模糊副本的倍数 */
    softFocus: uniform(0),
    softFocusScatter: uniform(0.45),
    softFocusGain: uniform(1),
    /** 钝化的强度、半径（相对长边） */
    soften: uniform(0),
    softenRadius: uniform(0.001),
    halation: uniform(0),
    halationColor: uniform(new THREE.Vector3(1, 0.1, 0)),
    rays: uniform(0),
    aberration: uniform(0),
    /** 镜头失真的 a（0 为不失真）与填满画面的缩放 */
    distortion: uniform(0),
    distortionZoom: uniform(1),
    vignette: uniform(0),
    vignetteRange: uniform(new THREE.Vector2(0.35, 0.85)),
    toneMapping: uniform(0),
    grain: uniform(0),
    grainCell: uniform(0.001),
    grainColor: uniform(0),
    /** 半色调的强度、网点间距（相对长边）、网格角度（弧度）、彩色为 1 */
    halftone: uniform(0),
    halftoneCell: uniform(0.005),
    halftoneAngle: uniform(0),
    halftoneColor: uniform(0),
    /** 屏幕像素 / 渲染像素：预览缩小显示时网点过小，逐渐退回原图；导出为 1 */
    screenScale: uniform(1),
    flare: uniform(0),
    flareCount: uniform(0, 'int'),
    /** 各光晕元素的参数，每个元素 FLARE_VEC4S 个 vec4，见 packFlareElements */
    flareParams: uniformArray(
      Array.from({ length: MAX_FLARE_ELEMENTS * FLARE_VEC4S }, () => new THREE.Vector4()),
      'vec4',
    ),
  }
}

export type PostUniforms = ReturnType<typeof createPostUniforms>

/** distortion 为是否显示镜头失真：预览只在镜头、导出步骤中显示 */
export function applyPostParams(u: PostUniforms, p: PostParams | null, enabled: boolean, distortion: boolean): void {
  const on = enabled && !!p?.active
  u.bloom.value = on ? p!.bloom : 0
  u.diffusion.value = on ? p!.diffusion : 0
  u.softFocus.value = on ? p!.softFocus : 0
  u.soften.value = on ? p!.soften : 0
  u.halation.value = on ? p!.halation * HALATION_GAIN : 0
  u.rays.value = on && p!.raysLight && (p!.rays > 0 || p!.raysRim > 0) ? RAYS_GAIN : 0
  u.aberration.value = on ? p!.aberration : 0
  u.distortion.value = on && distortion ? p!.distortion : 0
  u.vignette.value = on ? p!.vignette : 0
  u.toneMapping.value = on ? p!.toneMapping : 0
  u.grain.value = on ? p!.grain : 0
  u.halftone.value = on ? p!.halftone : 0
  u.flare.value = on && p!.flareLight && p!.flareCount > 0 ? p!.flare : 0
  if (!p) return
  u.bloomThreshold.value = p.bloomThreshold
  u.diffusionThreshold.value = p.diffusionThreshold
  u.diffusionScatter.value = p.diffusionScatter
  u.softFocusScatter.value = p.softFocusScatter
  u.softFocusGain.value = p.softFocusGain
  u.softenRadius.value = p.softenRadius
  u.halationThreshold.value = p.halationThreshold
  u.scatter.value.set(p.bloomScatter, p.halationScatter)
  u.halationColor.value.set(...p.halationColor)
  u.raysThreshold.value = p.raysThreshold
  u.raysLength.value = p.raysLength
  u.raysSky.value = p.rays
  u.raysRim.value = p.raysRim * RIM_RAYS_GAIN
  if (p.raysLight) u.raysLight.value.set(p.raysLight.x, p.raysLight.y)
  u.skyOnly.value = p.skyOnly ? 1 : 0
  u.vignetteRange.value.set(p.vignetteInner, p.vignetteOuter)
  u.distortionZoom.value = p.distortionZoom
  u.grainCell.value = p.grainCell
  u.grainColor.value = p.grainColor
  u.halftoneCell.value = p.halftoneCell
  u.halftoneAngle.value = p.halftoneAngle
  u.halftoneColor.value = p.halftoneColor ? 1 : 0
  if (p.flareLight) u.flareLight.value.set(p.flareLight.x, p.flareLight.y)
  u.flareSky.value = p.flareSky ? 1 : 0
  u.flareCount.value = p.flareCount
  ;(u.flareParams.array as THREE.Vector4[]).forEach((v, i) => v.fromArray(p.flareElements, i * 4))
}

/** 软阈值（带过渡区）：br 为亮度，返回乘到颜色上的权重 */
export function softThreshold(br: FloatNode, t: FloatNode): FloatNode {
  const knee = max(t.mul(0.5), 1e-4)
  const soft = clamp(br.sub(t).add(knee), 0, knee.mul(2))
  return max(soft.mul(soft).div(knee.mul(4)), br.sub(t)).div(max(br, 1e-4))
}

/** 13 点降采样（Jimenez 2014），texel 为源图像素在 UV 中的尺寸 */
function downsample(t: TextureNode, texel: Vec2Node, lod: FloatNode): Vec4Node {
  const s = (x: number, y: number) => sampleAt(t, screenUV.add(texel.mul(vec2(x, y))), lod)
  const corners = s(-2, -2).add(s(2, -2)).add(s(-2, 2)).add(s(2, 2))
  const edges = s(0, -2).add(s(-2, 0)).add(s(2, 0)).add(s(0, 2))
  const inner = s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1))
  return s(0, 0).mul(0.125).add(corners.mul(0.03125)).add(edges.mul(0.0625)).add(inner.mul(0.125))
}

/** 3×3 帐篷滤波上采样，texel 为源图像素在 UV 中的尺寸 */
function tent(t: TextureNode, texel: Vec2Node): Vec4Node {
  let sum: Vec4Node = vec4(0)
  for (let y = -1; y <= 1; y++)
    for (let x = -1; x <= 1; x++) sum = sum.add(sampleAt(t, screenUV.add(texel.mul(vec2(x, y))), float(0)).mul((2 - Math.abs(x)) * (2 - Math.abs(y))))
  return sum.div(16)
}

type Pass = { target: THREE.RenderTarget; quad: THREE.QuadMesh }
type Texel = THREE.UniformNode<'vec2', THREE.Vector2>

const pass = (target: THREE.RenderTarget, node: Vec4Node): Pass => ({ target, quad: new THREE.QuadMesh(material(node)) })

/** mip 金字塔：down 为各级降采样，up[k] 与 down[k] 同尺寸，最粗一级没有 up；结果在 up[0] */
interface Pyramid {
  down: THREE.RenderTarget[]
  up: THREE.RenderTarget[]
}

function pyramidTargets(): Pyramid {
  return { down: Array.from({ length: BLOOM_LEVELS }, halfTarget), up: Array.from({ length: BLOOM_LEVELS - 1 }, halfTarget) }
}

/** 第 0 级的源：在比它精细一级的 mip 上做 13 点降采样 */
function pyramidSource(u: PostUniforms, image: TextureNode, texels: Texel[]): Vec3Node {
  return downsample(image, texels[0].mul(0.5), max(u.sourceLod.sub(1), 0)).rgb
}

/**
 * 金字塔的各个 pass：第 0 级写入 level0，再逐级 13 点降采样；然后由粗到细上采样，
 * up_k = combine(down_k, tent(up_{k+1}), k)，通常为按散射混合，各级权重之和为 1
 */
function pyramidPasses(p: Pyramid, texels: Texel[], level0: Vec4Node, combine: (d: Vec4Node, t: Vec4Node, k: number) => Vec4Node): Pass[] {
  const passes = [pass(p.down[0], level0)]
  for (let k = 1; k < BLOOM_LEVELS; k++) passes.push(pass(p.down[k], downsample(texture(p.down[k - 1].texture), texels[k - 1], float(0))))
  for (let k = BLOOM_LEVELS - 2; k >= 0; k--) {
    const coarse = k === BLOOM_LEVELS - 2 ? p.down[k + 1] : p.up[k + 1]
    const d = sampleAt(texture(p.down[k].texture), screenUV, float(0))
    passes.push(pass(p.up[k], combine(d, tent(texture(coarse.texture), texels[k + 1]), k)))
  }
  return passes
}

export interface PostTargets {
  bloom: Pyramid
  diffusion: Pyramid
  softFocus: Pyramid
  /** 光束：遮罩与两张交替使用的模糊结果 */
  rays: THREE.RenderTarget[]
  /** 轮廓光束的发光区域 */
  rim: THREE.RenderTarget
  /** 光晕的可见度（1×1） */
  visibility: THREE.RenderTarget
}

export function createPostTargets(): PostTargets {
  return {
    bloom: pyramidTargets(),
    diffusion: pyramidTargets(),
    softFocus: pyramidTargets(),
    rays: Array.from({ length: 3 }, halfTarget),
    rim: halfTarget(),
    visibility: halfTarget(),
  }
}

/** 各 pass 的材质和源图像素尺寸（随文档尺寸变化） */
export interface PostPasses {
  targets: PostTargets
  /** 各级金字塔的像素在 UV 中的尺寸，几个金字塔共用 */
  texels: Texel[]
  bloom: Pass[]
  diffusion: Pass[]
  softFocus: Pass[]
  rays: Pass[]
  rim: Pass
  visibility: Pass
  /** 叠加用的结果 */
  bloomResult: THREE.Texture
  diffusionResult: THREE.Texture
  softFocusResult: THREE.Texture
  raysResult: THREE.Texture
  visibilityResult: THREE.Texture
}

/**
 * 创建 Bloom、光学扩散、柔焦、光束和光晕可见度的 pass。image 为全局调整后的线性图像（需有 mipmap），
 * skyMap 为背景的深度辅助图（g 为天空遮罩，hasSky 为 0 时不可用），character 为立绘层（预乘 alpha，需有 mipmap），rimGlow 为融合节点输出的轮廓光。
 */
export function createPostPasses(u: PostUniforms, image: TextureNode, skyMap: TextureNode, hasSky: FloatNode, character: TextureNode, rimGlow: Vec4Node): PostPasses {
  const targets = createPostTargets()
  const { rays } = targets
  const texels = Array.from({ length: BLOOM_LEVELS }, () => uniform(new THREE.Vector2(1, 1)))

  // Bloom：第 0 级提取高光，Bloom 按最大通道，Halation 按亮度（只记亮度，存在 alpha 中）。
  // Halation 在第 0 级只保留扩散到高光以外的部分（模糊结果减去高光本身），表现为亮部边缘向暗处渗出的红晕
  const source = pyramidSource(u, image, texels)
  const l = dot(source, LUMA)
  const bloom = pyramidPasses(
    targets.bloom,
    texels,
    vec4(source.mul(softThreshold(max(source.r, max(source.g, source.b)), u.bloomThreshold)), l.mul(softThreshold(l, u.halationThreshold))),
    (d, t, k) => vec4(mix(d.rgb, t.rgb, u.scatter.x), k === 0 ? max(t.a.sub(d.a), 0) : mix(d.a, t.a, u.scatter.y)),
  )
  // 光学扩散：按亮度的软阈值取出参与扩散的部分 c·w，结果为它按能量归一化的模糊
  const diffusion = pyramidPasses(targets.diffusion, texels, vec4(source.mul(softThreshold(l, u.diffusionThreshold)), 1), (d, t) =>
    vec4(mix(d.rgb, t.rgb, u.diffusionScatter), 1),
  )
  // 柔焦：整幅图像的中等半径模糊，不设阈值
  const softFocus = pyramidPasses(targets.softFocus, texels, vec4(source, 1), (d, t) => vec4(mix(d.rgb, t.rgb, u.softFocusScatter), 1))

  // 光束遮罩：亮度超过阈值的像素（可限制为天空），离光源越远越弱，立绘挡住的部分不发光；
  // 再加上立绘的轮廓光（不受阈值和距离影响），光束从立绘边缘向外散开
  const raysPasses: Pass[] = []
  const toLight = u.raysLight.sub(screenUV)
  const distance = length(toLight.mul(u.aspect))
  const rim = pass(targets.rim, rimGlow)
  {
    const lod = max(u.sourceLod, 0)
    const c = sampleAt(image, screenUV, lod).rgb
    const skyWeight = mix(float(1), sampleAt(skyMap, screenUV).g, u.skyOnly.mul(hasSky))
    const visible = float(1).sub(sampleAt(character, screenUV, lod).a)
    const phase = float(1).div(distance.div(RAYS_PHASE_RADIUS).pow(2).add(1))
    const bright = c.mul(softThreshold(dot(c, LUMA), u.raysThreshold).mul(skyWeight).mul(visible).mul(phase))
    const glow = sampleAt(texture(targets.rim.texture), screenUV, float(0)).rgb
    raysPasses.push(pass(rays[0], vec4(bright.mul(u.raysSky).add(glow.mul(u.raysRim)), 1)))
  }
  // 径向模糊：采样点 p + (光源 − p)·(1 − σ)，σ 在对数空间均匀分布；三个 pass 的步长依次乘以 RAYS_SAMPLES，合起来是均匀的 RAYS_SAMPLES^3 个采样。
  // 各 pass 按走过的距离指数衰减，几个 pass 的距离近似相加，合起来仍是按总距离衰减
  const rayLength = max(u.raysLength, 0.02)
  const span = min(RAYS_MAX_SPAN, rayLength.mul(RAYS_REACH).div(max(distance, 1e-4)))
  const lambda = log(float(1).sub(span)).negate().div(RAYS_SAMPLES ** RAYS_PASSES)
  // 第 j 个 pass 写入 rays[1]、rays[2] 交替，第一个 pass 读遮罩
  const blurTarget = (j: number) => rays[j % 2 === 0 ? 1 : 2]
  for (let j = 0; j < RAYS_PASSES; j++) {
    const src = texture((j === 0 ? rays[0] : blurTarget(j - 1)).texture)
    let sum: Vec3Node = vec3(0)
    for (let i = 0; i < RAYS_SAMPLES; i++) {
      const t = float(1).sub(exp(lambda.mul(-(RAYS_SAMPLES ** j) * i)))
      const weight = exp(distance.mul(t).div(rayLength).mul(-RAYS_DECAY))
      sum = sum.add(sampleAt(src, screenUV.add(toLight.mul(t)), float(0)).rgb.mul(weight))
    }
    raysPasses.push(pass(blurTarget(j), vec4(sum.div(RAYS_SAMPLES), 1)))
  }

  const visibility = pass(targets.visibility, flareVisibility(u, character, skyMap, hasSky))
  return {
    targets,
    texels,
    bloom,
    diffusion,
    softFocus,
    rays: raysPasses,
    rim,
    visibility,
    bloomResult: targets.bloom.up[0].texture,
    diffusionResult: targets.diffusion.up[0].texture,
    softFocusResult: targets.softFocus.up[0].texture,
    raysResult: blurTarget(RAYS_PASSES - 1).texture,
    visibilityResult: targets.visibility.texture,
  }
}

/** 按文档尺寸设置金字塔和光束的尺寸 */
export function resizePostPasses(p: PostPasses, doc: Size): void {
  const sizes = bloomSizes(doc)
  sizes.forEach((s, k) => {
    for (const { down, up } of [p.targets.bloom, p.targets.diffusion, p.targets.softFocus]) {
      down[k].setSize(s.width, s.height)
      if (k < BLOOM_LEVELS - 1) up[k].setSize(s.width, s.height)
    }
    p.texels[k].value.set(1 / s.width, 1 / s.height)
  })
  for (const rt of [...p.targets.rays, p.targets.rim]) rt.setSize(sizes[0].width, sizes[0].height)
}

/** rim 为是否需要轮廓光束：不需要时遮罩中的权重为 0，不必更新轮廓光 */
export function renderPost(r: THREE.WebGPURenderer, p: PostPasses, which: { bloom: boolean; diffusion: boolean; softFocus: boolean; rays: boolean; rim: boolean; flare: boolean }): void {
  const run = (passes: Pass[]) => {
    for (const { target, quad } of passes) {
      r.setRenderTarget(target)
      quad.render(r)
    }
  }
  if (which.bloom) run(p.bloom)
  if (which.diffusion) run(p.diffusion)
  if (which.softFocus) run(p.softFocus)
  if (which.rays && which.rim) run([p.rim])
  if (which.rays) run(p.rays)
  if (which.flare) run([p.visibility])
}

export function disposePostPasses(p: PostPasses): void {
  const { bloom, diffusion, softFocus, rays, rim, visibility } = p.targets
  for (const rt of [...[bloom, diffusion, softFocus].flatMap((q) => [...q.down, ...q.up]), ...rays, rim, visibility]) rt.dispose()
  for (const { quad } of [...p.bloom, ...p.diffusion, ...p.softFocus, ...p.rays, p.rim, p.visibility]) (quad.material as THREE.Material).dispose()
}
