// 各个 TSL 材质共用的节点函数。
import * as THREE from 'three/webgpu'
import { float, mix, pow, step, vec3 } from 'three/tsl'

export type Vec2Node = THREE.Node<'vec2'>
export type Vec3Node = THREE.Node<'vec3'>
export type FloatNode = THREE.Node<'float'>
export type Vec4Node = THREE.Node<'vec4'>

/** sRGB OETF：线性 → sRGB 编码值（输入需已裁剪到 [0,1]） */
export function srgbEncode(c: Vec3Node): Vec3Node {
  return mix(c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055), step(vec3(0.0031308), c))
}

/** sRGB EOTF：sRGB 编码值 → 线性 */
export function srgbDecode(c: Vec3Node): Vec3Node {
  return mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c))
}

/** 2 阶实球谐求值，系数顺序与 src/algo/sh.ts 一致 */
export function evalSh(sh: THREE.UniformNode<'vec3', THREE.Vector3>[], n: Vec3Node): Vec3Node {
  const basis = [
    float(0.282095),
    n.y.mul(0.488603),
    n.z.mul(0.488603),
    n.x.mul(0.488603),
    n.x.mul(n.y).mul(1.092548),
    n.y.mul(n.z).mul(1.092548),
    n.z.mul(n.z).mul(3).sub(1).mul(0.315392),
    n.x.mul(n.z).mul(1.092548),
    n.x.mul(n.x).sub(n.y.mul(n.y)).mul(0.546274),
  ]
  return basis.reduce<Vec3Node>((acc, y, k) => acc.add(sh[k].mul(y)), vec3(0))
}

/** 全屏 pass 的材质：只有片元输出，不做深度测试 */
export function material(node: Vec4Node): THREE.NodeMaterial {
  const m = new THREE.NodeMaterial()
  m.fragmentNode = node
  m.depthTest = false
  m.depthWrite = false
  return m
}
