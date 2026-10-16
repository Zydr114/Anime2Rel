// 渲染各阶段使用的 TSL 材质。所有中间结果都是线性 sRGB；立绘使用预乘 alpha。
import * as THREE from 'three/webgpu'
import { cos, dot, float, max, mix, pow, saturate, screenUV, select, sin, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'

type Vec3Node = THREE.Node<'vec3'>
type FloatNode = THREE.Node<'float'>
type Vec4Node = THREE.Node<'vec4'>

/** sRGB OETF：线性 → sRGB 编码值（输入需已裁剪到 [0,1]） */
function srgbEncode(c: Vec3Node): Vec3Node {
  return mix(c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055), step(vec3(0.0031308), c))
}

/** sRGB EOTF：sRGB 编码值 → 线性 */
function srgbDecode(c: Vec3Node): Vec3Node {
  return mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c))
}

function material(node: ReturnType<typeof vec4>): THREE.NodeMaterial {
  const m = new THREE.NodeMaterial()
  m.fragmentNode = node
  m.depthTest = false
  m.depthWrite = false
  return m
}

/** 立绘预处理：sRGB 直通 alpha → 线性预乘 alpha，写入带 mipmap 的半精度纹理。 */
export function createCharPrepPass(placeholder: THREE.Texture) {
  const src = texture(placeholder, screenUV)
  return {
    source: src,
    material: material(vec4(src.rgb.mul(src.a), src.a)),
  }
}

/** 调试视图编号，与 composite 材质的 view 统一量对应 */
export const DEBUG_VIEW_INDEX = { composite: 0, depth: 1, normal: 2, sky: 3 } as const

/** 深度图层的纹理：引导滤波系数、辅助数据（未对齐深度、天空）、法线。 */
export interface DepthTextures {
  coef: THREE.Texture
  aux: THREE.Texture
  normal: THREE.Texture
}

/** 立绘推理时垫底的中性灰（sRGB 编码值），与 src/depth/pipeline.ts 一致 */
const NEUTRAL_GRAY = 128 / 255
/** 天空遮罩视图的着色（线性） */
const SKY_TINT = vec3(0.05, 0.35, 1.0)

/**
 * 文档空间合成：背景 + 按变换摆放的立绘。输出到文档尺寸（或预览尺寸）的渲染目标。
 * view 不为 0 时按调试视图（深度、法线、天空）着色，再按 overlay 与合成结果混合。
 */
export function createCompositePass(bgPlaceholder: THREE.Texture, charTexture: THREE.Texture, depthPlaceholder: { background: DepthTextures; character: DepthTextures }, colormap: THREE.Texture) {
  const u = {
    docSize: uniform(new THREE.Vector2(1, 1)),
    charCenter: uniform(new THREE.Vector2(0, 0)),
    charRotation: uniform(0),
    charScale: uniform(1),
    charFlip: uniform(1),
    charSize: uniform(new THREE.Vector2(1, 1)),
    hasChar: uniform(0),
    view: uniform(0),
    overlay: uniform(1),
    edgeAlign: uniform(1),
    hasBgDepth: uniform(0),
    hasCharDepth: uniform(0),
  }

  const p = screenUV.mul(u.docSize)
  const d = p.sub(u.charCenter)
  const c = cos(u.charRotation)
  const s = sin(u.charRotation)
  const lx = c.mul(d.x).add(s.mul(d.y)).div(u.charScale).mul(u.charFlip)
  const ly = s.negate().mul(d.x).add(c.mul(d.y)).div(u.charScale)
  const charUV = vec2(lx, ly).div(u.charSize).add(0.5)
  const inside = step(0, charUV.x).mul(step(charUV.x, 1)).mul(step(0, charUV.y)).mul(step(charUV.y, 1))

  const bg = texture(bgPlaceholder, screenUV)
  const chRaw = texture(charTexture, charUV)
  const ch = chRaw.mul(inside.mul(u.hasChar))
  const rgb = ch.rgb.add(bg.rgb.mul(float(1).sub(ch.a)))

  const cmap = (v: FloatNode) => srgbDecode(texture(colormap, vec2(v, 0.5)).rgb)
  const debugColor = (depth: FloatNode, normal: Vec4Node, sky: Vec3Node) =>
    select(u.view.equal(1), cmap(depth), select(u.view.equal(2), srgbDecode(normal.rgb).mul(mix(0.3, 1, normal.a)), sky))

  // 背景：引导分辨率的系数与全分辨率颜色组合，得到边缘锐利的深度
  const bgCoef = texture(depthPlaceholder.background.coef, screenUV)
  const bgAux = texture(depthPlaceholder.background.aux, screenUV)
  const bgNormal = texture(depthPlaceholder.background.normal, screenUV)
  const bgDepth = saturate(mix(bgAux.r, dot(bgCoef.rgb, srgbEncode(saturate(bg.rgb))).add(bgCoef.a), u.edgeAlign))
  const bgSky = mix(bg.rgb.mul(0.25), SKY_TINT, bgAux.g.mul(0.8))
  const bgDebug = mix(bg.rgb, debugColor(bgDepth, bgNormal, bgSky), u.hasBgDepth)

  // 立绘：引导图是合成到中性灰上的 sRGB 颜色，与推理输入一致
  const straight = chRaw.rgb.div(max(chRaw.a, 1e-4))
  const chGuide = mix(vec3(NEUTRAL_GRAY), srgbEncode(saturate(straight)), chRaw.a)
  const chCoef = texture(depthPlaceholder.character.coef, charUV)
  const chAux = texture(depthPlaceholder.character.aux, charUV)
  const chNormal = texture(depthPlaceholder.character.normal, charUV)
  const chDepth = saturate(mix(chAux.r, dot(chCoef.rgb, chGuide).add(chCoef.a), u.edgeAlign))
  const chDebug = mix(straight, debugColor(chDepth, chNormal, straight.mul(0.25)), u.hasCharDepth)

  const debug = chDebug.mul(ch.a).add(bgDebug.mul(float(1).sub(ch.a)))
  const out = mix(rgb, debug, u.overlay.mul(step(0.5, u.view)))

  return {
    uniforms: u,
    background: bg,
    depth: {
      background: { coef: bgCoef, aux: bgAux, normal: bgNormal },
      character: { coef: chCoef, aux: chAux, normal: chNormal },
    },
    material: material(vec4(out, 1)),
  }
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
