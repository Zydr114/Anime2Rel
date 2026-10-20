/**
 * 立绘变形（docs/Plan.md §3.7 M8.3）：把立绘以及它的深度、法线、轮廓光边缘带按细分网格画到变形后的包围盒里，
 * 网格与 src/fusion/warp.ts 的 warpMesh 相同。顶点位置是包围盒内的坐标（[0,1]，左上角为原点），uv 是原立绘的 UV。
 * 位置直接写成裁剪空间坐标，与全屏 pass 的 screenUV 一致，之后各 pass 按包围盒内的坐标采样。
 */
import * as THREE from 'three/webgpu'
import { float, positionGeometry, texture, uv, vec4 } from 'three/tsl'
import type { Bounds, WarpMesh } from '@/fusion/warp'

/** 需要变形的各层：预处理后的立绘、立绘深度的引导滤波系数与辅助数据、深度法线、融合法线、轮廓光边缘带 */
export const WARP_LAYERS = ['character', 'coef', 'aux', 'depthNormal', 'normal', 'rim'] as const
export type WarpLayer = (typeof WARP_LAYERS)[number]

export function createWarpPass(segments: number, placeholder: THREE.Texture) {
  const n = segments + 1
  const geometry = new THREE.BufferGeometry()
  const position = new THREE.BufferAttribute(new Float32Array(n * n * 3), 3)
  position.setUsage(THREE.DynamicDrawUsage)
  const uvs = new Float32Array(n * n * 2)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) uvs.set([i / segments, j / segments], (j * n + i) * 2)
  const index: number[] = []
  for (let j = 0; j < segments; j++)
    for (let i = 0; i < segments; i++) {
      const a = j * n + i
      index.push(a, a + 1, a + n + 1, a, a + n + 1, a + n)
    }
  geometry.setAttribute('position', position)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(index)

  const vertexNode = vec4(positionGeometry.x.mul(2).sub(1), float(1).sub(positionGeometry.y.mul(2)), 0, 1)
  // 每层一个材质：各自的纹理绑定不必在每次绘制时切换
  const layers = Object.fromEntries(
    WARP_LAYERS.map((layer) => {
      const source = texture(placeholder, uv())
      const m = new THREE.NodeMaterial()
      m.vertexNode = vertexNode
      m.fragmentNode = source
      // 网格可能翻转或折叠
      m.side = THREE.DoubleSide
      m.depthTest = false
      m.depthWrite = false
      return [layer, { material: m, source }]
    }),
  ) as Record<WarpLayer, { material: THREE.NodeMaterial; source: THREE.TextureNode }>
  const mesh = new THREE.Mesh(geometry, layers.character.material)
  mesh.frustumCulled = false
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  return {
    /** 按网格和包围盒设置顶点位置 */
    setMesh(warp: WarpMesh, box: Bounds): void {
      const array = position.array as Float32Array
      const sx = 1 / (box.x1 - box.x0)
      const sy = 1 / (box.y1 - box.y0)
      for (let k = 0; k < n * n; k++) {
        array[k * 3] = (warp.positions[k * 2] - box.x0) * sx
        array[k * 3 + 1] = (warp.positions[k * 2 + 1] - box.y0) * sy
      }
      position.needsUpdate = true
    },
    /** 把一层画到 target：网格之外为透明的 0 */
    render(renderer: THREE.WebGPURenderer, layer: WarpLayer, source: THREE.Texture, target: THREE.RenderTarget): void {
      const { material, source: node } = layers[layer]
      node.value = source
      mesh.material = material
      const alpha = renderer.getClearAlpha()
      renderer.setClearAlpha(0)
      renderer.setRenderTarget(target)
      renderer.render(mesh, camera)
      renderer.setClearAlpha(alpha)
    },
    dispose(): void {
      geometry.dispose()
      for (const { material } of Object.values(layers)) material.dispose()
    },
  }
}

export type WarpPass = ReturnType<typeof createWarpPass>
