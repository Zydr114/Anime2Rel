/**
 * 后期效果中需要多个 pass 的部分（docs/Plan.md M5 实现方案）：Bloom 与 Halation 共用一个 mip 金字塔，光束为低分辨率的径向模糊。
 * 金字塔第 0 级的长边固定为 BLOOM_SIZE，与渲染分辨率无关，所以预览与导出的光晕相同；第 0 级由全分辨率图像的 mip 预滤波得到。
 * 结果在终处理 pass（src/engine/finish.ts）中叠加。
 */
import * as THREE from 'three/webgpu'
import { clamp, dot, exp, float, length, log, max, min, mix, screenUV, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import type { Size } from '@/algo/geometry'
import type { PostParams } from '@/grade/post'
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

    // 以下由终处理 pass 使用；强度为 0 时不叠加
    bloom: uniform(0),
    halation: uniform(0),
    halationColor: uniform(new THREE.Vector3(1, 0.1, 0)),
    rays: uniform(0),
    aberration: uniform(0),
    vignette: uniform(0),
    vignetteRange: uniform(new THREE.Vector2(0.35, 0.85)),
    toneMapping: uniform(0),
    grain: uniform(0),
    grainCell: uniform(0.001),
    grainColor: uniform(0),
  }
}

export type PostUniforms = ReturnType<typeof createPostUniforms>

export function applyPostParams(u: PostUniforms, p: PostParams | null, enabled: boolean): void {
  const on = enabled && !!p?.active
  u.bloom.value = on ? p!.bloom : 0
  u.halation.value = on ? p!.halation * HALATION_GAIN : 0
  u.rays.value = on && p!.raysLight ? p!.rays * RAYS_GAIN : 0
  u.aberration.value = on ? p!.aberration : 0
  u.vignette.value = on ? p!.vignette : 0
  u.toneMapping.value = on ? p!.toneMapping : 0
  u.grain.value = on ? p!.grain : 0
  if (!p) return
  u.bloomThreshold.value = p.bloomThreshold
  u.halationThreshold.value = p.halationThreshold
  u.scatter.value.set(p.bloomScatter, p.halationScatter)
  u.halationColor.value.set(...p.halationColor)
  u.raysThreshold.value = p.raysThreshold
  u.raysLength.value = p.raysLength
  if (p.raysLight) u.raysLight.value.set(p.raysLight.x, p.raysLight.y)
  u.skyOnly.value = p.skyOnly ? 1 : 0
  u.vignetteRange.value.set(p.vignetteInner, p.vignetteOuter)
  u.grainCell.value = p.grainCell
  u.grainColor.value = p.grainColor
}

/** 软阈值（带过渡区）：br 为亮度，返回乘到颜色上的权重 */
function softThreshold(br: FloatNode, t: FloatNode): FloatNode {
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

export interface PostTargets {
  down: THREE.RenderTarget[]
  /** up[k] 与 down[k] 同尺寸；最粗一级没有 up */
  up: THREE.RenderTarget[]
  /** 光束：遮罩与两张交替使用的模糊结果 */
  rays: THREE.RenderTarget[]
}

export function createPostTargets(): PostTargets {
  return {
    down: Array.from({ length: BLOOM_LEVELS }, halfTarget),
    up: Array.from({ length: BLOOM_LEVELS - 1 }, halfTarget),
    rays: Array.from({ length: 3 }, halfTarget),
  }
}

/** 各 pass 的材质和源图像素尺寸（随文档尺寸变化） */
export interface PostPasses {
  targets: PostTargets
  texels: THREE.UniformNode<'vec2', THREE.Vector2>[]
  bloom: { target: THREE.RenderTarget; quad: THREE.QuadMesh }[]
  rays: { target: THREE.RenderTarget; quad: THREE.QuadMesh }[]
  /** 叠加用的结果 */
  bloomResult: THREE.Texture
  raysResult: THREE.Texture
}

/**
 * 创建 Bloom 与光束的 pass。image 为全局调整后的线性图像（需有 mipmap），
 * sky 为背景的天空遮罩（hasSky 为 0 时不可用），character 为立绘层（预乘 alpha，需有 mipmap）。
 */
export function createPostPasses(u: PostUniforms, image: TextureNode, sky: FloatNode, hasSky: FloatNode, character: TextureNode): PostPasses {
  const targets = createPostTargets()
  const { down, up, rays } = targets
  const texels = Array.from({ length: BLOOM_LEVELS }, () => uniform(new THREE.Vector2(1, 1)))
  const quad = (node: Vec4Node) => new THREE.QuadMesh(material(node))
  const bloom: PostPasses['bloom'] = []

  // 第 0 级：在比它精细一级的 mip 上做 13 点降采样，再提取高光：Bloom 按最大通道，Halation 按亮度（只记亮度，存在 alpha 中）
  {
    const c = downsample(image, texels[0].mul(0.5), max(u.sourceLod.sub(1), 0)).rgb
    const l = dot(c, LUMA)
    bloom.push({ target: down[0], quad: quad(vec4(c.mul(softThreshold(max(c.r, max(c.g, c.b)), u.bloomThreshold)), l.mul(softThreshold(l, u.halationThreshold)))) })
  }
  for (let k = 1; k < BLOOM_LEVELS; k++) bloom.push({ target: down[k], quad: quad(downsample(texture(down[k - 1].texture), texels[k - 1], float(0))) })
  // 上采样：up_k = mix(down_k, tent(up_{k+1}), 散射)，由粗到细，各级权重之和为 1。
  // Halation 在第 0 级只保留扩散到高光以外的部分（模糊结果减去高光本身），表现为亮部边缘向暗处渗出的红晕
  for (let k = BLOOM_LEVELS - 2; k >= 0; k--) {
    const coarse = k === BLOOM_LEVELS - 2 ? down[k + 1] : up[k + 1]
    const d = sampleAt(texture(down[k].texture), screenUV, float(0))
    const t = tent(texture(coarse.texture), texels[k + 1])
    const rgb = mix(d.rgb, t.rgb, u.scatter.x)
    bloom.push({ target: up[k], quad: quad(vec4(rgb, k === 0 ? max(t.a.sub(d.a), 0) : mix(d.a, t.a, u.scatter.y))) })
  }

  // 光束遮罩：亮度超过阈值的像素（可限制为天空），离光源越远越弱，立绘挡住的部分不发光
  const raysPasses: PostPasses['rays'] = []
  const toLight = u.raysLight.sub(screenUV)
  const distance = length(toLight.mul(u.aspect))
  {
    const lod = max(u.sourceLod, 0)
    const c = sampleAt(image, screenUV, lod).rgb
    const skyWeight = mix(float(1), sky, u.skyOnly.mul(hasSky))
    const visible = float(1).sub(sampleAt(character, screenUV, lod).a)
    const phase = float(1).div(distance.div(RAYS_PHASE_RADIUS).pow(2).add(1))
    raysPasses.push({ target: rays[0], quad: quad(vec4(c.mul(softThreshold(dot(c, LUMA), u.raysThreshold).mul(skyWeight).mul(visible).mul(phase)), 1)) })
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
    raysPasses.push({ target: blurTarget(j), quad: quad(vec4(sum.div(RAYS_SAMPLES), 1)) })
  }

  return { targets, texels, bloom, rays: raysPasses, bloomResult: up[0].texture, raysResult: blurTarget(RAYS_PASSES - 1).texture }
}

/** 按文档尺寸设置金字塔和光束的尺寸 */
export function resizePostPasses(p: PostPasses, doc: Size): void {
  const sizes = bloomSizes(doc)
  sizes.forEach((s, k) => {
    p.targets.down[k].setSize(s.width, s.height)
    if (k < BLOOM_LEVELS - 1) p.targets.up[k].setSize(s.width, s.height)
    p.texels[k].value.set(1 / s.width, 1 / s.height)
  })
  for (const rt of p.targets.rays) rt.setSize(sizes[0].width, sizes[0].height)
}

export function renderPost(r: THREE.WebGPURenderer, p: PostPasses, which: { bloom: boolean; rays: boolean }): void {
  const run = (passes: PostPasses['bloom']) => {
    for (const { target, quad } of passes) {
      r.setRenderTarget(target)
      quad.render(r)
    }
  }
  if (which.bloom) run(p.bloom)
  if (which.rays) run(p.rays)
}

export function disposePostPasses(p: PostPasses): void {
  for (const rt of [...p.targets.down, ...p.targets.up, ...p.targets.rays]) rt.dispose()
  for (const { quad } of [...p.bloom, ...p.rays]) (quad.material as THREE.Material).dispose()
}
