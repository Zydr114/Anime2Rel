/**
 * 3D 视图（docs/Plan.md §3.7 M8.6a）：由校准后的深度重建的 2.5D 场景，与二维合成共用渲染器。
 * 背景展开成贴着原图的网格，深度跳变处的三角形剔除；天空画在远处的穹顶上；地面画一张 1 m 的网格；不在原相机视角时画出原相机的视锥。
 * 坐标与视角见 src/scene3d/space.ts。场景先渲染到多重采样的渲染目标，再画到画布上。
 */
import * as THREE from 'three/webgpu'
import { abs, cameraPosition, dot, float, fract, fwidth, max, min, mix, normalize, positionGeometry, positionLocal, positionWorld, screenUV, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { sceneDepth } from '@/algo/camera'
import type { Size } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { cameraFocal, sceneAxes } from '@/camera/geometry'
import type { CameraDoc } from '@/camera/model'
import type { DepthResult } from '@/depth/protocol'
import { docToWorld, type SceneLayout } from '@/scene3d/layout'
import { directionToWorld, type Projection } from '@/scene3d/space'
import { material } from './nodes'

export interface Scene3dInput {
  projection: Projection
  /** 是否就是原相机视角：是时不画视锥 */
  cameraView: boolean
  layout: SceneLayout
  camera: CameraDoc
  /** 文档尺寸 */
  size: Size
  depth: DepthResult | undefined
}

/** 背景网格长边方向的顶点数（约）：深度图长边 1024 时约每 3 个深度像素一个顶点 */
const VERTICES = 320
/** 相邻顶点的距离之比超过 1 + JUMP 时视为深度跳变，不连成三角形 */
const JUMP = 0.25
const SKY = 0.5
/** 视野之外和非天空方向的穹顶颜色（线性） */
const DOME_COLOR = new THREE.Color(0.016, 0.018, 0.024)
const FRUSTUM_COLOR = new THREE.Color(0xd9b26f)

function grayTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

/** 地面网格朝相机拉近的比例：照片中的地面与拟合的地面有出入，拉近后不会被背景挡住，站在地面上的物体仍能挡住它 */
const GRID_PULL = 0.95

/** 背景网格：每 STEP 个深度像素一个顶点，跳过天空和深度跳变处 */
function backgroundGeometry(camera: CameraDoc, size: Size, depth: DepthResult, layout: SceneLayout): THREE.BufferGeometry {
  const { width: gw, height: gh } = depth.guideSize
  const STEP = Math.max(1, Math.round(Math.max(gw, gh) / VERTICES))
  const cols = Math.floor((gw - 1) / STEP) + 2
  const rows = Math.floor((gh - 1) / STEP) + 2
  const position = new Float32Array(cols * rows * 3)
  const uvs = new Float32Array(cols * rows * 2)
  const dist = new Float32Array(cols * rows)
  const sky = new Uint8Array(cols * rows)
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = Math.min(i * STEP, gw - 1)
      const y = Math.min(j * STEP, gh - 1)
      const k = j * cols + i
      const s = y * gw + x
      const p = { x: ((x + 0.5) * size.width) / gw, y: ((y + 0.5) * size.height) / gh }
      const z = sceneDepth(depth.depth[s], layout.scale)
      position.set(docToWorld(camera, size, p, z), k * 3)
      uvs[k * 2] = p.x / size.width
      uvs[k * 2 + 1] = p.y / size.height
      dist[k] = z
      sky[k] = depth.sky && depth.sky[s] > SKY ? 1 : 0
    }
  const index: number[] = []
  const ok = (a: number, b: number, c: number) => {
    if (sky[a] || sky[b] || sky[c]) return false
    const lo = Math.min(dist[a], dist[b], dist[c])
    const hi = Math.max(dist[a], dist[b], dist[c])
    return hi <= lo * (1 + JUMP)
  }
  for (let j = 0; j + 1 < rows; j++)
    for (let i = 0; i + 1 < cols; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      if (ok(a, c, b)) index.push(a, c, b)
      if (ok(b, c, d)) index.push(b, c, d)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1))
  g.computeBoundingSphere()
  return g
}

function skyTexture(depth: DepthResult): THREE.DataTexture {
  const { width, height } = depth.guideSize
  const data = new Uint8Array(width * height * 4)
  if (depth.sky) for (let i = 0; i < width * height; i++) data[i * 4] = Math.round(depth.sky[i] * 255)
  const t = new THREE.DataTexture(data, width, height)
  t.colorSpace = THREE.NoColorSpace
  t.flipY = false
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

export class Scene3D {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera()
  private readonly target = new THREE.RenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType })
  private readonly blit: THREE.QuadMesh
  // 每个纹理节点各用一张占位纹理：three.js 按纹理合并绑定，共用时替换其中一个会失效
  private readonly placeholders = [grayTexture(), grayTexture(), grayTexture()] as const
  private readonly backgroundMap = texture(this.placeholders[0])
  private readonly background: THREE.Mesh
  private backgroundKey = ''
  private readonly dome: THREE.Mesh
  private readonly domeUniforms = {
    origin: uniform(new THREE.Vector3()),
    right: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    back: uniform(new THREE.Vector3(0, 0, 1)),
    size: uniform(new THREE.Vector2(1, 1)),
    focal: uniform(1),
  }
  private readonly domeMap = texture(this.placeholders[1])
  private skyMap: THREE.DataTexture | null = null
  private readonly skyNode = texture(this.placeholders[2])
  private readonly grid: THREE.Mesh
  private readonly gridUniforms = { axisX: uniform(new THREE.Vector2(1, 0)), axisZ: uniform(new THREE.Vector2(0, 1)), center: uniform(new THREE.Vector2()), radius: uniform(10) }
  private readonly frustum: THREE.LineSegments

  constructor() {
    const bgMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
    bgMaterial.colorNode = this.backgroundMap.sample(uv())
    this.background = new THREE.Mesh(new THREE.BufferGeometry(), bgMaterial)
    this.background.frustumCulled = false
    this.scene.add(this.background)

    // 穹顶：从原相机看去是天空的方向贴原图，其余方向是暗色
    const d = this.domeUniforms
    const dir = normalize(positionWorld.sub(d.origin))
    const zc = dot(dir, d.back).negate()
    const px = vec2(d.size.x.mul(0.5).add(d.focal.mul(dot(dir, d.right)).div(zc)), d.size.y.mul(0.5).sub(d.focal.mul(dot(dir, d.up)).div(zc)))
    const q = px.div(d.size)
    const inside = step(0.001, zc).mul(step(0, q.x)).mul(step(q.x, 1)).mul(step(0, q.y)).mul(step(q.y, 1))
    const isSky = inside.mul(smoothstep(0.3, 0.7, this.skyNode.sample(q).r))
    const fallback = mix(vec3(DOME_COLOR.r, DOME_COLOR.g, DOME_COLOR.b), vec3(0.05, 0.06, 0.08), smoothstep(-0.1, 0.6, dir.y))
    const domeMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
    domeMaterial.colorNode = mix(fallback, this.domeMap.sample(q).rgb, isSky)
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMaterial)
    this.dome.renderOrder = -1
    this.dome.frustumCulled = false
    this.scene.add(this.dome)

    // 地面网格：每格 1 m，按参考方向旋转，抗锯齿并随距离淡出。顶点直接是世界坐标，沿视线朝相机拉近 GRID_PULL
    const gu = this.gridUniforms
    const w = vec2(positionGeometry.x, positionGeometry.z)
    const g = vec2(dot(w, gu.axisX), dot(w, gu.axisZ))
    const width = max(fwidth(g), vec2(1e-4))
    const line = vec2(abs(fract(g.sub(0.5)).sub(0.5))).div(width)
    const strength = float(1).sub(min(min(line.x, line.y), 1))
    // 格子在画面上小于几个像素时淡出，避免摩尔纹
    const dense = float(1).sub(smoothstep(0.15, 0.4, max(width.x, width.y)))
    const fade = float(1).sub(smoothstep(gu.radius.mul(0.5), gu.radius, w.sub(gu.center).length()))
    const gridMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
    gridMaterial.positionNode = mix(cameraPosition, positionLocal, GRID_PULL)
    gridMaterial.colorNode = vec3(0.85, 0.85, 0.85)
    gridMaterial.opacityNode = strength.mul(dense).mul(fade).mul(0.4)
    this.grid = new THREE.Mesh(new THREE.BufferGeometry(), gridMaterial)
    this.grid.renderOrder = 1
    this.grid.frustumCulled = false
    this.scene.add(this.grid)

    const frustumMaterial = new THREE.LineBasicNodeMaterial({ color: FRUSTUM_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
    this.frustum = new THREE.LineSegments(new THREE.BufferGeometry(), frustumMaterial)
    this.frustum.renderOrder = 2
    this.frustum.frustumCulled = false
    this.scene.add(this.frustum)

    const view = texture(this.target.texture, screenUV)
    this.blit = new THREE.QuadMesh(material(vec4(view.rgb, 1)))
  }

  /** 背景原图（预览分辨率的位图纹理） */
  setBackground(map: THREE.Texture | null): void {
    this.backgroundMap.value = map ?? this.placeholders[0]
    this.domeMap.value = map ?? this.placeholders[1]
  }

  update(input: Scene3dInput): void {
    const { camera, size, depth, layout, projection: p } = input
    // 背景网格只在深度、标定或校准变化时重建
    const s = layout.scale
    const key = depth ? [camera.fovDeg, camera.pitch, camera.roll, camera.height, size.width, size.height, s.a, s.b, s.far].join() : ''
    if (depth && (key !== this.backgroundKey || !this.skyMap)) {
      this.background.geometry.dispose()
      this.background.geometry = backgroundGeometry(camera, size, depth, layout)
      this.skyMap?.dispose()
      this.skyMap = skyTexture(depth)
      this.skyNode.value = this.skyMap
    }
    this.backgroundKey = key
    this.background.visible = !!depth

    // 穹顶以原相机为中心，比最远的景物更远
    const d = this.domeUniforms
    const origin: Vec3 = [0, camera.height, 0]
    d.origin.value.set(...origin)
    d.right.value.set(...directionToWorld(camera, [1, 0, 0]))
    d.up.value.set(...directionToWorld(camera, [0, 1, 0]))
    d.back.value.set(...directionToWorld(camera, [0, 0, 1]))
    d.size.value.set(size.width, size.height)
    d.focal.value = cameraFocal(camera, size)
    const domeRadius = Math.min(s.far, 1e4 * camera.height) * 1.5
    this.dome.position.set(...origin)
    this.dome.scale.setScalar(domeRadius)

    // 地面网格围绕环绕中心
    const axes = sceneAxes(camera)
    const ax = directionToWorld(camera, axes.x)
    const az = directionToWorld(camera, axes.z)
    const g = this.gridUniforms
    g.axisX.value.set(ax[0], ax[2])
    g.axisZ.value.set(az[0], az[2])
    const radius = Math.min(s.far, Math.max(30 * camera.height, 3 * layout.reference))
    const [cx, , cz] = layout.target
    g.center.value.set(cx, cz)
    g.radius.value = radius
    this.grid.geometry.dispose()
    this.grid.geometry = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute([cx - radius, 0, cz - radius, cx + radius, 0, cz - radius, cx + radius, 0, cz + radius, cx - radius, 0, cz + radius], 3))
      .setIndex([0, 2, 1, 0, 3, 2])

    // 原相机的视锥：画到四分之一的参考距离
    this.frustum.visible = !input.cameraView
    if (!input.cameraView) {
      const reach = layout.reference * 0.25
      const corners = [
        { x: 0, y: 0 },
        { x: size.width, y: 0 },
        { x: size.width, y: size.height },
        { x: 0, y: size.height },
      ].map((c) => docToWorld(camera, size, c, reach))
      const lines: number[] = []
      corners.forEach((c, i) => lines.push(...origin, ...c, ...c, ...corners[(i + 1) % 4]))
      this.frustum.geometry.dispose()
      this.frustum.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
    }

    // 视角：用视口偏移表示任意主点，见 Projection
    const cam = this.camera
    const { viewport, focal, principal } = p
    cam.fov = (2 * Math.atan(viewport.height / 2 / focal) * 180) / Math.PI
    cam.aspect = viewport.width / viewport.height
    cam.setViewOffset(viewport.width, viewport.height, viewport.width / 2 - principal.x, viewport.height / 2 - principal.y, viewport.width, viewport.height)
    cam.near = 0.02 * camera.height
    cam.far = domeRadius * 2
    cam.updateProjectionMatrix()
    cam.position.set(...p.position)
    cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.right), new THREE.Vector3(...p.up), new THREE.Vector3(...p.back)))
    cam.updateMatrixWorld()
  }

  render(renderer: THREE.WebGPURenderer): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(size.x, size.y)
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(null)
    this.blit.render(renderer)
  }

  dispose(): void {
    for (const object of [this.background, this.dome, this.grid, this.frustum]) {
      object.geometry.dispose()
      ;(object.material as THREE.Material).dispose()
    }
    this.skyMap?.dispose()
    for (const t of this.placeholders) t.dispose()
    this.target.dispose()
  }
}
