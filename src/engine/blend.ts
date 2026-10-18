/**
 * W3C Compositing and Blending Level 1 的混合函数 B(cb, cs)，cb 为底色，cs 为混合色，都是 [0,1] 的编码值。
 * 逐通道的条件分支用 step/mix 实现，WebGPU 和 WebGL2 后端的结果一致。
 */
import { abs, dot, float, max, min, mix, select, sqrt, step, vec3 } from 'three/tsl'
import { BLEND_LUMA } from '@/grade/creative'
import { BLEND_MODES, type BlendMode } from '@/grade/model'
import type { FloatNode, Vec3Node } from './nodes'

const one = vec3(1)

const screen = (b: Vec3Node, s: Vec3Node): Vec3Node => b.add(s).sub(b.mul(s))
/** s ≤ 0.5 时为 multiply(b, 2s)，否则为 screen(b, 2s − 1) */
const hardLight = (b: Vec3Node, s: Vec3Node): Vec3Node => mix(b.mul(s).mul(2), screen(b, s.mul(2).sub(1)), step(0.5, s))

function softLight(b: Vec3Node, s: Vec3Node): Vec3Node {
  const d = mix(b.mul(16).sub(12).mul(b).add(4).mul(b), sqrt(b), step(0.25, b))
  return mix(b.sub(one.sub(s.mul(2)).mul(b).mul(one.sub(b))), b.add(s.mul(2).sub(1).mul(d.sub(b))), step(0.5, s))
}

const lum = (c: Vec3Node): FloatNode => dot(c, vec3(...BLEND_LUMA))
const minOf = (c: Vec3Node): FloatNode => min(c.x, min(c.y, c.z))
const maxOf = (c: Vec3Node): FloatNode => max(c.x, max(c.y, c.z))

function clipColor(c: Vec3Node): Vec3Node {
  const l = lum(c)
  const n = minOf(c)
  const x = maxOf(c)
  const low = select(n.lessThan(0), vec3(l).add(c.sub(l).mul(l).div(max(l.sub(n), 1e-6))), c)
  return select(x.greaterThan(1), vec3(l).add(low.sub(l).mul(float(1).sub(l)).div(max(x.sub(l), 1e-6))), low)
}

const setLum = (c: Vec3Node, l: FloatNode): Vec3Node => clipColor(c.add(l.sub(lum(c))))
const sat = (c: Vec3Node): FloatNode => maxOf(c).sub(minOf(c))

function setSat(c: Vec3Node, s: FloatNode): Vec3Node {
  const n = minOf(c)
  const range = maxOf(c).sub(n)
  return select(range.greaterThan(1e-6), c.sub(n).mul(s).div(max(range, 1e-6)), vec3(0))
}

const MODES: Record<BlendMode, (b: Vec3Node, s: Vec3Node) => Vec3Node> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b.mul(s),
  screen,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => min(b, s),
  lighten: (b, s) => max(b, s),
  'color-dodge': (b, s) => min(one, b.div(max(one.sub(s), vec3(1e-6)))).mul(step(1e-6, b)),
  'color-burn': (b, s) => one.sub(min(one, one.sub(b).div(max(s, vec3(1e-6))))),
  'hard-light': hardLight,
  'soft-light': softLight,
  difference: (b, s) => abs(b.sub(s)),
  exclusion: (b, s) => b.add(s).sub(b.mul(s).mul(2)),
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
}

/** 按模式序号（BLEND_MODES 中的位置）混合 */
export function blend(mode: FloatNode, b: Vec3Node, s: Vec3Node): Vec3Node {
  return BLEND_MODES.reduce<Vec3Node>((acc, name, i) => (i === 0 ? MODES[name](b, s) : select(abs(mode.sub(i)).lessThan(0.5), MODES[name](b, s), acc)), s)
}

export { lum as blendLuma }
