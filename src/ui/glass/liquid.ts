/**
 * 液态玻璃的表面管理（docs/Plan.md §6.3）。
 * 玻璃表面包括带 glass 类的元素（玻璃画在 ::before 上），以及 mdui 弹出层的容器：对话框面板、菜单、提示、消息条。
 * Chromium 中每个表面有自己的 SVG 滤镜，位移图按表面的尺寸和圆角生成，尺寸变化时重新生成。
 * 滤镜放在表面所在的文档或 shadow root 里，因为 shadow DOM 中的 url(#id) 只在本 root 内查找。
 * 其他浏览器使用毛玻璃；“减少特效”或系统要求降低透明度时使用不透明面板。各模式的样式见 styles/index.css。
 */
import { useAppearance } from '@/state/appearance'
import { displacementMap, opticsFor, type GlassShape } from './displacement'

export type GlassMode = 'liquid' | 'frosted' | 'solid'
const MODES: readonly GlassMode[] = ['liquid', 'frosted', 'solid']

/** 折射之前的模糊和饱和度（CSS 滤镜，边缘按镜像延伸，不会发暗） */
const BACKDROP = 'blur(6px) saturate(140%)'
/** 着色放在 SVG 滤镜里，边缘高光才能叠在着色之上 */
const TINT = { color: '#1b1a18', opacity: 0.55 }
/** 高光的不透明度 */
const SPECULAR = 0.85
/** 尺寸连续变化（如工具栏的放大动画）时先拉伸现有的位移图，停止变化这么久之后再重新生成 */
const SETTLE_MS = 120

const SVG_NS = 'http://www.w3.org/2000/svg'

/** mdui 弹出层：玻璃容器在 shadow DOM 中的选择器，null 表示宿主本身 */
const POPUPS: Record<string, string | null> = {
  'mdui-dialog': '[part~="panel"]',
  'mdui-tooltip': '[part~="popup"]',
  'mdui-select': '[part~="menu"]',
  'mdui-menu': null,
  'mdui-snackbar': null,
}
const SELECTOR = ['.glass', ...Object.keys(POPUPS)].join(',')

interface Filter {
  id: string
  element: SVGFilterElement
  image: SVGFEImageElement
  displacement: SVGFEDisplacementMapElement
}

interface Surface {
  /** 写入 --glass-filter 的元素 */
  el: HTMLElement
  /** 宿主不在文档中时移除 */
  host: Element
  filter?: Filter
  /** 已应用的尺寸和圆角 */
  key?: string
  timer?: number
}

let mode: GlassMode | null = null
const surfaces = new Map<HTMLElement, Surface>()
const containers = new WeakMap<Document | ShadowRoot, SVGSVGElement>()
let nextId = 0

/** 圆角形状（corner-shape 的计算值）对应的超椭圆指数：squircle 即 superellipse(2)，指数 4；round 或不支持 corner-shape 时为 2 */
function cornerExponent(shape: string): number {
  if (shape === 'squircle') return 4
  const k = /superellipse\(([-\d.]+)\)/.exec(shape)
  return k ? 2 ** Math.max(0, Number(k[1])) : 2
}

function isChromium(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData
  return data ? data.brands.some((b) => b.brand === 'Chromium') : /\bChrome\/\d/.test(navigator.userAgent)
}

const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)')

/** 调试参数 ?glass=liquid|frosted|solid 可以强制指定模式 */
function currentMode(): GlassMode {
  const forced = new URLSearchParams(location.search).get('glass') as GlassMode | null
  if (forced && MODES.includes(forced)) return forced
  if (useAppearance.getState().reduceEffects || reducedTransparency.matches) return 'solid'
  return isChromium() ? 'liquid' : 'frosted'
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  parent.append(node)
  return node
}

function container(root: Document | ShadowRoot): SVGSVGElement {
  let svg = containers.get(root)
  if (svg?.isConnected) return svg
  svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
  // shadow root 中放在最前面，避开组件模板渲染的范围
  if (root instanceof ShadowRoot) root.prepend(svg)
  else document.body.append(svg)
  containers.set(root, svg)
  return svg
}

/**
 * 滤镜的输入是模糊后的背景：按位移图偏移，叠上着色，再叠上位移图 B 通道给出的白色高光。坐标以表面的左上角为原点。
 * 没有做 RGB 分别偏移的色散：要多偏移两次再按通道合成，预览中拖动立绘时每帧多花约 4 ms，而 1–2 像素的色边几乎看不出。
 */
function createFilter(root: Document | ShadowRoot): Filter {
  const id = `a2r-glass-${++nextId}`
  const element = svgNode('filter', { id, x: 0, y: 0, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, container(root))
  const image = svgNode('feImage', { x: 0, y: 0, preserveAspectRatio: 'none', result: 'map' }, element)
  const displacement = svgNode('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' }, element)
  svgNode('feFlood', { 'flood-color': TINT.color, 'flood-opacity': TINT.opacity, result: 'tint' }, element)
  svgNode('feComposite', { in: 'tint', in2: 'refracted', operator: 'over', result: 'glass' }, element)
  svgNode('feColorMatrix', { in: 'map', type: 'matrix', values: `0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 ${SPECULAR} 0 0`, result: 'spec' }, element)
  svgNode('feComposite', { in: 'spec', in2: 'glass', operator: 'over' }, element)
  return { id, element, image, displacement }
}

/** 表面的形状（CSS 像素）和位移图的像素密度 */
interface MapShape extends GlassShape {
  dpr: number
}

const shapeKey = (s: MapShape) => `${s.width}x${s.height}r${s.radius}n${s.exponent}@${s.dpr}`

/** 位移图的 PNG data URL，按形状缓存（同样大小的提示等可以共用） */
const cache = new Map<string, { url: string; scale: number }>()
let canvas: HTMLCanvasElement | null = null

/** 位移图按设备像素生成，高分屏上边缘高光才清晰；feDisplacementMap 的 scale 以 CSS 像素计 */
function mapFor(shape: MapShape) {
  const key = shapeKey(shape)
  let map = cache.get(key)
  if (map) {
    cache.delete(key)
  } else {
    const { dpr } = shape
    const optics = opticsFor(shape.width, shape.height)
    const width = Math.round(shape.width * dpr)
    const height = Math.round(shape.height * dpr)
    const { data, scale } = displacementMap(
      { width, height, radius: shape.radius * dpr, exponent: shape.exponent },
      { ...optics, bezel: optics.bezel * dpr, thickness: optics.thickness * dpr },
    )
    canvas ??= document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0)
    map = { url: canvas.toDataURL(), scale: scale / dpr }
    if (cache.size >= 48) cache.delete(cache.keys().next().value!)
  }
  cache.set(key, map)
  return map
}

function setRegion(f: Filter, width: number, height: number) {
  for (const node of [f.element, f.image]) {
    node.setAttribute('width', String(width))
    node.setAttribute('height', String(height))
  }
}

function render(s: Surface, shape: MapShape) {
  const map = mapFor(shape)
  s.filter ??= createFilter(s.el.getRootNode() as Document | ShadowRoot)
  setRegion(s.filter, shape.width, shape.height)
  s.filter.image.setAttribute('href', map.url)
  s.filter.displacement.setAttribute('scale', String(map.scale))
  s.el.style.setProperty('--glass-filter', `${BACKDROP} url(#${s.filter.id})`)
  s.el.style.setProperty('--glass-fill', 'transparent')
}

function update(s: Surface) {
  if (mode !== 'liquid') return
  const width = s.el.offsetWidth
  const height = s.el.offsetHeight
  // 隐藏的弹出层尺寸为 0，保留现有的滤镜
  if (width < 2 || height < 2) return
  const style = getComputedStyle(s.el)
  const shape: MapShape = {
    width,
    height,
    radius: parseFloat(style.borderTopLeftRadius) || 0,
    exponent: cornerExponent(style.getPropertyValue('corner-top-left-shape')),
    dpr: Math.min(2, window.devicePixelRatio || 1),
  }
  const key = shapeKey(shape)
  if (key === s.key) return
  s.key = key
  window.clearTimeout(s.timer)
  // 第一次或从其他模式切换回来时立即生成
  if (!s.filter || !s.el.style.getPropertyValue('--glass-filter')) return render(s, shape)
  setRegion(s.filter, width, height)
  s.timer = window.setTimeout(() => s.key === key && mode === 'liquid' && render(s, shape), SETTLE_MS)
}

function clear(s: Surface) {
  window.clearTimeout(s.timer)
  s.key = undefined
  s.el.style.removeProperty('--glass-filter')
  s.el.style.removeProperty('--glass-fill')
}

const resize = new ResizeObserver((entries) => {
  for (const e of entries) {
    const s = surfaces.get(e.target as HTMLElement)
    if (s) update(s)
  }
})

function add(el: HTMLElement, host: Element) {
  if (surfaces.has(el)) return
  surfaces.set(el, { el, host })
  resize.observe(el)
}

function drop(s: Surface) {
  clear(s)
  resize.unobserve(s.el)
  s.filter?.element.remove()
  surfaces.delete(s.el)
}

function track(el: Element) {
  const tag = el.localName
  const part = POPUPS[tag]
  if (part === undefined || part === null) return add(el as HTMLElement, el)
  // 等组件渲染出 shadow DOM
  void customElements
    .whenDefined(tag)
    .then(() => (el as Element & { updateComplete?: Promise<unknown> }).updateComplete)
    .then(() => {
      const target = el.shadowRoot?.querySelector<HTMLElement>(part)
      if (target && el.isConnected) add(target, el)
    })
}

function scan(node: Node) {
  if (!(node instanceof Element)) return
  if (node.matches(SELECTOR)) track(node)
  node.querySelectorAll(SELECTOR).forEach(track)
}

const mutations = new MutationObserver((records) => {
  let removed = false
  for (const r of records) {
    r.addedNodes.forEach(scan)
    removed ||= r.removedNodes.length > 0
  }
  if (removed) for (const s of surfaces.values()) if (!s.host.isConnected) drop(s)
})

function applyMode() {
  const next = currentMode()
  document.documentElement.dataset.glass = next
  if (next === mode) return
  mode = next
  for (const s of surfaces.values()) {
    clear(s)
    update(s)
  }
}

/** 当前的玻璃模式；startGlass 之前为 null */
export const glassMode = (): GlassMode | null => mode

/** 在渲染界面之前调用一次：标记玻璃模式，并开始跟踪页面中的玻璃表面。 */
export function startGlass(): void {
  applyMode()
  useAppearance.subscribe(applyMode)
  reducedTransparency.addEventListener('change', applyMode)
  mutations.observe(document.body, { childList: true, subtree: true })
  scan(document.body)
}
