import * as THREE from 'three/webgpu'
import { detectCapabilities, type GpuCapabilities } from './capabilities'
import { applyFusionParams } from './fusion'
import { createCharPrepPass, createCompositePass, createEncodePass, createPresentPass, DEBUG_VIEW_INDEX, PREVIEW_LIGHTS, type DepthTextures } from './passes'
import { fitWithin, type Size, type ViewTransform } from '@/algo/geometry'
import { rowStride, unpackRows, WEBGPU_ROW_ALIGNMENT } from '@/algo/readback'
import type { DepthResult } from '@/depth/protocol'
import type { FusionParams } from '@/fusion/params'
import type { NormalMap } from '@/fusion/protocol'
import type { BallPreview } from '@/lighting/preview'
import { getAsset } from '@/state/assets'
import type { DebugView } from '@/state/depth'
import type { DocState } from '@/state/store'

export interface EngineOptions {
  forceWebGL?: boolean
  /** 预览渲染的长边上限（像素） */
  previewMaxEdge?: number
}

export interface RenderedImage {
  width: number
  height: number
  /** 紧密排列、首行在上的 RGBA8（sRGB） */
  pixels: Uint8Array
}

function makePlaceholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

/** 原始数据纹理（不做色彩空间转换），线性过滤，无 mipmap。 */
function dataTexture(data: Uint8Array | Uint16Array, width: number, height: number, type: THREE.TextureDataType): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, type)
  t.colorSpace = THREE.NoColorSpace
  t.flipY = false
  t.generateMipmaps = false
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

/** inferno 色带的 17 个采样点（sRGB），取自 matplotlib（CC0）。 */
const INFERNO = [
  0x000004, 0x0b0724, 0x210c4a, 0x3d0965, 0x57106e, 0x71196e, 0x8a226a, 0xa32c61, 0xbc3754, 0xd24644, 0xe45a31, 0xf1731d, 0xf98e09,
  0xfcac11, 0xf9cb35, 0xf2ea69, 0xfcffa4,
]

/** 深度视图的色带：256×1，存 sRGB 编码值，着色器中解码。 */
function makeColormap(): THREE.DataTexture {
  const n = 256
  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (INFERNO.length - 1)
    const k = Math.min(INFERNO.length - 2, Math.floor(t))
    const f = t - k
    for (let c = 0; c < 3; c++) {
      const a = (INFERNO[k] >> (16 - 8 * c)) & 0xff
      const b = (INFERNO[k + 1] >> (16 - 8 * c)) & 0xff
      data[i * 4 + c] = Math.round(a + (b - a) * f)
    }
    data[i * 4 + 3] = 255
  }
  return dataTexture(data, n, 1, THREE.UnsignedByteType)
}

function depthPlaceholder(): DepthTextures {
  return {
    coef: dataTexture(new Uint16Array(4), 1, 1, THREE.HalfFloatType),
    aux: dataTexture(new Uint16Array(4), 1, 1, THREE.HalfFloatType),
    normal: dataTexture(new Uint8Array([128, 128, 255, 0]), 1, 1, THREE.UnsignedByteType),
  }
}

function depthTextures(result: DepthResult): DepthTextures {
  const { width, height } = result.guideSize
  return {
    coef: dataTexture(result.coefHalf, width, height, THREE.HalfFloatType),
    aux: dataTexture(result.auxHalf, width, height, THREE.HalfFloatType),
    normal: dataTexture(result.normal, width, height, THREE.UnsignedByteType),
  }
}

export type DepthLayer = 'background' | 'character'

export interface FusionDisplay {
  /** 前后对比：预览中显示未融合的立绘（导出不受影响） */
  compare: boolean
  /** 预览中显示立绘的融合法线 */
  showNormals: boolean
}

export interface DebugSettings {
  view: DebugView
  overlay: number
  edgeAlign: boolean
}

function bitmapTexture(bitmap: ImageBitmap): THREE.Texture {
  const t = new THREE.Texture(bitmap)
  t.colorSpace = THREE.SRGBColorSpace
  t.flipY = false
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

function linearTarget(width: number, height: number, mipmaps = false): THREE.RenderTarget {
  return new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })
}

/**
 * 渲染引擎：持有 WebGPURenderer（必要时回退 WebGL2）和所有 GPU 资源。
 * 管线：立绘预处理 → 文档空间合成（预览分辨率）→ 视口显示；导出时以原分辨率合成后编码。
 */
export class Engine {
  readonly renderer: THREE.WebGPURenderer
  readonly capabilities: GpuCapabilities
  private readonly previewMaxEdge: number

  private readonly placeholder = makePlaceholder()
  // 每个图层各用一套占位纹理：three.js 按纹理 uuid 合并 uniform，共用时替换其中一个图层会失效
  private readonly depthPlaceholder: Record<DepthLayer, DepthTextures> = { background: depthPlaceholder(), character: depthPlaceholder() }
  private readonly colormap = makeColormap()
  private readonly normalPlaceholder = dataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.UnsignedByteType)
  private charNormal: { map: NormalMap; texture: THREE.DataTexture } | null = null
  private fusionReady = false
  private fusionDisplay: FusionDisplay = { compare: false, showNormals: false }
  private readonly depth: Record<DepthLayer, { result: DepthResult; textures: DepthTextures } | null> = { background: null, character: null }
  private readonly charRT = linearTarget(1, 1, true)
  private readonly docRT = linearTarget(1, 1, true)

  private readonly charPrep
  private readonly composite
  private readonly present
  private readonly encode
  private readonly quads: { charPrep: THREE.QuadMesh; composite: THREE.QuadMesh; present: THREE.QuadMesh; encode: THREE.QuadMesh }

  private bgAssetId: string | null = null
  private charAssetId: string | null = null
  private bgTexture: THREE.Texture | null = null
  private charSource: THREE.Texture | null = null
  private doc: DocState | null = null
  private docSize: Size | null = null

  private docDirty = false
  private viewDirty = false
  private frame = 0
  private disposed = false

  private constructor(renderer: THREE.WebGPURenderer, capabilities: GpuCapabilities, options: EngineOptions) {
    this.renderer = renderer
    this.capabilities = capabilities
    this.previewMaxEdge = Math.min(options.previewMaxEdge ?? 2048, capabilities.maxTextureSize)

    this.charPrep = createCharPrepPass(this.placeholder)
    this.composite = createCompositePass(this.placeholder, this.charRT.texture, this.depthPlaceholder, this.colormap, this.normalPlaceholder)
    this.present = createPresentPass(this.docRT.texture)
    this.encode = createEncodePass(this.placeholder)
    this.quads = {
      charPrep: new THREE.QuadMesh(this.charPrep.material),
      composite: new THREE.QuadMesh(this.composite.material),
      present: new THREE.QuadMesh(this.present.material),
      encode: new THREE.QuadMesh(this.encode.material),
    }
  }

  static async create(canvas: HTMLCanvasElement, options: EngineOptions = {}): Promise<Engine> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL: options.forceWebGL ?? false })
    await renderer.init()
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    const capabilities = await detectCapabilities(renderer)
    return new Engine(renderer, capabilities, options)
  }

  get maxTextureSize(): number {
    return this.capabilities.maxTextureSize
  }

  setDocument(doc: DocState): void {
    if (doc === this.doc) return
    this.doc = doc
    this.syncBackground(doc)
    this.syncCharacter(doc)

    const t = doc.charTransform
    const u = this.composite.uniforms
    u.charCenter.value.set(t.x, t.y)
    u.charRotation.value = t.rotation
    u.charScale.value = Math.max(t.scale, 1e-6)
    u.charFlip.value = t.flipX ? -1 : 1
    u.hasChar.value = doc.character && this.charSource ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  setView(view: ViewTransform, viewport: Size): void {
    const u = this.present.uniforms
    u.zoom.value = view.zoom
    u.pan.value.set(view.panX, view.panY)
    if (u.viewport.value.x !== viewport.width || u.viewport.value.y !== viewport.height) {
      u.viewport.value.set(viewport.width, viewport.height)
      this.renderer.setPixelRatio(window.devicePixelRatio || 1)
      this.renderer.setSize(viewport.width, viewport.height, false)
    }
    this.viewDirty = true
    this.schedule()
  }

  /** 设置某一图层的深度结果；同一个结果对象不会重复上传。 */
  setDepth(layer: DepthLayer, result: DepthResult | undefined): void {
    const current = this.depth[layer]
    if ((current?.result ?? undefined) === result) return
    if (current) for (const t of Object.values(current.textures)) t.dispose()
    const textures = result ? depthTextures(result) : null
    this.depth[layer] = result && textures ? { result, textures } : null
    const nodes = this.composite.depth[layer]
    const src = textures ?? this.depthPlaceholder[layer]
    nodes.coef.value = src.coef
    nodes.aux.value = src.aux
    nodes.normal.value = src.normal
    const u = this.composite.uniforms
    if (layer === 'background') u.hasBgDepth.value = textures ? 1 : 0
    else u.hasCharDepth.value = textures ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  setDebug(settings: DebugSettings): void {
    const u = this.composite.uniforms
    u.view.value = DEBUG_VIEW_INDEX[settings.view]
    u.overlay.value = settings.overlay
    u.edgeAlign.value = settings.edgeAlign ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  /** 显示或隐藏灰球预览。导出时始终隐藏。 */
  setBallPreview(preview: BallPreview | null): void {
    const u = this.composite.ball
    u.showBall.value = preview ? 1 : 0
    if (preview) {
      u.ballCenter.value.set(preview.center.x, preview.center.y)
      u.ballRadius.value = Math.max(preview.radius, 1)
      u.sh.forEach((node, k) => node.value.set(preview.ambient[k * 3], preview.ambient[k * 3 + 1], preview.ambient[k * 3 + 2]))
      u.lights.forEach((node, i) => {
        const l = preview.lights[i]
        node.direction.value.set(...(l?.direction ?? [0, 0, 1]))
        node.color.value.set(...(l?.color ?? [0, 0, 0]))
        node.softness.value = l?.softness ?? 0
      })
      if (preview.lights.length > PREVIEW_LIGHTS) console.warn('[engine] 灰球预览只使用前', PREVIEW_LIGHTS, '个光源')
    }
    this.docDirty = true
    this.schedule()
  }

  /** 设置融合参数；null 表示数据未就绪，立绘按原样显示。 */
  setFusion(params: FusionParams | null): void {
    this.fusionReady = !!params
    if (params) applyFusionParams(this.composite.fusion, params)
    this.syncFusionDisplay()
  }

  setFusionDisplay(display: FusionDisplay): void {
    this.fusionDisplay = display
    this.syncFusionDisplay()
  }

  private syncFusionDisplay(): void {
    const u = this.composite.fusion
    u.enabled.value = this.fusionReady && !this.fusionDisplay.compare ? 1 : 0
    u.showNormals.value = this.fusionDisplay.showNormals ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  /** 设置立绘的融合法线；同一个对象不会重复上传。 */
  setCharacterNormals(map: NormalMap | null): void {
    if ((this.charNormal?.map ?? null) === map) return
    this.charNormal?.texture.dispose()
    this.charNormal = map ? { map, texture: dataTexture(map.data, map.width, map.height, THREE.UnsignedByteType) } : null
    this.composite.characterNormal.value = this.charNormal?.texture ?? this.normalPlaceholder
    this.docDirty = true
    this.schedule()
  }

  private syncBackground(doc: DocState): void {
    const id = doc.background?.id ?? null
    if (id === this.bgAssetId) return
    this.bgAssetId = id
    this.bgTexture?.dispose()
    this.bgTexture = null
    const asset = id ? getAsset(id) : undefined
    if (asset) {
      this.bgTexture = bitmapTexture(asset.bitmap)
      this.docSize = { width: asset.width, height: asset.height }
      const preview = fitWithin(this.docSize, this.previewMaxEdge)
      this.docRT.setSize(preview.width, preview.height)
      this.composite.uniforms.docSize.value.set(asset.width, asset.height)
      this.present.uniforms.docSize.value.set(asset.width, asset.height)
    } else {
      this.docSize = null
    }
    this.composite.background.value = this.bgTexture ?? this.placeholder
  }

  private syncCharacter(doc: DocState): void {
    const id = doc.character?.id ?? null
    if (id === this.charAssetId) return
    this.charAssetId = id
    this.charSource?.dispose()
    this.charSource = null
    const asset = id ? getAsset(id) : undefined
    if (!asset) return
    this.charSource = bitmapTexture(asset.bitmap)
    this.charSource.generateMipmaps = false
    this.charSource.minFilter = THREE.NearestFilter
    this.charSource.magFilter = THREE.NearestFilter
    this.charRT.setSize(asset.width, asset.height)
    this.composite.uniforms.charSize.value.set(asset.width, asset.height)
    this.charPrep.source.value = this.charSource
    this.renderer.setRenderTarget(this.charRT)
    this.quads.charPrep.render(this.renderer)
    this.renderer.setRenderTarget(null)
  }

  private schedule(): void {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderFrame()
    })
  }

  private renderFrame(): void {
    if (this.disposed) return
    const r = this.renderer
    if (this.docDirty && this.docSize) {
      this.composite.fusion.targetScale.value = this.docRT.width / this.docSize.width
      r.setRenderTarget(this.docRT)
      this.quads.composite.render(r)
      this.docDirty = false
      this.viewDirty = true
    }
    if (this.viewDirty) {
      r.setRenderTarget(null)
      if (!this.docSize) this.present.uniforms.docSize.value.set(0, 0)
      this.quads.present.render(r)
      this.viewDirty = false
    }
  }

  /** 以背景原分辨率渲染最终结果并读回为 sRGB RGBA8。 */
  async renderFullResolution(): Promise<RenderedImage> {
    if (!this.docSize || !this.doc) throw new Error('没有可导出的文档')
    const { width, height } = this.docSize
    const r = this.renderer
    const linear = linearTarget(width, height)
    const out = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false })
    // 导出始终是融合后的合成结果，不带调试视图、灰球和对比
    const view = this.composite.uniforms.view.value
    const ball = this.composite.ball.showBall.value
    const fusion = this.composite.fusion
    this.composite.uniforms.view.value = 0
    this.composite.ball.showBall.value = 0
    fusion.enabled.value = this.fusionReady ? 1 : 0
    fusion.showNormals.value = 0
    fusion.targetScale.value = 1
    try {
      r.setRenderTarget(linear)
      this.quads.composite.render(r)
      this.encode.source.value = linear.texture
      r.setRenderTarget(out)
      this.quads.encode.render(r)
      r.setRenderTarget(null)
      const raw = (await r.readRenderTargetPixelsAsync(out, 0, 0, width, height)) as Uint8Array
      const webgl = this.capabilities.backend === 'webgl2'
      const stride = rowStride(width, 4, 1, webgl ? 1 : WEBGPU_ROW_ALIGNMENT)
      const pixels = unpackRows(raw, width, height, 4, stride, webgl)
      return { width, height, pixels }
    } finally {
      this.composite.uniforms.view.value = view
      this.composite.ball.showBall.value = ball
      this.syncFusionDisplay()
      this.encode.source.value = this.placeholder
      linear.dispose()
      out.dispose()
      this.docDirty = true
      this.schedule()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    this.bgTexture?.dispose()
    this.charSource?.dispose()
    this.charRT.dispose()
    this.docRT.dispose()
    this.placeholder.dispose()
    this.colormap.dispose()
    this.normalPlaceholder.dispose()
    this.charNormal?.texture.dispose()
    for (const set of Object.values(this.depthPlaceholder)) for (const t of Object.values(set)) t.dispose()
    for (const layer of Object.values(this.depth)) if (layer) for (const t of Object.values(layer.textures)) t.dispose()
    for (const q of Object.values(this.quads)) (q.material as THREE.Material).dispose()
    this.renderer.dispose()
  }
}
