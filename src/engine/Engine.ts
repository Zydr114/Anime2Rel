import * as THREE from 'three/webgpu'
import { texture } from 'three/tsl'
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
import { applyFinishParams, createFinishPass, createFinishUniforms, disposeFinish, setFinishLut } from './finish'
import { applyFusionParams } from './fusion'
import { createTileMapping } from './nodes'
import {
  applyAdjustParams,
  createAdjustUniforms,
  createBackgroundAdjustPass,
  createCharacterAdjustPass,
  createGlobalAdjustPass,
  createLocalUniforms,
  createToneCoefPass,
  createTonePass,
  unpremultiply,
  type AdjustUniforms,
  type LocalTone,
} from './grade'
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
import { applyPostParams, createPostPasses, createPostUniforms, disposePostPasses, renderPost, resizePostPasses, BLOOM_SIZE } from './post'
import { applyShadowParams, createShadowPass, createShadowUniforms } from './shadow'
import { planTiles, tilePlan, WHOLE_PIXELS, type Rect } from './tiling'
import { fitWithin, type Size, type ViewTransform } from '@/algo/geometry'
import { rowStride, unpackRows, WEBGPU_ROW_ALIGNMENT } from '@/algo/readback'
import type { DepthResult } from '@/depth/protocol'
import type { FocusParams } from '@/focus/params'
import type { FusionParams } from '@/fusion/params'
import { GRADE_LEVELS, type GradeLevel } from '@/grade/model'
import { getLut } from '@/grade/luts'
import type { GradeParams } from '@/grade/params'
import type { PostParams } from '@/grade/post'
import type { MatteMap, NormalMap } from '@/fusion/protocol'
import type { ShadowParams } from '@/fusion/shadow'
import type { RegionMask } from '@/focus/regions'
import { decodeOriginal } from '@/io/decode'
import type { BallPreview } from '@/lighting/preview'
import { getAsset, type AssetRef } from '@/state/assets'
import type { DebugView } from '@/state/depth'
import type { DocState } from '@/state/store'

export interface EngineOptions {
  forceWebGL?: boolean
  /** 预览渲染的长边上限（像素） */
  previewMaxEdge?: number
  /** 测试用：把纹理尺寸上限限制得比显卡更小 */
  textureLimit?: number
  /** 测试用：总是分块导出，并指定块的边长 */
  exportTile?: number
}

/** 导出结果中完整宽度的一条像素带 */
export interface ImageBand {
  /** 起始行与行数 */
  y: number
  height: number
  /** 紧密排列、首行在上的 RGBA8（sRGB） */
  pixels: Uint8Array
}

export interface ExportOptions {
  /** 按从上到下的顺序收到各条像素带 */
  onBand: (band: ImageBand) => Promise<void> | void
  /** 每渲染完一块调用一次 */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

function makePlaceholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

/** 原始数据纹理（不做色彩空间转换），线性过滤，默认无 mipmap。 */
function dataTexture(data: Uint8Array | Uint16Array, width: number, height: number, type: THREE.TextureDataType, mipmaps = false): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, type)
  t.colorSpace = THREE.NoColorSpace
  t.flipY = false
  t.generateMipmaps = mipmaps
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
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
  /** 各级是否有局部调整 */
  local: Record<GradeLevel, boolean>
  /** 后期效果，以及其中需要单独 pass 的 Bloom/Halation、光束和其中的轮廓光束 */
  post: boolean
  bloom: boolean
  rays: boolean
  rim: boolean
  /** 有调色或后期时，8 位输出前加抖动 */
  dither: boolean
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

function byteTarget(width: number, height: number): THREE.RenderTarget {
  return new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false })
}

/** 合成用的中间图层，尺寸与渲染目标相同（弥散圆统计块为 1/16，各级局部调整的引导滤波系数为 1/4） */
type LayerKey = keyof LayerTextures | 'tone' | 'adjusted'
const COEF = { background: 'backgroundCoef', character: 'characterCoef', global: 'globalCoef' } as const satisfies Record<GradeLevel, string>
type CoefKey = (typeof COEF)[GradeLevel]
const COEF_KEYS: readonly string[] = Object.values(COEF)
type LayerTargets = Record<LayerKey | 'tiles' | CoefKey, THREE.RenderTarget>
type SkipLayers = Partial<Record<LayerKey | CoefKey, boolean>>

const tileCount = (n: number) => Math.max(1, Math.ceil(n / TILE))
const coefSize = (n: number) => Math.max(1, Math.ceil(n / 4))

/** 创建中间图层（1×1，由 sizeLayers 设置尺寸）。Bloom 和光束从全局调整结果的 mipmap 采样 */
function layerTargets(adjustedMips = true): LayerTargets {
  const target = (mipmaps = false) => linearTarget(1, 1, mipmaps)
  return {
    background: target(),
    prep: target(true),
    tiles: linearTarget(1, 1, false, THREE.NearestFilter),
    backgroundDof: target(),
    character: target(true),
    characterAdjusted: target(true),
    characterDepth: target(true),
    characterDof: target(),
    occlusion: target(),
    shadow: target(true),
    composited: target(),
    adjusted: target(adjustedMips),
    graded: target(),
    tone: target(true),
    backgroundCoef: target(true),
    characterCoef: target(true),
    globalCoef: target(true),
  }
}

/** 按渲染目标的尺寸设置中间图层；skip 中的图层在这次渲染中用不到，保持 1×1 */
function sizeLayers(targets: Partial<LayerTargets>, width: number, height: number, skip: SkipLayers = {}): void {
  for (const [key, rt] of Object.entries(targets) as [keyof LayerTargets, THREE.RenderTarget][]) {
    if (key !== 'tiles' && skip[key]) continue
    if (key === 'tiles') rt.setSize(tileCount(width), tileCount(height))
    else if (COEF_KEYS.includes(key)) rt.setSize(coefSize(width), coefSize(height))
    else rt.setSize(width, height)
  }
}

/** 渲染方式：预览（叠加调试视图）、整幅导出、分块导出前的整幅代理渲染（到全局调整和 Bloom、光束为止）、分块导出的一块 */
type RenderMode = 'preview' | 'full' | 'proxy' | 'tile'

/** 渲染目标在输出图像中的范围（像素） */
interface Frame extends Rect {
  outWidth: number
  outHeight: number
}

/**
 * 渲染引擎：持有 WebGPURenderer（必要时回退 WebGL2）和所有 GPU 资源。
 * 管线：立绘预处理 → 文档空间的分层合成（预览分辨率，见 renderDocument）→ 视口显示；导出时以背景原图的分辨率合成后编码（见 renderExport）。
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
  /** 没有边缘带数据时不加轮廓光的边缘带：r = 1 在带外，g = b 表示没有线稿 */
  private readonly rimPlaceholder = dataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.UnsignedByteType)
  private charNormal: { map: NormalMap; texture: THREE.DataTexture; rim: THREE.DataTexture } | null = null
  private fusionReady = false
  /** 去除残留底色：参数是否开启、Worker 的估计结果、立绘预处理当前是否用上了它 */
  private decontaminate = false
  private matte: { map: MatteMap; foreground: THREE.DataTexture; background: THREE.DataTexture } | null = null
  private matteApplied = false
  private readonly mattePlaceholders = [makePlaceholder(), makePlaceholder()] as const
  private display: FusionDisplay = { compare: 'off', showNormals: false, showMask: false }
  private focus: FocusParams | null = null
  private shadowParams: ShadowParams | null = null
  private regions: { mask: RegionMask; texture: THREE.DataTexture } | null = null
  private grade: GradeParams | null = null
  private postParams: PostParams | null = null
  private readonly depth: Record<DepthLayer, { result: DepthResult; textures: DepthTextures } | null> = { background: null, character: null }
  private readonly charRT = linearTarget(1, 1, true)
  private readonly docRT = linearTarget(1, 1, true)
  private readonly layers = layerTargets()

  private readonly tile = createTileMapping()
  private readonly placement = createPlacement(this.tile)
  private readonly backgroundNode
  private readonly layerNodes: Record<keyof LayerTargets, THREE.TextureNode>
  private readonly depthNodes
  private readonly dof = createDofUniforms()
  private readonly emptyRegions = this.dof.regions.value
  private readonly shadow = createShadowUniforms()
  private readonly adjust = Object.fromEntries(GRADE_LEVELS.map((level) => [level, createAdjustUniforms()])) as Record<GradeLevel, AdjustUniforms>
  private readonly local = createLocalUniforms()
  private readonly finish = createFinishUniforms()
  private readonly post = createPostUniforms()
  private readonly postPasses
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
    | 'finish'
    | 'display'
    | 'present'
    | 'encode'
    | 'toneCoef',
    THREE.QuadMesh
  >
  private readonly textureLimit: number
  private readonly exportTile: number | undefined
  /** 各级局部调整的 log2 亮度 */
  private readonly toneQuads: Record<GradeLevel, THREE.QuadMesh>

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
  /** 导出期间不渲染预览：导出逐块修改统一量和图层绑定 */
  private exporting = false

  private constructor(renderer: THREE.WebGPURenderer, capabilities: GpuCapabilities, options: EngineOptions) {
    this.renderer = renderer
    this.capabilities = capabilities
    this.textureLimit = Math.min(capabilities.maxTextureSize, options.textureLimit ?? Infinity)
    this.exportTile = options.exportTile
    this.previewMaxEdge = Math.min(options.previewMaxEdge ?? 2048, this.textureLimit)

    this.charPrep = createCharPrepPass(this.placeholder, this.mattePlaceholders)
    const placement = this.placement
    this.backgroundNode = texture(this.placeholder, this.tile.toBackground(this.tile.uv))
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
      adjusted: layer('adjusted'),
      graded: layer('graded'),
      tone: layer('tone'),
      backgroundCoef: layer('backgroundCoef'),
      characterCoef: layer('characterCoef'),
      globalCoef: layer('globalCoef'),
    })
    const dof = this.dof
    const lt = (level: GradeLevel): LocalTone => ({ ...this.local, uv: this.tile.uv, tone: nodes.tone, coef: nodes[COEF[level]] })
    this.character = createCharacterPass(placement, characterNode, this.backgroundNode, this.normalPlaceholder, this.rimPlaceholder)
    this.debugView = createDisplayPass({ placement, depth: this.depthNodes, background: this.backgroundNode, colormap: this.colormap, layers: nodes, dof })
    this.present = createPresentPass(this.docRT.texture)
    this.encode = createEncodePass(this.placeholder, this.tile)
    this.postPasses = createPostPasses(this.post, nodes.adjusted, this.depthNodes.background.sky, this.depthNodes.uniforms.hasBgDepth, nodes.character, this.character.rimGlow)
    const finishInputs = { image: nodes.adjusted, bloom: this.postPasses.bloomResult, rays: this.postPasses.raysResult, tile: this.tile }
    const quad = (m: THREE.NodeMaterial) => new THREE.QuadMesh(m)
    this.quads = {
      charPrep: quad(this.charPrep.material),
      // 背景层调整只改背景本身：立绘的融合和深度仍按原图计算
      backgroundAdjust: quad(createBackgroundAdjustPass(this.adjust.background, lt('background'), this.backgroundNode)),
      prep: quad(createPrepPass(dof, nodes.background, this.depthNodes.background.depth)),
      tiles: quad(createTilePass(dof, nodes.prep)),
      backgroundDof: quad(createBackgroundDofPass(dof, nodes.prep, nodes.tiles)),
      character: quad(this.character.material),
      characterAdjust: quad(createCharacterAdjustPass(this.adjust.character, lt('character'), nodes.character)),
      characterDepth: quad(
        createCharacterDepthPass(dof, {
          p: placement.p,
          uv: this.tile.uv,
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
      globalAdjust: quad(createGlobalAdjustPass(this.adjust.global, lt('global'), nodes.composited)),
      finish: quad(createFinishPass(this.finish, this.post, finishInputs)),
      display: quad(this.debugView.material),
      present: quad(this.present.material),
      encode: quad(this.encode.material),
      // 系数 pass 只读取 tone，三级共用
      toneCoef: quad(createToneCoefPass(lt('global'))),
    }
    this.toneQuads = {
      background: quad(createTonePass(this.adjust.background, this.backgroundNode.rgb)),
      character: quad(createTonePass(this.adjust.character, unpremultiply(nodes.character), nodes.character.a)),
      global: quad(createTonePass(this.adjust.global, nodes.composited.rgb)),
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
    return this.textureLimit
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
    this.decontaminate = params?.decontaminate ?? false
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
    if (params?.levels.background !== this.grade?.levels.background) this.backgroundDirty = true
    this.grade = params
    const lut = params?.creative.lut
    setFinishLut(this.finish, (lut && getLut(lut.id)) ?? null)
    this.syncDisplay()
  }

  /** 后期效果的参数；null 为没有后期 */
  setPost(params: PostParams | null): void {
    this.postParams = params
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
    const graded = !raw && display.compare !== 'grade'
    const grade = graded && !!this.grade
    const p = this.postParams
    const post = graded && !!p?.active
    const gradeActive = grade && (this.grade!.creative.active || GRADE_LEVELS.some((level) => this.grade!.levels[level].active))
    return {
      dof: !raw && !!this.focus?.dof,
      occlusion: !raw && !!this.focus?.occlusion.enabled,
      shadow: !raw && !!this.shadowParams,
      grade,
      local: Object.fromEntries(GRADE_LEVELS.map((level) => [level, grade && !!this.grade?.levels[level].local])) as Record<GradeLevel, boolean>,
      post,
      bloom: post && (p!.bloom > 0 || p!.halation > 0),
      rays: post && (p!.rays > 0 || p!.raysRim > 0) && !!p!.raysLight,
      rim: post && p!.raysRim > 0 && !!p!.raysLight,
      dither: gradeActive || post,
    }
  }

  private syncDisplay(display = this.display): void {
    const fusion = this.character.fusion
    fusion.enabled.value = this.fusionReady && display.compare !== 'raw' ? 1 : 0
    // 对比直接贴上去的效果时，立绘保留原来的边缘
    const matte = !!this.matte && this.decontaminate && fusion.enabled.value === 1
    if (matte !== this.matteApplied) {
      this.matteApplied = matte
      this.prepCharacter()
    }
    fusion.showNormals.value = display.showNormals ? 1 : 0
    const effects = this.effects(display)
    this.dof.bypass.value = effects.dof ? 0 : 1
    this.dof.occlusion.value = effects.occlusion ? 1 : 0
    this.dof.showMask.value = display.showMask && effects.occlusion ? 1 : 0
    this.shadow.enabled.value = effects.shadow ? 1 : 0
    for (const level of GRADE_LEVELS) {
      const params = this.grade?.levels[level]
      if (params) applyAdjustParams(this.adjust[level], params, effects.grade)
      else this.adjust[level].enabled.value = 0
    }
    applyFinishParams(this.finish, this.grade?.creative ?? null, effects.grade)
    applyPostParams(this.post, this.postParams, effects.post)
    this.present.uniforms.dither.value = effects.dither ? 1 : 0
    this.encode.dither.value = effects.dither ? 1 : 0
    this.docDirty = true
    this.schedule()
  }

  /** 设置去除残留底色用的前景色与背景色；同一个对象不会重复上传。 */
  setCharacterMatte(map: MatteMap | null): void {
    if ((this.matte?.map ?? null) === map) return
    this.disposeMatte()
    if (map) {
      // 存的是 sRGB 编码值，着色器在编码空间中求解，不做解码
      const raw = (data: Uint8Array) => dataTexture(data, map.width, map.height, THREE.UnsignedByteType)
      this.matte = { map, foreground: raw(map.foreground), background: raw(map.background) }
    }
    // 先恢复原来的边缘，有新数据时 syncDisplay 再按参数处理
    const applied = this.matteApplied
    this.matteApplied = false
    if (applied) this.prepCharacter()
    this.syncDisplay()
  }

  private disposeMatte(): void {
    this.matte?.foreground.dispose()
    this.matte?.background.dispose()
    this.matte = null
  }

  /** 立绘预处理：转为线性预乘 alpha，按需去除残留底色 */
  private prepCharacter(): void {
    if (!this.charSource) return
    const u = this.charPrep.uniforms
    u.matte.value = this.matteApplied ? 1 : 0
    this.charPrep.foreground.value = this.matte?.foreground ?? this.mattePlaceholders[0]
    this.charPrep.background.value = this.matte?.background ?? this.mattePlaceholders[1]
    this.renderer.setRenderTarget(this.charRT)
    this.quads.charPrep.render(this.renderer)
    this.renderer.setRenderTarget(null)
    this.docDirty = true
  }

  /** 设置立绘的融合法线；同一个对象不会重复上传。 */
  setCharacterNormals(map: NormalMap | null): void {
    if ((this.charNormal?.map ?? null) === map) return
    this.charNormal?.texture.dispose()
    this.charNormal?.rim.dispose()
    // 带 mipmap：立绘缩小时线稿遮罩按覆盖比例过滤，不会断续地漏掉描边
    this.charNormal = map
      ? { map, texture: dataTexture(map.data, map.width, map.height, THREE.UnsignedByteType, true), rim: dataTexture(map.rim, map.width, map.height, THREE.UnsignedByteType, true) }
      : null
    this.character.characterNormal.value = this.charNormal?.texture ?? this.normalPlaceholder
    this.character.characterRim.value = this.charNormal?.rim ?? this.rimPlaceholder
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
      sizeLayers(this.layers, preview.width, preview.height)
      this.placement.uniforms.docSize.value.set(asset.width, asset.height)
      this.present.uniforms.docSize.value.set(asset.width, asset.height)
      resizePostPasses(this.postPasses, this.docSize)
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
    // 前景色估计属于上一张立绘
    this.disposeMatte()
    this.matteApplied = false
    const asset = id ? getAsset(id) : undefined
    if (!asset) return
    this.charSource = bitmapTexture(asset.bitmap)
    this.charSource.generateMipmaps = false
    this.charSource.minFilter = THREE.NearestFilter
    this.charSource.magFilter = THREE.NearestFilter
    this.charRT.setSize(asset.width, asset.height)
    this.placement.uniforms.charSize.value.set(asset.width, asset.height)
    this.charPrep.source.value = this.charSource
    this.charPrep.uniforms.texel.value.set(1 / asset.width, 1 / asset.height)
    this.prepCharacter()
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

  /** 设置渲染目标在输出图像中的位置，以及按渲染目标、输出图像换算的尺寸 */
  private setFrame(f: Frame, targets: LayerTargets, tiled: boolean): void {
    const t = this.tile.uniforms
    t.offset.value.set(f.x / f.outWidth, f.y / f.outHeight)
    t.scale.value.set(f.width / f.outWidth, f.height / f.outHeight)
    t.pixel.value.set(f.x, f.y)
    const long = Math.max(f.outWidth, f.outHeight)
    const u = this.dof
    u.targetSize.value.set(f.width, f.height)
    u.targetLong.value = long
    u.tileSize.value.set(targets.tiles.width, targets.tiles.height)
    this.character.fusion.targetScale.value = f.outWidth / this.docSize!.width
    this.local.size.value.set(f.width, f.height)
    this.local.outSize.value.set(f.outWidth, f.outHeight)
    this.local.long.value = long
    // 分块时系数纹理来自预览分辨率的整幅渲染
    const coef = targets.backgroundCoef
    this.local.coefShift.value = tiled ? Math.log2(long / Math.max(coef.width, coef.height)) : 2
    this.post.long.value = long
    this.post.aspect.value.set(f.outWidth / long, f.outHeight / long)
    this.post.sourceLod.value = Math.log2(long / BLOOM_SIZE)
  }

  /**
   * 渲染文档：背景层调整、背景预处理与景深（需要时）→ 立绘层、立绘层调整、立绘深度 → 立绘景深 → 遮挡层 → 站立阴影 → 合成 → 全局调整
   * → Bloom 金字塔与光束（需要时）→ 终处理到 out。
   * 每一级有局部调整时，先在它的调整 pass 之前算出 log2 亮度和引导滤波系数。
   * 预览时先合成到中间图层，再叠加调试视图和灰球。分块导出的一块不计算引导滤波系数、Bloom 和光束，使用代理渲染的结果。
   * frame 为 out 在输出图像中的范围，默认是整幅图像；弥散圆和噪声按输出图像相对文档的比例换算。
   */
  private renderDocument(targets: LayerTargets, out: THREE.RenderTarget, effects: Effects, mode: RenderMode, background = true, frame?: Frame): void {
    if (!this.docSize) return
    const r = this.renderer
    const tiled = mode === 'tile'
    this.setFrame(frame ?? { x: 0, y: 0, width: out.width, height: out.height, outWidth: out.width, outHeight: out.height }, targets, tiled)
    const pass = (quad: THREE.QuadMesh, target: THREE.RenderTarget) => {
      r.setRenderTarget(target)
      quad.render(r)
    }
    const tone = (level: GradeLevel) => {
      if (!effects.local[level]) return
      pass(this.toneQuads[level], targets.tone)
      if (!tiled) pass(this.quads.toneCoef, targets[COEF[level]])
    }
    if (background) {
      tone('background')
      pass(this.quads.backgroundAdjust, targets.background)
      pass(this.quads.prep, targets.prep)
      pass(this.quads.tiles, targets.tiles)
      if (effects.dof) pass(this.quads.backgroundDof, targets.backgroundDof)
    }
    pass(this.quads.character, targets.character)
    tone('character')
    pass(this.quads.characterAdjust, targets.characterAdjusted)
    pass(this.quads.characterDepth, targets.characterDepth)
    if (effects.dof) pass(this.quads.characterDof, targets.characterDof)
    if (effects.occlusion) pass(this.quads.occlusion, targets.occlusion)
    if (effects.shadow) pass(this.quads.shadow, targets.shadow)
    pass(this.quads.composite, targets.composited)
    tone('global')
    pass(this.quads.globalAdjust, targets.adjusted)
    if (!tiled) renderPost(r, this.postPasses, effects)
    if (mode === 'proxy') return
    if (mode !== 'preview') return pass(this.quads.finish, out)
    pass(this.quads.finish, targets.graded)
    pass(this.quads.display, out)
  }

  private renderFrame(): void {
    if (this.disposed) return
    const r = this.renderer
    if (this.docDirty && this.docSize && !this.exporting) {
      this.renderDocument(this.layers, this.docRT, this.effects(this.display), 'preview', this.backgroundDirty)
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

  /** 导出图像的尺寸：背景原图的分辨率 */
  exportSize(): Size | null {
    const bg = this.doc?.background
    return bg && this.docSize ? { width: bg.sourceWidth, height: bg.sourceHeight } : null
  }

  /**
   * 以背景原图的分辨率渲染最终结果，按从上到下的顺序交给 onBand（sRGB RGBA8）。
   * 图像较小时整幅渲染；超过渲染目标的面积上限、或背景超出纹理上限（预览使用缩小的位图）时分块渲染：
   * 先在预览分辨率上整幅渲染一次，得到局部调整的系数和 Bloom、光束，再逐块渲染，背景从原图中裁剪。
   */
  async renderExport(options: ExportOptions): Promise<Size> {
    const size = this.exportSize()
    const bg = this.doc?.background
    if (!size || !bg || !this.docSize) throw new Error('没有可导出的文档')
    // 导出始终是处理后的合成结果，不带调试视图、灰球、对比和遮罩预览
    const display: FusionDisplay = { compare: 'off', showNormals: false, showMask: false }
    const effects = this.effects(display)
    const skip: SkipLayers = {
      backgroundDof: !effects.dof,
      characterDof: !effects.dof,
      occlusion: !effects.occlusion,
      shadow: !effects.shadow,
      graded: true,
      tone: !GRADE_LEVELS.some((level) => effects.local[level]),
      backgroundCoef: !effects.local.background,
      characterCoef: !effects.local.character,
      globalCoef: !effects.local.global,
    }
    const downscaled = size.width !== this.docSize.width || size.height !== this.docSize.height
    this.exporting = true
    this.syncDisplay(display)
    try {
      if (!this.exportTile && !downscaled && size.width * size.height <= WHOLE_PIXELS) await this.exportWhole(size, effects, skip, options)
      else await this.exportTiles(size, effects, skip, downscaled ? bg : null, options)
      return size
    } finally {
      this.exporting = false
      this.bindLayers(this.layers)
      const t = this.tile.uniforms
      t.bgOffset.value.set(0, 0)
      t.bgScale.value.set(1, 1)
      t.bgTexel.value = 1
      this.backgroundNode.value = this.bgTexture ?? this.placeholder
      this.encode.source.value = this.placeholder
      // 代理渲染覆盖了预览的中间图层
      this.backgroundDirty = true
      this.syncDisplay()
    }
  }

  /** 编码到 8 位渲染目标并读回为紧密排列、首行在上的 RGBA8 */
  private async readEncoded(linear: THREE.RenderTarget, out: THREE.RenderTarget): Promise<Uint8Array> {
    const r = this.renderer
    const { width, height } = out
    this.encode.source.value = linear.texture
    r.setRenderTarget(out)
    this.quads.encode.render(r)
    r.setRenderTarget(null)
    const raw = (await r.readRenderTargetPixelsAsync(out, 0, 0, width, height)) as Uint8Array
    const webgl = this.capabilities.backend === 'webgl2'
    return unpackRows(raw, width, height, 4, rowStride(width, 4, 1, webgl ? 1 : WEBGPU_ROW_ALIGNMENT), webgl)
  }

  private async exportWhole({ width, height }: Size, effects: Effects, skip: SkipLayers, options: ExportOptions): Promise<void> {
    const targets = layerTargets(effects.bloom || effects.rays)
    sizeLayers(targets, width, height, skip)
    const linear = linearTarget(width, height)
    const out = byteTarget(width, height)
    try {
      this.bindLayers(targets)
      this.renderDocument(targets, linear, effects, 'full')
      const pixels = await this.readEncoded(linear, out)
      options.onProgress?.(1, 1)
      await options.onBand({ y: 0, height, pixels })
    } finally {
      for (const rt of Object.values(targets)) rt.dispose()
      linear.dispose()
      out.dispose()
    }
  }

  /** 分块渲染需要的扩展量和块大小 */
  private tilePlan(size: Size, effects: Effects, cropped: boolean) {
    const long = Math.max(size.width, size.height)
    const u = this.dof
    const water = effects.occlusion ? u.charHeight.value * 0.008 : 0
    return tilePlan({
      long,
      scale: size.width / this.docSize!.width,
      coc: effects.dof || effects.occlusion ? Math.max(u.aperture.value, u.characterCoc.value) * long : 0,
      aberration: this.post.aberration.value,
      reach: water + (cropped ? this.character.fusion.wrapRadius.value : 0),
      maxEdge: this.textureLimit,
      inner: this.exportTile,
    })
  }

  /** original 为需要从原图裁剪背景时的背景素材 */
  private async exportTiles(size: Size, effects: Effects, skip: SkipLayers, original: AssetRef | null, options: ExportOptions): Promise<void> {
    const { width, height } = size
    // 代理：预览分辨率的整幅渲染，留下各级局部调整的系数和 Bloom、光束的结果
    this.bindLayers(this.layers)
    this.renderDocument(this.layers, this.docRT, effects, 'proxy')

    const plan = this.tilePlan(size, effects, !!original)
    const rows = planTiles(width, height, plan.inner, plan.margin)
    const total = rows.length * rows[0].length
    // 各级局部调整的系数使用代理渲染的结果
    const { backgroundCoef, characterCoef, globalCoef, ...own } = layerTargets(false)
    const targets: LayerTargets = { ...own, backgroundCoef: this.layers.backgroundCoef, characterCoef: this.layers.characterCoef, globalCoef: this.layers.globalCoef }
    for (const rt of [backgroundCoef, characterCoef, globalCoef]) rt.dispose()
    const linear = linearTarget(1, 1)
    const out = byteTarget(1, 1)
    let source: ImageBitmap | null = null
    let done = 0
    try {
      if (original) {
        const asset = getAsset(original.id)
        if (!asset) throw new Error('找不到背景原图')
        source = await decodeOriginal(asset.source)
        if (source.width !== width || source.height !== height) throw new Error('背景原图的尺寸与导入时不一致')
      }
      const t = this.tile.uniforms
      this.bindLayers(targets)
      for (const row of rows) {
        const band = row[0].inner
        const pixels = new Uint8Array(width * band.height * 4)
        for (const { inner, target } of row) {
          options.signal?.throwIfAborted()
          sizeLayers(own, target.width, target.height, skip)
          linear.setSize(target.width, target.height)
          out.setSize(target.width, target.height)
          let crop: { bitmap: ImageBitmap; texture: THREE.Texture } | null = null
          if (source) {
            const bitmap = await createImageBitmap(source, target.x, target.y, target.width, target.height)
            crop = { bitmap, texture: bitmapTexture(bitmap) }
            this.backgroundNode.value = crop.texture
            t.bgOffset.value.set(target.x / width, target.y / height)
            t.bgScale.value.set(target.width / width, target.height / height)
            t.bgTexel.value = width / this.docSize!.width
          }
          try {
            this.renderDocument(targets, linear, effects, 'tile', true, { ...target, outWidth: width, outHeight: height })
            const tile = await this.readEncoded(linear, out)
            const dx = inner.x - target.x
            for (let y = 0; y < inner.height; y++) {
              const from = ((inner.y - target.y + y) * target.width + dx) * 4
              pixels.set(tile.subarray(from, from + inner.width * 4), (y * width + inner.x) * 4)
            }
          } finally {
            crop?.texture.dispose()
            crop?.bitmap.close()
          }
          options.onProgress?.(++done, total)
        }
        await options.onBand({ y: band.y, height: band.height, pixels })
      }
    } finally {
      source?.close()
      for (const rt of Object.values(own)) rt.dispose()
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
    this.rimPlaceholder.dispose()
    for (const t of this.mattePlaceholders) t.dispose()
    this.charNormal?.texture.dispose()
    this.charNormal?.rim.dispose()
    this.disposeMatte()
    this.regions?.texture.dispose()
    for (const u of Object.values(this.adjust)) u.curveMap.dispose()
    disposeFinish(this.finish)
    disposePostPasses(this.postPasses)
    for (const set of Object.values(this.depthPlaceholder)) for (const t of Object.values(set)) t.dispose()
    for (const layer of Object.values(this.depth)) if (layer) for (const t of Object.values(layer.textures)) t.dispose()
    for (const q of [...Object.values(this.quads), ...Object.values(this.toneQuads)]) (q.material as THREE.Material).dispose()
    this.renderer.dispose()
  }
}
