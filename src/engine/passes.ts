// 渲染各阶段使用的 TSL 材质。所有中间结果都是线性 sRGB；立绘使用预乘 alpha。
import * as THREE from 'three/webgpu'
import { cos, float, mix, pow, saturate, screenUV, sin, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'

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

/** 文档空间合成：背景 + 按变换摆放的立绘。输出到文档尺寸（或预览尺寸）的渲染目标。 */
export function createCompositePass(bgPlaceholder: THREE.Texture, charTexture: THREE.Texture) {
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
  const d = p.sub(u.charCenter)
  const c = cos(u.charRotation)
  const s = sin(u.charRotation)
  const lx = c.mul(d.x).add(s.mul(d.y)).div(u.charScale).mul(u.charFlip)
  const ly = s.negate().mul(d.x).add(c.mul(d.y)).div(u.charScale)
  const charUV = vec2(lx, ly).div(u.charSize).add(0.5)
  const inside = step(0, charUV.x).mul(step(charUV.x, 1)).mul(step(0, charUV.y)).mul(step(charUV.y, 1))

  const bg = texture(bgPlaceholder, screenUV)
  const ch = texture(charTexture, charUV).mul(inside.mul(u.hasChar))
  const rgb = ch.rgb.add(bg.rgb.mul(float(1).sub(ch.a)))

  return { uniforms: u, background: bg, material: material(vec4(rgb, 1)) }
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
  const c = saturate(src.rgb)
  const low = c.mul(12.92)
  const high = pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055)
  const rgb = mix(low, high, step(vec3(0.0031308), c))
  return { source: src, material: material(vec4(rgb, 1)) }
}
