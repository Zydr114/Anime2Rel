// 渲染各阶段使用的 TSL 材质。所有中间结果都是线性 sRGB；立绘使用预乘 alpha。
import * as THREE from 'three/webgpu'
import { abs, cos, dot, exp, float, fract, fwidth, length, log2, max, mix, saturate, screenCoordinate, screenUV, select, sin, smoothstep, sqrt, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { belowWaterline, cocPx, isMode, MODE, occlusionStyles, reflectance, REFLECTION_BLUR, reflectionOffset, refraction, sampleLevel, waterDepth, waterEdge, waterWave, type DofUniforms } from './dof'
import { DEPTH_SHIFT } from '@/focus/dof'
import { srgbToLinear } from '@/algo/color'
import { SURROUND } from './backdrop'
import { createFusionNode } from './fusion'
import type { ShadowUniforms } from './shadow'
import { dustLight, type AtmosphereUniforms } from './atmosphere'
import { evalSh, material, sampleAt, srgbDecode, srgbEncode, type FloatNode, type TileMapping, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'

/**
 * 立绘预处理：sRGB 直通 alpha → 线性预乘 alpha，写入带 mipmap 的半精度纹理。
 * 去除残留底色时，半透明像素在原分辨率上按 I = αF + (1 − α)B 再解一次前景色（sRGB 编码空间）：
 * 邻域的 F、B 取 Worker 在引导分辨率上的估计（src/fusion/matte.ts），权重随 alpha 梯度增大。
 */
export function createCharPrepPass(placeholder: THREE.Texture, mattePlaceholders: readonly [THREE.Texture, THREE.Texture]) {
  const src = texture(placeholder, screenUV)
  // 各用一张占位纹理：参数完全相同的纹理节点在编译时会合并成同一个绑定
  const foreground = texture(mattePlaceholders[0], screenUV)
  const background = texture(mattePlaceholders[1], screenUV)
  const u = { texel: uniform(new THREE.Vector2(1, 1)), matte: uniform(0) }
  const a = src.a
  const a1 = float(1).sub(a)
  const w = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)]
    .map((o) => abs(sampleAt(src, screenUV.add(o.mul(u.texel))).a.sub(a)))
    .reduce<FloatNode>((acc, v) => acc.add(v), float(4e-5))
  const a00 = a.mul(a).add(w)
  const a01 = a.mul(a1)
  const a11 = a1.mul(a1).add(w)
  const I = srgbEncode(src.rgb)
  const b0 = I.mul(a).add(foreground.rgb.mul(w))
  const b1 = I.mul(a1).add(background.rgb.mul(w))
  const solved = srgbDecode(saturate(b0.mul(a11).sub(b1.mul(a01)).div(a00.mul(a11).sub(a01.mul(a01)))))
  // 完全不透明的像素保持原色
  const rgb = mix(src.rgb, select(a.lessThan(0.999), solved, src.rgb), u.matte)
  return {
    source: src,
    foreground,
    background,
    uniforms: u,
    material: material(vec4(rgb.mul(a), a)),
  }
}

/** 调试视图编号，与 composite 材质的 view 统一量对应 */
export const DEBUG_VIEW_INDEX = { composite: 0, depth: 1, normal: 2, sky: 3, focus: 4 } as const

/** 深度图层的纹理：引导滤波系数、辅助数据（未对齐深度、天空）、法线。 */
export interface DepthTextures {
  coef: THREE.Texture
  aux: THREE.Texture
  normal: THREE.Texture
}

/** 灰球预览最多使用的光源数，与 src/lighting/model.ts 的 MAX_LIGHTS 一致 */
export const PREVIEW_LIGHTS = 8

/**
 * 灰球预览：在文档空间画一个漫反射球，着色公式与 src/algo/shading.ts 的 shade 一致。
 * 返回叠加到 color 上的结果；showBall 为 0 时原样返回。
 */
function ballOverlay(color: Vec3Node, p: THREE.Node<'vec2'>) {
  const u = {
    showBall: uniform(0),
    ballCenter: uniform(new THREE.Vector2(0, 0)),
    ballRadius: uniform(1),
    sh: Array.from({ length: 9 }, () => uniform(new THREE.Vector3())),
    lights: Array.from({ length: PREVIEW_LIGHTS }, () => ({ direction: uniform(new THREE.Vector3(0, 0, 1)), color: uniform(new THREE.Vector3()), softness: uniform(0) })),
  }
  const q = p.sub(u.ballCenter).div(u.ballRadius)
  const r = length(q)
  const aa = max(fwidth(r), 1e-4)
  // 文档 y 向下，法线 y 向上
  const n = vec3(q.x, q.y.negate(), sqrt(max(float(1).sub(dot(q, q)), 0)))
  const irradiance = u.lights.reduce<Vec3Node>(
    (acc, l) => acc.add(l.color.mul(max(dot(n, l.direction).add(l.softness).div(l.softness.add(1)), 0))),
    max(evalSh(u.sh, n), vec3(0)),
  )
  const inside = saturate(float(1).sub(r).div(aa).add(0.5)).mul(u.showBall)
  // 球外 1.5 px 的暗色描边，在亮背景上也能看清轮廓
  const ring = saturate(float(1).sub(abs(r.sub(1).sub(aa.mul(1.5))).div(aa.mul(1.5)))).mul(u.showBall)
  const outlined = mix(color, color.mul(0.3), ring)
  return { uniforms: u, color: mix(outlined, irradiance, inside) }
}

/** 立绘推理时垫底的中性灰（sRGB 编码值），与 src/depth/pipeline.ts 一致 */
const NEUTRAL_GRAY = 128 / 255
/** 天空遮罩视图的着色（线性） */
const SKY_TINT = vec3(0.05, 0.35, 1.0)
/** 景深视图：近景、远景的着色（线性）；遮罩预览的颜色 */
const NEAR_TINT = vec3(0.05, 0.3, 1.0)
const FAR_TINT = vec3(1.0, 0.4, 0.03)
const MASK_TINT = vec3(1.0, 0.05, 0.05)
/** 局部调整蒙版预览的不透明度 */
const MASK_ALPHA = 0.5
/** 景深视图中着色饱和时的弥散圆半径（相对图像长边） */
const FOCUS_VIEW_SCALE = 0.004

type TextureNode = THREE.TextureNode

function luma(c: Vec3Node): FloatNode {
  return dot(c, vec3(0.2126, 0.7152, 0.0722))
}

/**
 * 立绘在文档中的摆放：文档像素坐标、立绘纹理坐标、是否在立绘纹理范围内。各个 pass 共用同一组统一量。
 * 立绘变形后，立绘纹理是变形后的包围盒（见 src/engine/warp.ts）：charSize 为包围盒的尺寸、charOffset 为包围盒中心相对原立绘中心的偏移（原立绘像素）。
 */
export function createPlacement(tile: TileMapping) {
  const u = {
    docSize: uniform(new THREE.Vector2(1, 1)),
    charCenter: uniform(new THREE.Vector2(0, 0)),
    charRotation: uniform(0),
    charScale: uniform(1),
    charFlip: uniform(1),
    charSize: uniform(new THREE.Vector2(1, 1)),
    charOffset: uniform(new THREE.Vector2(0, 0)),
    hasChar: uniform(0),
  }
  const p = tile.uv.mul(u.docSize)
  /** 文档像素坐标 → 立绘纹理坐标；没有变形时与 src/algo/geometry.ts 的 docToLayerUV 一致 */
  const toCharUV = (q: Vec2Node) => {
    const d = q.sub(u.charCenter)
    const c = cos(u.charRotation)
    const s = sin(u.charRotation)
    const lx = c.mul(d.x).add(s.mul(d.y)).div(u.charScale).mul(u.charFlip)
    const ly = s.negate().mul(d.x).add(c.mul(d.y)).div(u.charScale)
    return vec2(lx, ly).sub(u.charOffset).div(u.charSize).add(0.5)
  }
  const charUV = toCharUV(p)
  const inside = step(0, charUV.x).mul(step(charUV.x, 1)).mul(step(0, charUV.y)).mul(step(charUV.y, 1)).mul(u.hasChar)
  return { uniforms: u, tile, p, charUV, inside, toCharUV }
}

export type Placement = ReturnType<typeof createPlacement>

/**
 * 背景与立绘的深度：引导分辨率的系数与全分辨率颜色组合，得到边缘锐利的深度。
 * 立绘的引导图是合成到中性灰上的 sRGB 颜色，与推理输入一致。立绘深度再加上深度修正的增量（r 通道，M8.6b）。
 */
export function createDepthNodes(
  placement: Placement,
  background: TextureNode,
  character: TextureNode,
  placeholder: { background: DepthTextures; character: DepthTextures },
  editPlaceholder: THREE.Texture,
) {
  const u = { edgeAlign: uniform(1), hasBgDepth: uniform(0), hasCharDepth: uniform(0) }
  const uv = placement.tile.uv
  const bgCoef = texture(placeholder.background.coef, uv)
  const bgAux = texture(placeholder.background.aux, uv)
  const bgNormal = texture(placeholder.background.normal, uv)
  const bgDepth = saturate(mix(bgAux.r, dot(bgCoef.rgb, srgbEncode(saturate(background.rgb))).add(bgCoef.a), u.edgeAlign))

  const straight = character.rgb.div(max(character.a, 1e-4))
  const chGuide = mix(vec3(NEUTRAL_GRAY), srgbEncode(saturate(straight)), character.a)
  const chCoef = texture(placeholder.character.coef, placement.charUV)
  const chAux = texture(placeholder.character.aux, placement.charUV)
  const chNormal = texture(placeholder.character.normal, placement.charUV)
  const chEdit = texture(editPlaceholder, placement.charUV)
  const chDepth = saturate(mix(chAux.r, dot(chCoef.rgb, chGuide).add(chCoef.a), u.edgeAlign)).add(chEdit.r)
  /** 立绘任意纹理坐标处的起伏，与 chDepth 的计算相同；sample 为该处立绘的采样结果（阴影贴图沿光线步进时用） */
  const characterReliefAt = (at: Vec2Node, sample: Vec4Node) => {
    const guide = mix(vec3(NEUTRAL_GRAY), srgbEncode(saturate(sample.rgb.div(max(sample.a, 1e-4)))), sample.a)
    const coef = sampleLevel(chCoef, at)
    return saturate(mix(sampleLevel(chAux, at).r, dot(coef.rgb, guide).add(coef.a), u.edgeAlign)).add(sampleLevel(chEdit, at).r)
  }
  return {
    uniforms: u,
    textures: {
      background: { coef: bgCoef, aux: bgAux, normal: bgNormal },
      character: { coef: chCoef, aux: chAux, normal: chNormal, edit: chEdit },
    },
    background: { depth: bgDepth, sky: bgAux.g, normal: bgNormal },
    character: { depth: chDepth, normal: chNormal, straight, reliefAt: characterReliefAt },
  }
}

export type DepthNodes = ReturnType<typeof createDepthNodes>

/** 立绘层：融合后的立绘按变换摆放到文档空间（线性预乘 alpha）。 */
export function createCharacterPass(placement: Placement, character: TextureNode, background: TextureNode, normalPlaceholder: THREE.Texture, rimPlaceholder: THREE.Texture) {
  const u = placement.uniforms
  const fusion = createFusionNode({
    p: placement.p,
    charUV: placement.charUV,
    character,
    background,
    normalPlaceholder,
    rimPlaceholder,
    tile: placement.tile,
    docSize: u.docSize,
    charSize: u.charSize,
    charRotation: u.charRotation,
    charScale: u.charScale,
    charFlip: u.charFlip,
  })
  return {
    fusion: fusion.uniforms,
    characterNormal: fusion.normal,
    characterRim: fusion.rim,
    material: material(fusion.output.mul(placement.inside)),
    rimGlow: fusion.rimGlow.mul(placement.inside),
  }
}

/** 合成使用的各图层纹理（均与渲染目标同尺寸） */
export interface LayerTextures {
  /** 背景层调整后的背景；alpha 为背景的归一化逆深度 */
  background: TextureNode
  prep: TextureNode
  backgroundDof: TextureNode
  character: TextureNode
  /** 立绘层调整后的立绘，景深与合成使用 */
  characterAdjusted: TextureNode
  /** 倒影：按水线上下镜像的位置渲染的立绘层（立绘层调整之后），带 mip，见 Engine.renderMirror */
  reflection: TextureNode
  characterDepth: TextureNode
  characterDof: TextureNode
  occlusion: TextureNode
  /** 站立阴影：背景的颜色倍率 */
  shadow: TextureNode
  /** 合成结果 */
  composited: TextureNode
  /** 全局调整与局部调整后的结果；局部调整 pass 在 alpha 中写入预览的蒙版 */
  adjusted: TextureNode
  /** 终处理的结果（预览时再叠加调试视图和灰球） */
  graded: TextureNode
}

/**
 * 最终合成：模糊背景（乘以站立阴影） → 模糊立绘 → 遮挡层（按区域和遮挡方式混合）→ 水面倒影 → 尘埃 → 遮罩预览。
 * 透明介质与水体按遮挡强度（介质的不透明度）普通覆盖，再在透出的立绘上叠加背景的高频细节；
 * 水体另外在水下部分做折射偏移、在水线处加高光，水线以下盖上立绘的倒影（水下的立绘也在水面之下）。
 * 调试视图和灰球在 createDisplayPass 中叠加，这里的纹理数要留在 WebGPU / WebGL2 每阶段 16 个的下限以内。
 */
export function createCompositePass(input: { placement: Placement; layers: LayerTextures; dof: DofUniforms; shadow: ShadowUniforms; atmosphere: AtmosphereUniforms }) {
  const { placement, layers, dof } = input

  // 阴影随地面一起离焦：按背景的弥散圆选用 mip；有雾时按接地点处的透过率减淡
  const prep = sampleLevel(layers.prep, screenUV)
  const shadowLod = log2(max(abs(prep.a), 1))
  const shadow = mix(vec3(1), sampleLevel(layers.shadow, screenUV, shadowLod).rgb, input.shadow.enabled.mul(input.atmosphere.contact))
  // 没有景深时直接用预处理后（已加雾）的背景
  const bg = mix(sampleLevel(layers.backgroundDof, screenUV).rgb, prep.rgb, dof.bypass).mul(shadow)
  const charDepth = sampleLevel(layers.characterDepth, screenUV)
  // 遮挡层取自背景，同样乘阴影：立绘纹理范围内比立绘近的地面（如脚前的地面）也算遮挡层，不乘的话盖在上面会抹掉那里的阴影
  const occlusion = sampleLevel(layers.occlusion, screenUV).mul(dof.occlusion)
  const occ = vec4(occlusion.rgb.mul(shadow), occlusion.a)

  // 按区域把各遮挡方式的权重和参数累加起来；水体的波纹取水体区域的加权平均
  const styles = occlusionStyles(dof, placement.tile.uv)
  const sum = (f: (s: (typeof styles)[number]) => FloatNode) => styles.reduce<FloatNode>((acc, s) => acc.add(f(s).mul(s.weight)), float(0))
  const water = sum((s) => isMode(s.mode, MODE.water)).mul(dof.occlusion)
  const ripple = sum((s) => isMode(s.mode, MODE.water).mul(s.ripple)).div(max(water, 1e-4))
  const highlightAmount = sum((s) => isMode(s.mode, MODE.water).mul(s.highlight)).mul(dof.occlusion)
  // 介质的范围：交界处的不透明度至少为 1 − 清澈度，按它把遮挡强度换算回“在介质中”的程度
  const detailAmount = sum((s) =>
    isMode(s.mode, MODE.medium)
      .add(isMode(s.mode, MODE.water))
      .mul(s.detail)
      .mul(saturate(occ.a.div(max(float(1).sub(s.clarity), 0.05)))),
  ).mul(dof.occlusion)
  const darkenWeight = sum((s) => isMode(s.mode, MODE.darken))
  const multiplyWeight = sum((s) => isMode(s.mode, MODE.multiply))

  // 水下部分的立绘按折射偏移采样（偏移是文档像素，换算到渲染目标的 UV）
  const p = placement.p
  const h = waterDepth(dof, p, waterWave(dof, p), ripple)
  const below = smoothstep(waterEdge(dof).negate(), waterEdge(dof), h).mul(water)
  const chUV = screenUV.add(refraction(dof, p, ripple).mul(below).div(placement.uniforms.docSize).div(placement.tile.uniforms.scale))
  const ch = mix(sampleLevel(layers.characterDof, chUV), sampleLevel(layers.characterAdjusted, chUV), dof.bypass)

  // 遮挡：不透明、透明介质、水体为普通覆盖；变暗与正片叠底只改变立绘自身的像素（遮挡层在立绘外就是背景本身）
  const occColor = occ.rgb.div(max(occ.a, 1e-4))
  const straight = ch.rgb.div(max(ch.a, 1e-4))
  const darker = smoothstep(-0.02, 0.02, luma(straight).sub(luma(occColor)))
  const darken = mix(straight, occColor, darker.mul(occ.a)).mul(ch.a)
  const multiply = ch.rgb.mul(mix(vec3(1), occColor, occ.a))
  const behindCh = bg.mul(float(1).sub(ch.a))
  const covered = occ.rgb.add(ch.rgb.add(behindCh).mul(float(1).sub(occ.a)))

  // 介质的表面细节：背景的高频部分，叠加在透出的立绘上；背景离焦时细节随之减弱
  const highPass = prep.rgb.sub(sampleLevel(layers.prep, screenUV, 2.5).rgb)
  const sharp = saturate(float(1).sub(abs(prep.a).div(4)))
  const detail = highPass.mul(detailAmount.mul(float(1).sub(occ.a)).mul(ch.a).mul(sharp))

  // 水线高光：水线处一条随波纹起伏的亮线，颜色偏向周围水面的颜色
  const band = exp(h.div(max(dof.charHeight.mul(0.006), 1)).pow(2).negate())
  const glint = mix(sampleLevel(layers.prep, screenUV, 3).rgb, vec3(1), 0.5)
  const highlight = glint.mul(highlightAmount.mul(band).mul(ch.a).mul(0.8))

  const occluded = covered
    .add(detail)
    .add(highlight)
    .mul(float(1).sub(darkenWeight).sub(multiplyWeight))
    .add(darken.add(behindCh).mul(darkenWeight))
    .add(multiply.add(behindCh).mul(multiplyWeight))
  // 水面倒影：镜像的立绘层按波纹扭曲采样，离水线越远、立绘越离焦越模糊；按反射率盖在水面上，颜色按水色过滤
  const reflectionWeight = sum((s) => isMode(s.mode, MODE.water).mul(s.reflection)).mul(dof.occlusion)
  // 各水体样式的倒影参数按权重平均
  const toWaterAverage = float(1).div(max(water, 1e-4))
  const reflectionBlur = sum((s) => isMode(s.mode, MODE.water).mul(s.reflectionBlur)).mul(toWaterAverage)
  const reflectionRipple = sum((s) => isMode(s.mode, MODE.water).mul(s.reflectionRipple)).mul(toWaterAverage)
  const waterColor = styles
    .reduce<Vec3Node>((acc, s) => acc.add(s.waterColor.mul(isMode(s.mode, MODE.water).mul(s.weight))), vec3(0))
    .mul(toWaterAverage)
  const docSize = placement.uniforms.docSize
  // 文档像素 → 渲染目标像素
  const toTarget = dof.targetLong.div(max(docSize.x, docSize.y))
  const blurPx = max(belowWaterline(dof, p), 0).mul(reflectionBlur.mul(REFLECTION_BLUR)).mul(toTarget)
  const planeCoc = cocPx(dof, float(1).div(dof.planeZ).sub(DEPTH_SHIFT))
  const reflectionLod = log2(max(length(vec2(blurPx, planeCoc)), 1))
  const reflectionUV = screenUV.add(reflectionOffset(dof, p, reflectionRipple).div(docSize).div(placement.tile.uniforms.scale))
  const mirrored = sampleLevel(layers.reflection, reflectionUV, reflectionLod)
  const surface = smoothstep(waterEdge(dof).negate(), waterEdge(dof), h)
  const R = saturate(reflectionWeight.mul(reflectance(dof, p, docSize)).mul(surface))
  const reflected = occluded.mul(float(1).sub(R.mul(mirrored.a))).add(mirrored.rgb.mul(waterColor).mul(R))

  // 尘埃：被比它近的景物挡住，立绘可见处按立绘深度、其余按背景深度（背景层的 alpha）
  const sceneDepth = mix(sampleLevel(layers.background, screenUV).a, charDepth.r, charDepth.a.mul(float(1).sub(charDepth.g)))
  const dust = dustLight(input.atmosphere, dof, { p, surface: sceneDepth })
  const rgb = mix(reflected.add(dust), MASK_TINT, charDepth.g.mul(charDepth.a).mul(dof.showMask).mul(0.6))
  return material(vec4(rgb, 1))
}

/** 深度画笔的伪彩色叠加的不透明度 */
const RELIEF_ALPHA = 0.65

/**
 * 预览显示：调色后的结果 → 调试视图 → 深度画笔的伪彩色 → 灰球。
 * view 不为 0 时按调试视图着色，再按 overlay 与合成结果混合。
 */
export function createDisplayPass(input: { placement: Placement; depth: DepthNodes; background: TextureNode; colormap: THREE.Texture; layers: LayerTextures; dof: DofUniforms }) {
  const { placement, depth, background, layers, dof } = input
  /** mask：叠加显示局部调整的蒙版（局部调整 pass 写在全局调整结果的 alpha 中） */
  const u = { view: uniform(0), overlay: uniform(1), relief: uniform(0), mask: uniform(0) }
  const rgb = sampleLevel(layers.graded, screenUV).rgb
  const charDepth = sampleLevel(layers.characterDepth, screenUV)
  const alpha = charDepth.a

  const cmap = (v: FloatNode) => srgbDecode(texture(input.colormap, vec2(v, 0.5)).rgb)
  const debugColor = (d: FloatNode, normal: Vec4Node, sky: Vec3Node) =>
    select(u.view.equal(1), cmap(d), select(u.view.equal(2), srgbDecode(normal.rgb).mul(mix(0.3, 1, normal.a)), sky))
  const bgSky = mix(background.rgb.mul(0.25), SKY_TINT, depth.background.sky.mul(0.8))
  const bgDebug = mix(background.rgb, debugColor(depth.background.depth, depth.background.normal, bgSky), depth.uniforms.hasBgDepth)
  const chStraight = depth.character.straight
  const chDebug = mix(chStraight, debugColor(depth.character.depth, depth.character.normal, chStraight.mul(0.25)), depth.uniforms.hasCharDepth)

  // 景深视图：合焦处为灰度，近景染蓝、远景染橙，颜色深浅表示弥散圆大小
  const coc = mix(sampleLevel(layers.prep, screenUV).a, charDepth.b, charDepth.a)
  const strength = saturate(abs(coc).div(dof.targetLong.mul(FOCUS_VIEW_SCALE))).mul(0.85)
  const focusView = mix(vec3(luma(rgb)), select(coc.greaterThan(0), NEAR_TINT, FAR_TINT), strength)

  const debug = select(u.view.equal(4), focusView, chDebug.mul(alpha).add(bgDebug.mul(float(1).sub(alpha))))
  const debugOut = mix(rgb, debug, u.overlay.mul(step(0.5, u.view)))
  // 深度画笔：立绘上半透明地叠加自身深度的伪彩色
  const relief = mix(debugOut, cmap(saturate(depth.character.depth)), u.relief.mul(depth.uniforms.hasCharDepth).mul(alpha).mul(RELIEF_ALPHA))
  const out = mix(relief, MASK_TINT, sampleLevel(layers.adjusted, screenUV).a.mul(u.mask).mul(MASK_ALPHA))
  const ball = ballOverlay(out, placement.p)

  return { uniforms: u, ball: ball.uniforms, material: material(vec4(ball.color, 1)) }
}

/**
 * 8 位量化前的抖动：加上 ±0.5 级的 R2 低差异序列（近似蓝噪声），防止平滑渐变出现色带。e 为 sRGB 编码值。
 * 未经处理的 8 位原图像素正好落在量化级上，抖动后不变。
 */
function dither(e: Vec3Node, amount: FloatNode, px: Vec2Node = screenCoordinate.xy): Vec3Node {
  const n = fract(px.x.mul(0.7548776662).add(px.y.mul(0.56984029)).add(0.5))
  return e.add(n.sub(0.5).mul(amount.div(255)))
}

/** 视口显示：把文档渲染结果按缩放和平移画到画布上，文档外填充中性灰（随主题，见 backdrop.ts）。画布的 sRGB 编码由渲染器完成，这里抖动后再解码。 */
export function createPresentPass(docTexture: THREE.Texture) {
  const u = {
    viewport: uniform(new THREE.Vector2(1, 1)),
    zoom: uniform(1),
    pan: uniform(new THREE.Vector2(0, 0)),
    docSize: uniform(new THREE.Vector2(1, 1)),
    dither: uniform(0),
    /** 文档外的颜色（线性） */
    surround: uniform(srgbToLinear(SURROUND.dark / 255)),
  }
  const docPx = screenUV.mul(u.viewport).sub(u.pan).div(u.zoom)
  const uv = docPx.div(u.docSize)
  const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
  const doc = texture(docTexture, uv)
  const surround = vec3(u.surround)
  const rgb = surround.add(doc.rgb.sub(surround).mul(inside))
  // 抖动量为 0 时编码再解码，与原值的差别远小于一个量化级
  const dithered = srgbDecode(saturate(dither(srgbEncode(saturate(rgb)), u.dither.mul(inside))))
  return { uniforms: u, document: doc, material: material(vec4(dithered, 1)) }
}

/** 导出编码：线性 → sRGB，裁剪到 [0,1]，（需要时）抖动后写入 8 位渲染目标。抖动按输出图像的像素坐标取值 */
export function createEncodePass(placeholder: THREE.Texture, tile: TileMapping) {
  const src = texture(placeholder, screenUV)
  const ditherAmount = uniform(0)
  return { source: src, dither: ditherAmount, material: material(vec4(dither(srgbEncode(saturate(src.rgb)), ditherAmount, tile.pixel), 1)) }
}
