// 渲染各阶段使用的 TSL 材质。所有中间结果都是线性 sRGB；立绘使用预乘 alpha。
import * as THREE from 'three/webgpu'
import { abs, cos, dot, float, fwidth, length, log2, max, mix, saturate, screenUV, select, sin, smoothstep, sqrt, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { sampleLevel, type DofUniforms } from './dof'
import { createFusionNode } from './fusion'
import type { ShadowUniforms } from './shadow'
import { evalSh, material, srgbDecode, srgbEncode, type FloatNode, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'

/** 立绘预处理：sRGB 直通 alpha → 线性预乘 alpha，写入带 mipmap 的半精度纹理。 */
export function createCharPrepPass(placeholder: THREE.Texture) {
  const src = texture(placeholder, screenUV)
  return {
    source: src,
    material: material(vec4(src.rgb.mul(src.a), src.a)),
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
/** 景深视图中着色饱和时的弥散圆半径（相对图像长边） */
const FOCUS_VIEW_SCALE = 0.004

type TextureNode = THREE.TextureNode

function luma(c: Vec3Node): FloatNode {
  return dot(c, vec3(0.2126, 0.7152, 0.0722))
}

/** 立绘在文档中的摆放：文档像素坐标、立绘纹理坐标、是否在立绘矩形内。各个 pass 共用同一组统一量。 */
export function createPlacement() {
  const u = {
    docSize: uniform(new THREE.Vector2(1, 1)),
    charCenter: uniform(new THREE.Vector2(0, 0)),
    charRotation: uniform(0),
    charScale: uniform(1),
    charFlip: uniform(1),
    charSize: uniform(new THREE.Vector2(1, 1)),
    hasChar: uniform(0),
  }
  const p = screenUV.mul(u.docSize)
  /** 文档像素坐标 → 立绘 UV，与 src/algo/geometry.ts 的 docToLayerUV 一致 */
  const toCharUV = (q: Vec2Node) => {
    const d = q.sub(u.charCenter)
    const c = cos(u.charRotation)
    const s = sin(u.charRotation)
    const lx = c.mul(d.x).add(s.mul(d.y)).div(u.charScale).mul(u.charFlip)
    const ly = s.negate().mul(d.x).add(c.mul(d.y)).div(u.charScale)
    return vec2(lx, ly).div(u.charSize).add(0.5)
  }
  const charUV = toCharUV(p)
  const inside = step(0, charUV.x).mul(step(charUV.x, 1)).mul(step(0, charUV.y)).mul(step(charUV.y, 1)).mul(u.hasChar)
  return { uniforms: u, p, charUV, inside, toCharUV }
}

export type Placement = ReturnType<typeof createPlacement>

/**
 * 背景与立绘的深度：引导分辨率的系数与全分辨率颜色组合，得到边缘锐利的深度。
 * 立绘的引导图是合成到中性灰上的 sRGB 颜色，与推理输入一致。
 */
export function createDepthNodes(placement: Placement, background: TextureNode, character: TextureNode, placeholder: { background: DepthTextures; character: DepthTextures }) {
  const u = { edgeAlign: uniform(1), hasBgDepth: uniform(0), hasCharDepth: uniform(0) }
  const bgCoef = texture(placeholder.background.coef, screenUV)
  const bgAux = texture(placeholder.background.aux, screenUV)
  const bgNormal = texture(placeholder.background.normal, screenUV)
  const bgDepth = saturate(mix(bgAux.r, dot(bgCoef.rgb, srgbEncode(saturate(background.rgb))).add(bgCoef.a), u.edgeAlign))

  const straight = character.rgb.div(max(character.a, 1e-4))
  const chGuide = mix(vec3(NEUTRAL_GRAY), srgbEncode(saturate(straight)), character.a)
  const chCoef = texture(placeholder.character.coef, placement.charUV)
  const chAux = texture(placeholder.character.aux, placement.charUV)
  const chNormal = texture(placeholder.character.normal, placement.charUV)
  const chDepth = saturate(mix(chAux.r, dot(chCoef.rgb, chGuide).add(chCoef.a), u.edgeAlign))
  return {
    uniforms: u,
    textures: {
      background: { coef: bgCoef, aux: bgAux, normal: bgNormal },
      character: { coef: chCoef, aux: chAux, normal: chNormal },
    },
    background: { depth: bgDepth, sky: bgAux.g, normal: bgNormal },
    character: { depth: chDepth, normal: chNormal, straight },
  }
}

export type DepthNodes = ReturnType<typeof createDepthNodes>

/** 立绘层：融合后的立绘按变换摆放到文档空间（线性预乘 alpha）。 */
export function createCharacterPass(placement: Placement, character: TextureNode, background: TextureNode, normalPlaceholder: THREE.Texture) {
  const u = placement.uniforms
  const fusion = createFusionNode({
    p: placement.p,
    charUV: placement.charUV,
    character,
    background,
    normalPlaceholder,
    docSize: u.docSize,
    charSize: u.charSize,
    charRotation: u.charRotation,
    charScale: u.charScale,
    charFlip: u.charFlip,
  })
  return { fusion: fusion.uniforms, characterNormal: fusion.normal, material: material(fusion.output.mul(placement.inside)) }
}

/** 合成使用的各图层纹理（均与渲染目标同尺寸） */
export interface LayerTextures {
  prep: TextureNode
  backgroundDof: TextureNode
  character: TextureNode
  characterDepth: TextureNode
  characterDof: TextureNode
  occlusion: TextureNode
  /** 站立阴影：背景的颜色倍率 */
  shadow: TextureNode
}

/**
 * 最终合成：模糊背景（乘以站立阴影） → 模糊立绘 → 遮挡层（按遮挡方式混合）→ 遮罩预览 → 调试视图 → 灰球。
 * view 不为 0 时按调试视图着色，再按 overlay 与合成结果混合。
 */
export function createCompositePass(input: {
  placement: Placement
  depth: DepthNodes
  background: TextureNode
  colormap: THREE.Texture
  layers: LayerTextures
  dof: DofUniforms
  shadow: ShadowUniforms
}) {
  const { placement, depth, background, layers, dof } = input
  const u = { view: uniform(0), overlay: uniform(1) }

  // 阴影随地面一起离焦：按背景的弥散圆选用 mip
  const shadowLod = log2(max(abs(sampleLevel(layers.prep, screenUV).a), 1))
  const shadow = mix(vec3(1), sampleLevel(layers.shadow, screenUV, shadowLod).rgb, input.shadow.enabled)
  const bg = mix(sampleLevel(layers.backgroundDof, screenUV).rgb, background.rgb, dof.bypass).mul(shadow)
  const ch = mix(sampleLevel(layers.characterDof, screenUV), sampleLevel(layers.character, screenUV), dof.bypass)
  const charDepth = sampleLevel(layers.characterDepth, screenUV)

  // 遮挡：不透明为普通覆盖；变暗与正片叠底只改变立绘自身的像素（遮挡层在立绘外就是背景本身）
  const occ = sampleLevel(layers.occlusion, screenUV).mul(dof.occlusion)
  const occColor = occ.rgb.div(max(occ.a, 1e-4))
  const straight = ch.rgb.div(max(ch.a, 1e-4))
  const darker = smoothstep(-0.02, 0.02, luma(straight).sub(luma(occColor)))
  const darken = mix(straight, occColor, darker.mul(occ.a)).mul(ch.a)
  const multiply = ch.rgb.mul(mix(vec3(1), occColor, occ.a))
  const mode = dof.occlusionMode
  const chRgb = select(mode.equal(1), darken, select(mode.equal(2), multiply, ch.rgb))
  const layered = chRgb.add(bg.mul(float(1).sub(ch.a)))
  const occluded = select(mode.equal(0), occ.rgb.add(layered.mul(float(1).sub(occ.a))), layered)
  const rgb = mix(occluded, MASK_TINT, charDepth.g.mul(charDepth.a).mul(dof.showMask).mul(0.6))

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

  const debug = select(u.view.equal(4), focusView, chDebug.mul(ch.a).add(bgDebug.mul(float(1).sub(ch.a))))
  const out = mix(rgb, debug, u.overlay.mul(step(0.5, u.view)))
  const ball = ballOverlay(out, placement.p)

  return { uniforms: u, ball: ball.uniforms, material: material(vec4(ball.color, 1)) }
}

/** 视口显示：把文档渲染结果按缩放和平移画到画布上，文档外填充中性深灰。 */
export function createPresentPass(docTexture: THREE.Texture) {
  const u = {
    viewport: uniform(new THREE.Vector2(1, 1)),
    zoom: uniform(1),
    pan: uniform(new THREE.Vector2(0, 0)),
    docSize: uniform(new THREE.Vector2(1, 1)),
  }
  const docPx = screenUV.mul(u.viewport).sub(u.pan).div(u.zoom)
  const uv = docPx.div(u.docSize)
  const inside = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1))
  const doc = texture(docTexture, uv)
  const surround = vec3(0.0103) // sRGB #1a1a1a
  const rgb = surround.add(doc.rgb.sub(surround).mul(inside))
  return { uniforms: u, document: doc, material: material(vec4(rgb, 1)) }
}

/** 导出编码：线性 → sRGB，裁剪到 [0,1]，写入 8 位渲染目标。 */
export function createEncodePass(placeholder: THREE.Texture) {
  const src = texture(placeholder, screenUV)
  return { source: src, material: material(vec4(srgbEncode(saturate(src.rgb)), 1)) }
}
