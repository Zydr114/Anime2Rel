import * as THREE from 'three/webgpu'
import { screenUV, texture } from 'three/tsl'
import { detectCapabilities, type GpuCapabilities } from './capabilities'
import {
  applyFocusParams,
  createBackgroundDofPass,
  createCharacterDepthPass,
  createCharacterDofPass,
  createDofUniforms,
  createOcclusionPass,
  createPrepPass,
  createTilePass,
  TILE,
} from './dof'
import { applyFusionParams } from './fusion'
import { applyAdjustParams, createAdjustUniforms, createBackgroundAdjustPass, createCharacterAdjustPass, createGlobalAdjustPass, type AdjustUniforms } from './grade'
import {
  createCharacterPass,
  createCharPrepPass,
  createCompositePass,
  createDisplayPass,
  createDepthNodes,
  createEncodePass,
  createPlacement,
  createPresentPass,
  DEBUG_VIEW_INDEX,
  PREVIEW_LIGHTS,
  type DepthTextures,
  type LayerTextures,
} from './passes'
import { applyShadowParams, createShadowPass, createShadowUniforms } from './shadow'
import { fitWithin, type Size, type ViewTransform } from '@/algo/geometry'
import { rowStride, unpackRows, WEBGPU_ROW_ALIGNMENT } from '@/algo/readback'
import type { DepthResult } from '@/depth/protocol'
import type { FocusParams } from '@/focus/params'
import type { FusionParams } from '@/fusion/params'
import { GRADE_LEVELS, type GradeLevel } from '@/grade/model'
import type { GradeParams } from '@/grade/params'
import type { NormalMap } from '@/fusion/protocol'
import type { ShadowParams } from '@/fusion/shadow'
import type { RegionMask } from '@/focus/regions'
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

/** 前后对比（只影响预览）：raw 为直接贴上去，不做融合、景深、遮挡和调色；grade 为调色前的结果 */
export type CompareMode = 'off' | 'raw' | 'grade'

export interface FusionDisplay {
  compare: CompareMode
  /** 预览中显示立绘的融合法线 */
  showNormals: boolean
  /** 预览中用红色叠加显示深度遮挡的遮罩 */
  showMask: boolean
}

interface Effects {
  dof: boolean
  occlusion: boolean
  shadow: boolean
  /** 三级调整与全局调色 */
  grade: boolean
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

function linearTarget(width: number, height: number, mipmaps = false, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter): THREE.RenderTarget {
  return new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : filter,
    magFilter: filter,
  })
}

/** 合成用的中间图层，尺寸与输出相同（弥散圆统计块为 1/16） */
type LayerTargets = Record<keyof LayerTextures | 'tiles', THREE.RenderTarget>

const tileCount = (n: number) => Math.max(1, Math.ceil(n / TILE))

/** 创建中间图层；skip 中的图层在这次渲染中用不到，只分配 1×1 */
function layerTargets(width: number, height: number, skip: Partial<Record<keyof LayerTextures, boolean>> = {}): LayerTargets {
  const target = (key: keyof LayerTextures, mipmaps = false) => (skip[key] ? linearTarget(1, 1) : linearTarget(width, height, mipmaps))
  return {
    background: target('background'),
    prep: target('prep', true),
    tiles: linearTarget(tileCount(width), tileCount(height), false, THREE.NearestFilter),
    backgroundDof: target('backgroundDof'),
    character: target('character', true),
    characterAdjusted: target('characterAdjusted', true),
    characterDepth: target('characterDepth', true),
    characterDof: target('characterDof'),
    occlusion: target('occlusion'),
    shadow: target('shadow', true),
    composited: target('composited'),
    graded: target('graded'),
  }
}

/**
 * 渲染引擎：持有 WebGPURenderer（必要时回退 WebGL2）和所有 GPU 资源。
 * 管线：立绘预处理 → 文档空间的分层合成（预览分辨率，见 renderDocument）→ 视口显示；导出时以原分辨率合成后编码。
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
  private display: FusionDisplay = { compare: 'off', showNormals: false, showMask: false }
  private focus: FocusParams | null = null
  private shadowParams: ShadowParams | null = null
  private regions: { mask: RegionMask; texture: THREE.DataTexture } | null = null
  private grade: GradeParams | null = null
  private readonly depth: Record<DepthLayer, { result: DepthResult; textures: DepthTextures } | null> = { background: null, character: null }
  private readonly charRT = linearTarget(1, 1, true)
  private readonly docRT = linearTarget(1, 1, true)
  private readonly layers = layerTargets(1, 1)

  private readonly placement = createPlacement()
  private readonly backgroundNode
  private readonly layerNodes: Record<keyof LayerTargets, THREE.TextureNode>
  private readonly depthNodes
  private readonly dof = createDofUniforms()
  private readonly emptyRegions = this.dof.regions.value
  private readonly shadow = createShadowUniforms()
  private readonly adjust = Object.fromEntries(GRADE_LEVELS.map((level) => [level, createAdjustUniforms()])) as Record<GradeLevel, AdjustUniforms>
  private readonly charPrep
  private readonly character
  /** 预览时叠加在合成结果上的调试视图和灰球 */
  private readonly debugView
  private readonly present
  private readonly encode
  private readonly quads: Record<
    | 'charPrep'
    | 'backgroundAdjust'
    | 'prep'
    | 'tiles'
    | 'backgroundDof'
    | 'character'
    | 'characterAdjust'
    | 'characterDepth'
    | 'characterDof'
    | 'occlusion'
    | 'shadow'
    | 'composite'
    | 'globalAdjust'
    | 'display'
    | 'present'
    | 'encode',
    THREE.QuadMesh
  >

  private bgAssetId: string | null = null
  private charAssetId: string | null = null
  private bgTexture: THREE.Texture | null = null
  private charSource: THREE.Texture | null = null
  private doc: DocState | null = null
  private docSize: Size | null = null

  private docDirty = false
  /** 背景预处理、弥散圆统计和背景景深需要重算（背景、深度、焦点或光圈变化） */
  private backgroundDirty = true
  private viewDirty = false
  private frame = 0
  private disposed = false

  private constructor(renderer: THREE.WebGPURenderer, capabilities: GpuCapabilities, options: EngineOptions) {
    this.renderer = renderer
    this.capabilities = capabilities
    this.previewMaxEdge = Math.min(options.previewMaxEdge ?? 2048, capabilities.maxTextureSize)

    this.charPrep = createCharPrepPass(this.placeholder)
    const placement = this.placement
    this.backgroundNode = texture(this.placeholder, screenUV)
    const characterNode = texture(this.charRT.texture, placement.charUV)
    this.depthNodes = createDepthNodes(placement, this.backgroundNode, characterNode, this.depthPlaceholder)
    const layer = (key: keyof LayerTargets) => texture(this.layers[key].texture)
    const nodes = (this.layerNodes = {
      background: layer('background'),
      prep: layer('prep'),
      tiles: layer('tiles'),
      backgroundDof: layer('backgroundDof'),
      character: layer('character'),
      characterAdjusted: layer('characterAdjusted'),
      characterDepth: layer('characterDepth'),
      characterDof: layer('characterDof'),
      occlusion: layer('occlusion'),
      shadow: layer('shadow'),
      composited: layer('composited'),
      graded: layer('graded'),
    })
    const dof = this.dof
    this.character = createCharacterPass(placement, characterNode, this.backgroundNode, this.normalPlaceholder)
    this.debugView = createDisplayPass({ placement, depth: this.depthNodes, background: this.backgroundNode, colormap: this.colormap, layers: nodes, dof })
    this.present = createPresentPass(this.docRT.texture)
    this.encode = createEncodePass(this.placeholder)
    const quad = (m: THREE.NodeMaterial) => new THREE.QuadMesh(m)
    this.quads = {
      charPrep: quad(this.charPrep.material),
      // 背景层调整只改背景本身：立绘的融合和深度仍按原图计算
      backgroundAdjust: quad(createBackgroundAdjustPass(this.adjust.background, this.backgroundNode)),
      prep: quad(createPrepPass(dof, nodes.background, this.depthNodes.background.depth)),
      tiles: quad(createTilePass(dof, nodes.prep)),
      backgroundDof: quad(createBackgroundDofPass(dof, nodes.prep, nodes.tiles)),
      character: quad(this.character.material),
      characterAdjust: quad(createCharacterAdjustPass(this.adjust.character, nodes.character)),
      characterDepth: quad(
        createCharacterDepthPass(dof, {
          p: placement.p,
          alpha: characterNode.a.mul(placement.inside),
          inside: placement.inside,
          relief: this.depthNodes.character.depth,
          hasRelief: this.depthNodes.uniforms.hasCharDepth,
          background: this.depthNodes.background.depth,
        }),
      ),
      characterDof: quad(createCharacterDofPass(dof, nodes.characterAdjusted, nodes.characterDepth)),
      occlusion: quad(createOcclusionPass(dof, nodes.prep, nodes.tiles, nodes.characterDepth)),
      shadow: quad(createShadowPass(this.shadow, placement, texture(this.charRT.texture), this.depthNodes.background)),
      composite: quad(createCompositePass({ placement, background: nodes.background, layers: nodes, dof, shadow: this.shadow })),
      globalAdjust: quad(createGlobalAdjustPass(this.adjust.global, nodes.composited)),
      display: quad(this.debugView.material),
      present: quad(this.present.material),
      encode: quad(this.encode.material),
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
    const u = this.placement.uniforms
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
    const nodes = this.depthNodes.textures[layer]
    const src = textures ?? this.depthPlaceholder[layer]
    nodes.coef.value = src.coef
    nodes.aux.value = src.aux
    nodes.normal.value = src.normal
    const u = this.depthNodes.uniforms
    if (layer === 'background') {
      u.hasBgDepth.value = textures ? 1 : 0
      this.backgroundDirty = true
    } else u.hasCharDepth.value = textures ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  setDebug(settings: DebugSettings): void {
    const u = this.debugView.uniforms
    u.view.value = DEBUG_VIEW_INDEX[settings.view]
    u.overlay.value = settings.overlay
    const edgeAlign = settings.edgeAlign ? 1 : 0
    if (this.depthNodes.uniforms.edgeAlign.value !== edgeAlign) this.backgroundDirty = true
    this.depthNodes.uniforms.edgeAlign.value = edgeAlign
    this.docDirty = true
    this.schedule()
  }

  /** 显示或隐藏灰球预览。导出时始终隐藏。 */
  setBallPreview(preview: BallPreview | null): void {
    const u = this.debugView.ball
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
    if (params) applyFusionParams(this.character.fusion, params)
    this.syncDisplay()
  }

  /** 设置景深与遮挡参数；null 表示关闭。 */
  setFocus(params: FocusParams | null): void {
    this.focus = params
    if (params && applyFocusParams(this.dof, params)) this.backgroundDirty = true
    this.syncDisplay()
  }

  /** 遮挡区域遮罩；同一个对象不会重复上传，null 为没有区域 */
  setOcclusionRegions(mask: RegionMask | null): void {
    if (this.regions?.mask === mask || (!this.regions && !mask)) return
    this.regions?.texture.dispose()
    this.regions = mask && { mask, texture: dataTexture(mask.data, mask.width, mask.height, THREE.UnsignedByteType) }
    this.dof.regions.value = this.regions?.texture ?? this.emptyRegions
    this.docDirty = true
    this.schedule()
  }

  /** 站立阴影；null 为不画阴影 */
  setShadow(params: ShadowParams | null): void {
    this.shadowParams = params
    if (params) applyShadowParams(this.shadow, params)
    this.syncDisplay()
  }

  /** 三级调整的参数；null 为不调整 */
  setGrade(params: GradeParams | null): void {
    // 背景层调整变化时，背景预处理和背景景深需要重算
    if (params?.background !== this.grade?.background) this.backgroundDirty = true
    this.grade = params
    this.syncDisplay()
  }

  setDisplay(display: FusionDisplay): void {
    // 退出对比或法线视图时，背景景深需要按最新参数重算
    if (display.compare !== this.display.compare || display.showNormals !== this.display.showNormals) this.backgroundDirty = true
    this.display = display
    this.syncDisplay()
  }

  /** 景深、遮挡和阴影是否生效：前后对比和法线视图显示未经处理的图层 */
  private effects(display: FusionDisplay): Effects {
    const raw = display.compare === 'raw' || display.showNormals
    return {
      dof: !raw && !!this.focus?.dof,
      occlusion: !raw && !!this.focus?.occlusion.enabled,
      shadow: !raw && !!this.shadowParams,
      grade: !raw && display.compare !== 'grade' && !!this.grade,
    }
  }

  private syncDisplay(display = this.display): void {
    const fusion = this.character.fusion
    fusion.enabled.value = this.fusionReady && display.compare !== 'raw' ? 1 : 0
    fusion.showNormals.value = display.showNormals ? 1 : 0
    const effects = this.effects(display)
    this.dof.bypass.value = effects.dof ? 0 : 1
    this.dof.occlusion.value = effects.occlusion ? 1 : 0
    this.dof.showMask.value = display.showMask && effects.occlusion ? 1 : 0
    this.shadow.enabled.value = effects.shadow ? 1 : 0
    for (const level of GRADE_LEVELS) {
      const params = this.grade?.[level]
      if (params) applyAdjustParams(this.adjust[level], params, effects.grade)
      else this.adjust[level].enabled.value = 0
    }
    this.docDirty = true
    this.schedule()
  }

  /** 设置立绘的融合法线；同一个对象不会重复上传。 */
  setCharacterNormals(map: NormalMap | null): void {
    if ((this.charNormal?.map ?? null) === map) return
    this.charNormal?.texture.dispose()
    this.charNormal = map ? { map, texture: dataTexture(map.data, map.width, map.height, THREE.UnsignedByteType) } : null
    this.character.characterNormal.value = this.charNormal?.texture ?? this.normalPlaceholder
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
      for (const [key, rt] of Object.entries(this.layers))
        if (key === 'tiles') rt.setSize(tileCount(preview.width), tileCount(preview.height))
        else rt.setSize(preview.width, preview.height)
      this.placement.uniforms.docSize.value.set(asset.width, asset.height)
      this.present.uniforms.docSize.value.set(asset.width, asset.height)
    } else {
      this.docSize = null
    }
    this.backgroundNode.value = this.bgTexture ?? this.placeholder
    this.backgroundDirty = true
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
    this.placement.uniforms.charSize.value.set(asset.width, asset.height)
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

  /** 把各图层的纹理节点指向一组渲染目标 */
  private bindLayers(targets: LayerTargets): void {
    for (const key of Object.keys(targets) as (keyof LayerTargets)[]) this.layerNodes[key].value = targets[key].texture
  }

  /**
   * 渲染文档：背景层调整、背景预处理与景深（需要时）→ 立绘层、立绘层调整、立绘深度 → 立绘景深 → 遮挡层 → 站立阴影 → 合成 → 全局调整到 out。
   * 预览（preview 为 true）时先合成到中间图层，再叠加调试视图和灰球。
   * 尺寸由 out 决定，弥散圆和噪声按 out 相对文档的比例换算。
   */
  private renderDocument(targets: LayerTargets, out: THREE.RenderTarget, background: boolean, effects: Effects, preview = false): void {
    if (!this.docSize) return
    const r = this.renderer
    const { width, height } = out
    const u = this.dof
    u.targetSize.value.set(width, height)
    u.targetLong.value = Math.max(width, height)
    u.tileSize.value.set(targets.tiles.width, targets.tiles.height)
    this.character.fusion.targetScale.value = width / this.docSize.width
    const pass = (quad: THREE.QuadMesh, target: THREE.RenderTarget) => {
      r.setRenderTarget(target)
      quad.render(r)
    }
    if (background) {
      pass(this.quads.backgroundAdjust, targets.background)
      pass(this.quads.prep, targets.prep)
      pass(this.quads.tiles, targets.tiles)
      if (effects.dof) pass(this.quads.backgroundDof, targets.backgroundDof)
    }
    pass(this.quads.character, targets.character)
    pass(this.quads.characterAdjust, targets.characterAdjusted)
    pass(this.quads.characterDepth, targets.characterDepth)
    if (effects.dof) pass(this.quads.characterDof, targets.characterDof)
    if (effects.occlusion) pass(this.quads.occlusion, targets.occlusion)
    if (effects.shadow) pass(this.quads.shadow, targets.shadow)
    pass(this.quads.composite, targets.composited)
    if (!preview) return pass(this.quads.globalAdjust, out)
    pass(this.quads.globalAdjust, targets.graded)
    pass(this.quads.display, out)
  }

  private renderFrame(): void {
    if (this.disposed) return
    const r = this.renderer
    if (this.docDirty && this.docSize) {
      this.renderDocument(this.layers, this.docRT, this.backgroundDirty, this.effects(this.display), true)
      this.backgroundDirty = false
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
    // 导出始终是处理后的合成结果，不带调试视图、灰球、对比和遮罩预览
    const display: FusionDisplay = { compare: 'off', showNormals: false, showMask: false }
    const effects = this.effects(display)
    const targets = layerTargets(width, height, { backgroundDof: !effects.dof, characterDof: !effects.dof, occlusion: !effects.occlusion, shadow: !effects.shadow, graded: true })
    const linear = linearTarget(width, height)
    const out = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false })
    this.syncDisplay(display)
    try {
      this.bindLayers(targets)
      this.renderDocument(targets, linear, true, effects)
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
      this.bindLayers(this.layers)
      this.syncDisplay()
      this.encode.source.value = this.placeholder
      for (const rt of Object.values(targets)) rt.dispose()
      linear.dispose()
      out.dispose()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    this.bgTexture?.dispose()
    this.charSource?.dispose()
    this.charRT.dispose()
    this.docRT.dispose()
    for (const rt of Object.values(this.layers)) rt.dispose()
    this.placeholder.dispose()
    this.colormap.dispose()
    this.normalPlaceholder.dispose()
    this.charNormal?.texture.dispose()
    this.regions?.texture.dispose()
    for (const u of Object.values(this.adjust)) u.curveMap.dispose()
    for (const set of Object.values(this.depthPlaceholder)) for (const t of Object.values(set)) t.dispose()
    for (const layer of Object.values(this.depth)) if (layer) for (const t of Object.values(layer.textures)) t.dispose()
    for (const q of Object.values(this.quads)) (q.material as THREE.Material).dispose()
    this.renderer.dispose()
  }
}
