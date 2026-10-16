import * as THREE from 'three/webgpu'
import { detectCapabilities, type GpuCapabilities } from './capabilities'
import { createCharPrepPass, createCompositePass, createEncodePass, createPresentPass } from './passes'
import { fitWithin, type Size, type ViewTransform } from '@/algo/geometry'
import { rowStride, unpackRows, WEBGPU_ROW_ALIGNMENT } from '@/algo/readback'
import { getAsset } from '@/state/assets'
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
    this.composite = createCompositePass(this.placeholder, this.charRT.texture)
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
      this.encode.source.value = this.placeholder
      linear.dispose()
      out.dispose()
      this.viewDirty = true
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
    for (const q of Object.values(this.quads)) (q.material as THREE.Material).dispose()
    this.renderer.dispose()
  }
}
