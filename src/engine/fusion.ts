/**
 * 立绘融合的 TSL 节点（docs/Plan.md §3.3），参数由 src/fusion/params.ts 换算：
 * 边缘羽化 → 颜色匹配（白平衡、Oklab 影调与色度）→ 比值式重光照（含轮廓光、高光）→ Light Wrap → 噪声匹配。
 * 输入输出都是线性预乘 alpha。
 */
import * as THREE from 'three/webgpu'
import { atan, cos, dFdx, dFdy, dot, exp, float, hash, int, length, log2, max, min, mix, normalize, pow, saturate, select, sin, smoothstep, texture, textureSize, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { RIM_WIDTH } from '@/fusion/normals'
import { FUSION_LIGHTS, type FusionParams } from '@/fusion/params'
import { evalSh, fromOklab, sampleAt, srgbDecode, srgbEncode, toOklab, type FloatNode, type TextureNode, type TileMapping, type Vec3Node, type Vec4Node } from './nodes'

type Vec2Node = THREE.Node<'vec2'>

const LUMA = vec3(0.2126, 0.7152, 0.0722)

/** 三个控制点的单调 Hermite 曲线，控制点之外线性延伸（与 src/algo/curve.ts 一致） */
function evalCurve(x: FloatNode, xs: Vec3Node, ys: Vec3Node, ms: Vec3Node): FloatNode {
  const segment = (x0: FloatNode, x1: FloatNode, y0: FloatNode, y1: FloatNode, m0: FloatNode, m1: FloatNode) => {
    const h = max(x1.sub(x0), 1e-5)
    const t = saturate(x.sub(x0).div(h))
    const t2 = t.mul(t)
    const t3 = t2.mul(t)
    return t3
      .mul(2)
      .sub(t2.mul(3))
      .add(1)
      .mul(y0)
      .add(t3.sub(t2.mul(2)).add(t).mul(h).mul(m0))
      .add(t2.mul(3).sub(t3.mul(2)).mul(y1))
      .add(t3.sub(t2).mul(h).mul(m1))
  }
  const below = ys.x.add(ms.x.mul(x.sub(xs.x)))
  const above = ys.z.add(ms.z.mul(x.sub(xs.z)))
  const first = segment(xs.x, xs.y, ys.x, ys.y, ms.x, ms.y)
  const second = segment(xs.y, xs.z, ys.y, ys.z, ms.y, ms.z)
  return select(x.lessThan(xs.x), below, select(x.lessThan(xs.y), first, select(x.lessThan(xs.z), second, above)))
}

/** 近似单位方差的三角分布噪声，按输出图像的像素坐标取值；种子保持在 2^24 以内，避免浮点精度造成相邻像素重复 */
function pixelNoise(pixel: Vec2Node, channel: number): FloatNode {
  const px = pixel.floor()
  const row = hash(px.y.mul(3).add(channel)).mul(8388608).floor()
  const h1 = hash(row.add(px.x))
  const h2 = hash(h1.mul(8388608).floor())
  return h1.add(h2).sub(1).mul(Math.sqrt(6))
}

export interface FusionNodeInput {
  /** 文档像素坐标 */
  p: Vec2Node
  /** 立绘纹理坐标与采样节点（线性预乘，带 mipmap） */
  charUV: Vec2Node
  character: TextureNode
  /** 背景采样节点（带 mipmap），按 tile.toBackground 换算坐标 */
  background: TextureNode
  normalPlaceholder: THREE.Texture
  /** 轮廓光的边缘带（src/fusion/normals.ts 的 rimMap），带 mipmap */
  rimPlaceholder: THREE.Texture
  tile: TileMapping
  docSize: THREE.UniformNode<'vec2', THREE.Vector2>
  charSize: THREE.UniformNode<'vec2', THREE.Vector2>
  charRotation: THREE.UniformNode<'float', number>
  charScale: THREE.UniformNode<'float', number>
  charFlip: THREE.UniformNode<'float', number>
}

export function createFusionNode(input: FusionNodeInput) {
  const v3 = () => uniform(new THREE.Vector3())
  const u = {
    /** 0 时输出原始立绘（前后对比） */
    enabled: uniform(0),
    showNormals: uniform(0),
    cat: uniform(new THREE.Matrix3()),
    toneX: uniform(new THREE.Vector3(0, 0.5, 1)),
    toneY: uniform(new THREE.Vector3(0, 0.5, 1)),
    toneM: uniform(new THREE.Vector3(1, 1, 1)),
    chromaScale: uniform(1),
    tint: uniform(new THREE.Vector2()),
    tintL: uniform(0.5),
    skinProtect: uniform(0),

    relight: uniform(0),
    style: uniform(0),
    celThreshold: uniform(0),
    celSoftness: uniform(0.05),
    inverseReference: uniform(new THREE.Vector3(1, 1, 1)),
    sh: Array.from({ length: 9 }, v3),
    lights: Array.from({ length: FUSION_LIGHTS }, () => ({ type: uniform(0), vector: uniform(new THREE.Vector3(0, 0, 1)), color: v3(), softness: uniform(0) })),
    planeK: uniform(0),
    planeDepth: uniform(1),
    referenceDistance: uniform(1),
    rim: uniform(0),
    specular: uniform(0),
    mid: uniform(0.2),

    lightWrap: uniform(0),
    wrapRadius: uniform(1),
    feather: uniform(0),
    shrink: uniform(0),
    noise: v3(),
    /** 输出图像像素 / 文档像素，用于把噪声换算到当前分辨率 */
    targetScale: uniform(1),
    /** 边缘带距离的单位：原边缘带图的长边换算到当前边缘带纹理的像素数（立绘变形后纹理是重采样的） */
    rimLong: uniform(1),
  }
  const { p, charUV, character, background, tile, docSize, charSize, charScale } = input
  const texel = vec2(1).div(charSize).div(charScale)

  // 边缘羽化：alpha 有变化的地方用十字五点平均
  const center = character as unknown as Vec4Node
  const f = texel.mul(u.feather)
  const taps = [vec2(f.x, 0), vec2(f.x.negate(), 0), vec2(0, f.y), vec2(0, f.y.negate())].map((o) => sampleAt(character, charUV.add(o)))
  const average = taps.reduce<Vec4Node>((acc, t) => acc.add(t.mul(0.15)), center.mul(0.4))
  const alphas = taps.map((t) => t.a)
  const spread = alphas.reduce<FloatNode>((acc, a) => max(acc, a), center.a).sub(alphas.reduce<FloatNode>((acc, a) => min(acc, a), center.a))
  // 边缘收缩：alpha 取半径内八个方向的最小值，颜色不变
  const sr = texel.mul(u.shrink)
  const eroded = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1), vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071), vec2(0.7071, -0.7071), vec2(-0.7071, -0.7071)]
    .map((d) => sampleAt(character, charUV.add(d.mul(sr))).a)
    .reduce<FloatNode>((acc, a) => min(acc, a), center.a)
  const feathered = mix(center, average, saturate(spread.mul(8))).mul(saturate(eroded.div(max(center.a, 1e-4))))
  const alpha = feathered.a
  const straight = feathered.rgb.div(max(alpha, 1e-4))

  // 颜色匹配
  const lab = toOklab(max(u.cat.mul(straight), vec3(0)))
  const L = max(lab.x, 0)
  const L2 = max(evalCurve(L, u.toneX, u.toneY, u.toneM), 0)
  // 明度变化时色度等比缩放（相当于曝光变化），饱和度保持不变
  const ab0 = lab.yz.mul(L2.div(max(L, 1e-3)).clamp(0.25, 4))
  const chroma = length(lab.yz)
  const hue = atan(lab.z, lab.y).mul(180 / Math.PI)
  const skin = smoothstep(15, 25, hue)
    .mul(float(1).sub(smoothstep(95, 105, hue)))
    .mul(smoothstep(0.01, 0.02, chroma))
    .mul(float(1).sub(smoothstep(0.2, 0.25, chroma)))
    .mul(smoothstep(0.4, 0.45, L))
  const keep = float(1).sub(skin.mul(u.skinProtect).mul(0.7))
  const ab = ab0.mul(mix(1, u.chromaScale, keep)).add(u.tint.mul(keep).mul(saturate(L2.div(u.tintL))))
  const matched = max(fromOklab(vec3(L2, ab)), vec3(0))

  // 法线：立绘局部坐标（y 向上）→ 按立绘的翻转和旋转变换到相机空间
  const normalTex = texture(input.normalPlaceholder, charUV)
  const nl = normalTex.rgb.mul(2).sub(1)
  const nx = nl.x.mul(input.charFlip)
  const c = cos(input.charRotation)
  const s = sin(input.charRotation)
  const N = normalize(vec3(c.mul(nx).add(s.mul(nl.y)), s.negate().mul(nx).add(c.mul(nl.y)), nl.z))
  // 线稿遮罩取采样范围内不透明部分中非线稿的比例
  const rimTex = texture(input.rimPlaceholder, charUV)
  const lineMask = saturate(rimTex.g.div(max(rimTex.b, 1 / 255)))
  const nxy = N.xy.div(max(length(N.xy), 1e-4))

  // 重光照：像素在立绘平面上的相机空间位置，用于点光源的方向和衰减
  const P = vec3(p.x.sub(docSize.x.mul(0.5)).mul(u.planeK), docSize.y.mul(0.5).sub(p.y).mul(u.planeK), u.planeDepth.negate())
  let irradiance: Vec3Node = max(evalSh(u.sh, N), vec3(0))
  let rimLight: Vec3Node = vec3(0)
  let specLight: Vec3Node = vec3(0)
  for (const l of u.lights) {
    const toLight = l.vector.sub(P)
    const dist = length(toLight)
    const point = l.type
    const dir = normalize(mix(l.vector, toLight.div(max(dist, 1e-6)), point))
    const r = dist.div(u.referenceDistance)
    const color = l.color.mul(mix(1, float(1).div(r.mul(r).add(1)), point))
    const x = dot(N, dir)
    const wrap = max(x.add(l.softness).div(l.softness.add(1)), 0)
    const soft = x.add(1).mul(0.5).pow(2)
    const cel = smoothstep(u.celThreshold.sub(u.celSoftness), u.celThreshold.add(u.celSoftness), x)
    irradiance = irradiance.add(color.mul(select(u.style.equal(1), soft, select(u.style.equal(2), cel, wrap))))
    // 轮廓光：朝向光源一侧的边缘；光源在人物后方时整圈都有
    const lxy = dir.xy.div(max(length(dir.xy), 1e-4))
    const side = mix(saturate(dot(nxy, lxy)), 1, saturate(dir.z.negate()))
    rimLight = rimLight.add(color.mul(side).mul(saturate(dir.z.mul(-0.7).add(0.3))))
    const h = normalize(dir.add(vec3(0, 0, 1)))
    specLight = specLight.add(color.mul(pow(max(dot(N, h), 0), 40)))
  }
  // 边缘带 = alpha × (1 − 模糊 alpha)，轮廓光与 Light Wrap 共用
  const radius = u.wrapRadius
  const charLod = log2(max(radius.div(charScale), 1)).sub(1)
  const bgLod = log2(max(radius.mul(tile.uniforms.bgTexel), 1)).sub(1)
  const half = radius.mul(0.5)
  const diagonal = [vec2(1, 1), vec2(-1, 1), vec2(1, -1), vec2(-1, -1)]
  const blurredAlpha = diagonal
    .map((d) => sampleAt(character, charUV.add(d.mul(texel).mul(half)), charLod).a)
    .reduce<FloatNode>((acc, a) => acc.add(a), sampleAt(character, charUV, charLod).a)
    .div(5)
  const docUV = p.div(docSize)
  const blurredBg = diagonal
    .map((d) => sampleAt(background, tile.toBackground(docUV.add(d.mul(half).div(docSize))), bgLod).rgb)
    .reduce<Vec3Node>((acc, v) => acc.add(v), sampleAt(background, tile.toBackground(docUV), bgLod).rgb)
    .div(5)
  // 平方让混合集中在最外侧，避免整条边缘带发灰
  const edge = saturate(alpha.mul(float(1).sub(blurredAlpha)).mul(2)).pow(2)
  // 轮廓光的边缘带从外描边内侧算起，宽度随局部粗细变化
  const rimEdge = float(1).sub(rimTex.r).pow(2)
  // 立绘缩小到一个像素盖住多个引导像素时，最外一个像素不加轮廓光，留住描边或剪影本身的颜色，不形成一圈亮边
  const rimSize = vec2(textureSize(rimTex, int(0)) as unknown as THREE.Node<'ivec2'>)
  const guideUV = charUV.mul(rimSize)
  const footprint = max(length(dFdx(guideUV)), length(dFdy(guideUV)))
  const margin = max(footprint.sub(1), 0)
  const silhouette = rimTex.a.mul(u.rimLong.mul(RIM_WIDTH))
  const outer = saturate(silhouette.sub(margin).div(max(margin, 1e-3)))

  // 轮廓光同时看法线和剪影：合成法线在轮廓处不一定贴近像平面
  const ratio = irradiance.mul(u.inverseReference).clamp(0, 4)
  const fresnel = max(pow(float(1).sub(saturate(N.z)), 2), rimEdge)
  // 亮度以立绘中间调为基准（约为中间调的 2 倍），一半取立绘本身的颜色
  const rimRaw = rimLight.mul(fresnel.mul(u.rim).mul(lineMask).mul(outer)).mul(mix(vec3(u.mid), matched, 0.5).mul(2))
  // 亮度软限制在立绘本身亮度（不低于中间调）的 3 倍以内：逆光很强时不会饱和成一圈白边，一般强度下不变
  const rimY = dot(rimRaw, LUMA)
  const knee = max(dot(matched, LUMA), u.mid).mul(1.5)
  const rimLimited = select(rimY.lessThan(knee), rimY, knee.mul(float(2).sub(exp(rimY.div(knee).oneMinus()))))
  const rim = rimRaw.mul(rimLimited.div(max(rimY, 1e-6)))
  const spec = specLight.mul(u.specular.mul(u.mid).mul(2).mul(lineMask))
  const relit = matched.mul(mix(vec3(1), ratio, u.relight)).add(rim).add(spec)

  // Light Wrap：边缘带内与模糊背景做滤色混合
  const lit = min(relit, vec3(1))
  // 线稿基本不参与，保持描边清晰
  const wrapK = edge.mul(u.lightWrap).mul(mix(0.3, 1, lineMask))
  const wrapped = mix(relit, lit.add(blurredBg).sub(lit.mul(blurredBg)), wrapK)

  // 噪声匹配：在 sRGB 编码空间加噪，换算回线性后作为增量叠加（保留高光）
  const sigma = u.noise.mul(u.targetScale)
  const base = saturate(wrapped)
  const encoded = srgbEncode(base)
  const noisy = srgbDecode(saturate(encoded.add(vec3(pixelNoise(tile.pixel, 0), pixelNoise(tile.pixel, 1), pixelNoise(tile.pixel, 2)).mul(sigma))))
  const fused = max(wrapped.add(noisy.sub(base)), vec3(0))

  const color = mix(center, vec4(fused.mul(alpha), alpha), u.enabled)
  const normalView = srgbDecode(normalTex.rgb).mul(color.a)
  const output = mix(color, vec4(normalView, color.a), u.showNormals)
  // 轮廓光本身（预乘 alpha），后期的轮廓光束用它作为发光区域
  const rimGlow = vec4(rim.mul(alpha).mul(u.enabled), 1)
  return { uniforms: u, normal: normalTex, rim: rimTex, output, rimGlow }
}

export type FusionUniforms = ReturnType<typeof createFusionNode>['uniforms']

/** 把换算好的参数写入统一量 */
export function applyFusionParams(u: FusionUniforms, params: FusionParams): void {
  const m = params.cat
  u.cat.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
  u.toneX.value.set(...(params.tone.xs as [number, number, number]))
  u.toneY.value.set(...(params.tone.ys as [number, number, number]))
  u.toneM.value.set(...(params.tone.ms as [number, number, number]))
  u.chromaScale.value = params.chromaScale
  u.tint.value.set(...params.tint)
  u.tintL.value = params.tintL
  u.skinProtect.value = params.skinProtect

  u.relight.value = params.relight
  u.style.value = params.style
  u.celThreshold.value = params.cel.threshold
  u.celSoftness.value = Math.max(params.cel.softness, 1e-3)
  u.inverseReference.value.set(...params.inverseReference)
  u.sh.forEach((node, k) => node.value.set(params.ambient[k * 3], params.ambient[k * 3 + 1], params.ambient[k * 3 + 2]))
  u.lights.forEach((node, i) => {
    const l = params.lights[i]
    node.type.value = l?.type ?? 0
    node.vector.value.set(...(l?.vector ?? [0, 0, 1]))
    node.color.value.set(...(l?.color ?? [0, 0, 0]))
    node.softness.value = l?.softness ?? 0
  })
  u.planeK.value = params.plane.k
  u.planeDepth.value = params.plane.depth
  u.referenceDistance.value = Math.max(params.referenceDistance, 1e-6)
  u.rim.value = params.rim
  u.specular.value = params.specular
  u.mid.value = params.mid

  u.lightWrap.value = params.lightWrap
  u.wrapRadius.value = Math.max(params.wrapRadius, 1)
  u.feather.value = params.feather
  u.shrink.value = params.shrink
  u.noise.value.set(...params.noise)
}
