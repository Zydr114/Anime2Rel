/**
 * 局部调整（docs/Plan.md §3.7 M8.8b）：在全局基础调整之后、终处理之前，按列表顺序依次作用。
 * 每项的蒙版 = 形状 × 范围，结果 = mix(c, 调整后的 c, 蒙版)。形状按文档像素坐标计算，范围从各图层计算，分块导出时没有接缝。
 * 参数的打包方式见 src/grade/mask.ts 的 maskParams。
 */
import * as THREE from 'three/webgpu'
import { abs, clamp, dot, float, Fn, If, length, Loop, max, mix, saturate, screenUV, select, smoothstep, step, texture, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl'
import { CONTRAST_STRENGTH } from '@/grade/color'
import { MASK_FEATHER } from '@/grade/creative'
import { MASK_VEC4S, MAX_MASKS, type MaskParams } from '@/grade/mask'
import { blend, blendLuma } from './blend'
import { sampleLevel, type DofUniforms } from './dof'
import { contrast1 } from './grade'
import { fromOklab, material, srgbDecode, srgbEncode, toOklab, type FloatNode, type Vec2Node, type Vec3Node, type Vec4Node } from './nodes'

type TextureNode = THREE.TextureNode

/** 没有画笔蒙版时的占位纹理（全为 0）；两张各用一个，three.js 按纹理 uuid 合并 uniform */
function brushPlaceholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1)
  t.needsUpdate = true
  return t
}

export function createMaskUniforms() {
  const placeholders = [brushPlaceholder(), brushPlaceholder()] as const
  return {
    /** 参与计算的项数；0 时这个 pass 不渲染 */
    count: uniform(0, 'int'),
    /** 预览中叠加显示蒙版的一项（序号），−1 为不显示；它的蒙版写入输出的 alpha */
    overlay: uniform(-1, 'int'),
    params: uniformArray(
      Array.from({ length: MAX_MASKS * MASK_VEC4S }, () => new THREE.Vector4()),
      'vec4',
    ),
    /** 画笔蒙版（src/grade/maskBrush.ts），按输出图像的 UV 采样 */
    brush: [texture(placeholders[0]), texture(placeholders[1])] as const,
    placeholders,
  }
}

export type MaskUniforms = ReturnType<typeof createMaskUniforms>

export interface MaskInputs {
  /** 全局调整的结果（与渲染目标同尺寸） */
  image: TextureNode
  /** 文档像素坐标与输出图像的 UV */
  p: Vec2Node
  uv: Vec2Node
  /** 立绘层调整后的立绘、立绘景深、遮挡层、立绘深度（与渲染目标同尺寸） */
  characterAdjusted: TextureNode
  characterDof: TextureNode
  occlusion: TextureNode
  characterDepth: TextureNode
  dof: DofUniforms
  /** 背景深度（归一化逆深度）、天空遮罩，以及是否有背景深度 */
  backgroundDepth: FloatNode
  sky: FloatNode
  hasBackgroundDepth: FloatNode
}

/** 0→1 的平滑过渡；width 为 0 时为硬边 */
const ramp = (x: FloatNode, width: FloatNode | number): FloatNode => {
  const t = saturate(x.div(max(width, 1e-4)))
  return t.mul(t).mul(float(3).sub(t.mul(2)))
}

/** 写入参数；enabled 为 false 时不渲染这个 pass，overlay 为预览中显示蒙版的一项（−1 为不显示） */
export function applyMaskParams(u: MaskUniforms, p: MaskParams | null, enabled: boolean, overlay: number): void {
  u.count.value = enabled && p ? p.count : 0
  u.overlay.value = overlay
  if (p) (u.params.array as THREE.Vector4[]).forEach((v, i) => v.fromArray(p.data, i * 4))
}

/** 有局部调整时，全局调整写入中间图层，这个 pass 读取它并输出到全局调整的结果 */
export function createMaskPass(u: MaskUniforms, inputs: MaskInputs) {
  const { dof, p } = inputs
  const node = Fn(() => {
    const c = sampleLevel(inputs.image, screenUV).rgb.toVar()
    // 立绘的可见程度：不透明度 × (1 − 遮挡强度)，与合成一致
    const alpha = mix(sampleLevel(inputs.characterDof, screenUV).a, sampleLevel(inputs.characterAdjusted, screenUV).a, dof.bypass)
    const covered = sampleLevel(inputs.occlusion, screenUV).a.mul(dof.occlusion)
    const visible = saturate(alpha.mul(float(1).sub(covered))).toVar()
    // 合成后的深度：立绘可见处为立绘深度，其余为背景深度
    const depth = mix(inputs.backgroundDepth, sampleLevel(inputs.characterDepth, screenUV).r, visible).toVar()
    const sky = inputs.sky.mul(inputs.hasBackgroundDepth).mul(float(1).sub(visible)).toVar()
    const shown = float(0).toVar()
    const brushA = sampleLevel(u.brush[0], inputs.uv).toVar()
    const brushB = sampleLevel(u.brush[1], inputs.uv).toVar()

    Loop(u.count, ({ i }) => {
      const base = i.mul(MASK_VEC4S)
      const element = (k: number) => u.params.element(base.add(k)) as unknown as Vec4Node
      const head = element(0)
      const apply = head.w.greaterThan(0.5)
      If(apply.or(i.equal(u.overlay)), () => {
        // 形状
        const shape = head.x
        const s = float(1).toVar()
        If(shape.lessThan(0.5), () => {
          s.assign(1)
        })
          .ElseIf(shape.lessThan(1.5), () => {
            // 椭圆：(1 − 羽化) 倍半径以内完全作用，到边缘过渡为 0
            const e = element(1)
            const rot = element(2)
            const d = p.sub(e.xy)
            const local = vec2(rot.x.mul(d.x).add(rot.y.mul(d.y)), rot.x.mul(d.y).sub(rot.y.mul(d.x)))
            const r = length(local.div(max(e.zw, vec2(1e-3))))
            s.assign(ramp(float(1).sub(r), head.z))
          })
          .ElseIf(shape.lessThan(2.5), () => {
            // 线性渐变：起点线上为 1，终点线上为 0
            const l = element(3)
            const v = l.zw.sub(l.xy)
            const t = dot(p.sub(l.xy), v).div(max(dot(v, v), 1e-6))
            s.assign(float(1).sub(ramp(t, 1)))
          })
          .Else(() => {
            // 画笔：第 i 项在第 i >> 2 张的第 i & 3 个通道
            const index = float(i)
            const is = (j: number) => float(1).sub(step(0.5, abs(index.sub(j))))
            const pick = (offset: number) => vec4(is(offset), is(offset + 1), is(offset + 2), is(offset + 3))
            s.assign(dot(brushA, pick(0)).add(dot(brushB, pick(4))))
          })
        If(shape.greaterThan(0.5).and(head.y.greaterThan(0.5)), () => {
          s.assign(float(1).sub(s))
        })

        // 范围
        const range = element(4)
        const extra = element(5)
        const kind = range.x
        const k = float(1).toVar()
        If(kind.lessThan(0.5), () => {
          k.assign(1)
        })
          .ElseIf(kind.lessThan(1.5), () => {
            k.assign(visible)
          })
          .ElseIf(kind.lessThan(2.5), () => {
            k.assign(float(1).sub(visible))
          })
          .ElseIf(kind.lessThan(3.5), () => {
            k.assign(sky)
          })
          .ElseIf(kind.lessThan(4.5), () => {
            const near = ramp(depth.sub(range.z.sub(range.w.mul(0.5))), range.w)
            k.assign(select(range.y.greaterThan(0.5), near, float(1).sub(near)))
          })
          .Else(() => {
            // 亮度：与混色层的亮度蒙版相同
            const l = blendLuma(clamp(srgbEncode(max(c, vec3(0))), 0, 1)).toVar()
            const lower = select(extra.x.lessThanEqual(0), float(1), smoothstep(extra.x.sub(MASK_FEATHER), extra.x.add(MASK_FEATHER), l))
            const upper = select(extra.y.greaterThanEqual(1), float(1), float(1).sub(smoothstep(extra.y.sub(MASK_FEATHER), extra.y.add(MASK_FEATHER), l)))
            k.assign(lower.mul(upper))
          })
        const w = s.mul(k).toVar()
        If(i.equal(u.overlay), () => {
          shown.assign(w)
        })

        If(apply, () => {
          // 白平衡与曝光、对比度、饱和度，公式与基础调整相同
          const r0 = element(6)
          const r1 = element(7)
          const r2 = element(8)
          const balanced = max(vec3(dot(r0.xyz, c), dot(r1.xyz, c), dot(r2.xyz, c)), vec3(0)).toVar()
          const kc = extra.z.mul(CONTRAST_STRENGTH)
          const contrasted = vec3(contrast1(balanced.x, kc), contrast1(balanced.y, kc), contrast1(balanced.z, kc))
          const lab = toOklab(contrasted).toVar()
          const saturated = max(fromOklab(vec3(lab.x, vec2(lab.y, lab.z).mul(max(extra.w.add(1), 0)))), vec3(0))
          // 叠色：混合函数与混色层相同，在编码值上计算
          const e = srgbEncode(saturated).toVar()
          const tinted = mix(e, blend(r0.w, clamp(e, 0, 1), element(9).xyz), r1.w)
          const adjusted: Vec3Node = srgbDecode(max(tinted, vec3(0)))
          c.assign(mix(c, adjusted, w))
        })
      })
    })
    return vec4(c, shown)
  })
  return material(node())
}
