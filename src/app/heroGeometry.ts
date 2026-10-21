/**
 * 首页主视觉的几何数据：按维护者提供的图标原图（1254 × 1254 的 PNG）的构图重建的矢量图形，坐标沿用原图的像素坐标系。
 *
 * - 地球用正交投影，视线略高于赤道，纬线因此是向下弯的弧；经线随转角实时生成。
 * - 左侧五道金色圆环同心排列，进入地球后变细、汇入纬线，并沿纬线渐变成地球线条的颜色；最外一环的两端收成尖。
 * - 深色主题下地球为象牙白；浅色主题下金色加深，地球为深灰褐色。
 * - 金色线条按中心线采样，再向两侧偏移出轮廓并填充，这样线宽可以沿线变化，也能只画出前一段（生长动画）。
 */

const DEG = Math.PI / 180

export const VIEW_BOX = '79 248 1100 716'
export const GLOBE = { cx: 821, cy: 606, r: 344 }
/** 地球外轮廓与经纬线的线宽 */
export const OUTLINE_WIDTH = 11.5
export const LINE_WIDTH = 9

const TILT = 4 * DEG
const SIN_T = Math.sin(TILT)
const COS_T = Math.cos(TILT)

type Pt = [number, number]

/** 球面上纬度 φ、经度 λ 的点投影到画面（经度 0 正对观者） */
function project(phi: number, lam: number): Pt {
  const cp = Math.cos(phi)
  return [GLOBE.cx + GLOBE.r * cp * Math.sin(lam), GLOBE.cy - GLOBE.r * (Math.sin(phi) * COS_T - cp * Math.cos(lam) * SIN_T)]
}

/** 纬线沿经度增加方向的切线（单位向量，与纬度无关） */
function latTangent(lam: number): Pt {
  const dx = Math.cos(lam)
  const dy = -Math.sin(lam) * SIN_T
  const l = Math.hypot(dx, dy)
  return [dx / l, dy / l]
}

/** 纬线在正面可见的经度范围是 [−limit, limit]：视线偏高，北半球的纬线能看到大半圈，南半球的不到半圈 */
const latLimit = (phi: number) => Math.acos(Math.min(1, Math.max(-1, -Math.tan(phi) * (SIN_T / COS_T))))

const toPath = (pts: Pt[]) => 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')

function latPoints(phi: number, from: number, to: number): Pt[] {
  const n = Math.max(2, Math.ceil((to - from) / DEG))
  return Array.from({ length: n + 1 }, (_, i) => project(phi, from + ((to - from) * i) / n))
}

/** 纬线（纬度，度）与金色线汇入处的经度（度）；没有金色线汇入的纬线从左侧边缘画起 */
const LATITUDES: [number, number | null][] = [
  [72, null],
  [54, null],
  [36, -25],
  [18, -5],
  [0, -55],
  [-18, -5],
  [-36, -25],
  [-54, null],
  [-72, null],
]

export const latitudePaths = LATITUDES.map(([phi, merge]) => {
  const p = phi * DEG
  const limit = latLimit(p)
  return toPath(latPoints(p, merge === null ? -limit : merge * DEG, limit))
})

/** 经度 λ（弧度，任意值）处经线的可见部分；完全在背面时返回空串 */
export function meridianPath(lam: number): string {
  // 可见条件 z = sinφ·sinT + cosφ·cosλ·cosT > 0，即 φ > φmin
  const from = -Math.atan((Math.cos(lam) * COS_T) / SIN_T)
  const to = 90 * DEG
  const n = Math.max(2, Math.ceil((to - from) / (3 * DEG)))
  return toPath(Array.from({ length: n + 1 }, (_, i) => project(from + ((to - from) * i) / n, lam)))
}

export const MERIDIAN_COUNT = 12

// ---- 金色圆环 ----

const RING = { cx: 437, cy: 606 }
const STEP = 4

interface Dense {
  x: number
  y: number
  w: number
}

/** 一条金色线的半边：从起点沿中心线到末端，按弧长等距采样 */
export interface Half {
  x: Float64Array
  y: Float64Array
  /** 单位法线 */
  nx: Float64Array
  ny: Float64Array
  w: Float64Array
  /** 累计弧长 */
  s: Float64Array
  length: number
  /** 中心线路径，用于沿线流动的高光 */
  path: string
}

export type HeroTheme = 'light' | 'dark'

export interface Strand {
  halves: Half[]
  /** 渐变：从 x0 到 x1，stops 的 offset 为 0–1，两种主题的 offset 相同 */
  gradient: { x0: number; x1: number; stops: Record<HeroTheme, [number, string][]> }
  /** 线宽最大值，高光宽度据此确定 */
  width: number
}

const smooth = (u: number) => u * u * (3 - 2 * u)

function arc(r: number, from: number, to: number, w: number, out: Dense[]) {
  const n = Math.ceil(Math.abs(to - from) / DEG)
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n
    out.push({ x: RING.cx + r * Math.cos(a), y: RING.cy - r * Math.sin(a), w })
  }
}

/** 三次贝塞尔：起点 p0 沿方向 d0 出发，到 p3 时沿方向 d1；线宽从 w0 平滑过渡到 w1 */
function tail(p0: Pt, d0: Pt, p3: Pt, d1: Pt, k0: number, k1: number, w0: number, w1: number, out: Dense[]) {
  const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1])
  const p1: Pt = [p0[0] + d0[0] * chord * k0, p0[1] + d0[1] * chord * k0]
  const p2: Pt = [p3[0] - d1[0] * chord * k1, p3[1] - d1[1] * chord * k1]
  const n = 160
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    out.push({ x: a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], y: a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], w: w0 + (w1 - w0) * smooth(t) })
  }
}

function alongLatitude(phi: number, from: number, to: number, w: number, out: Dense[]) {
  for (const [x, y] of latPoints(phi, from, to).slice(1)) out.push({ x, y, w })
}

function resample(dense: Dense[]): Half {
  const acc = [0]
  for (let i = 1; i < dense.length; i++) acc.push(acc[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y))
  const length = acc[acc.length - 1]
  const n = Math.ceil(length / STEP) + 1
  const h = { x: new Float64Array(n), y: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n), w: new Float64Array(n), s: new Float64Array(n), length, path: '' }
  let j = 0
  for (let i = 0; i < n; i++) {
    const s = (length * i) / (n - 1)
    while (j < dense.length - 2 && acc[j + 1] < s) j++
    const f = acc[j + 1] > acc[j] ? (s - acc[j]) / (acc[j + 1] - acc[j]) : 0
    const a = dense[j]
    const b = dense[j + 1]
    h.x[i] = a.x + (b.x - a.x) * f
    h.y[i] = a.y + (b.y - a.y) * f
    h.w[i] = a.w + (b.w - a.w) * f
    h.s[i] = s
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    const tx = h.x[b] - h.x[a]
    const ty = h.y[b] - h.y[a]
    const l = Math.hypot(tx, ty) || 1
    h.nx[i] = -ty / l
    h.ny[i] = tx / l
  }
  h.path = toPath(Array.from({ length: n }, (_, i) => [h.x[i], h.y[i]] as Pt))
  return h
}

/** 圆环与地球外轮廓的交点角度（上半边，弧度） */
function crossing(r: number) {
  const d = GLOBE.cx - RING.cx
  return Math.acos((d * d + r * r - GLOBE.r * GLOBE.r) / (2 * d * r))
}

/** 地球线条的颜色 */
export const HERO_LINE: Record<HeroTheme, string> = { dark: '#f2ede4', light: '#5a5249' }
/** 金色汇入地球前的过渡色 */
const PALE: Record<HeroTheme, string> = { dark: '#f6dfa8', light: '#a07c43' }

/** 浅色底上的金色：向深古铜色混合 */
function deepen(hex: string): string {
  const k = 0.45
  const bronze = [138, 90, 16]
  return `#${[1, 3, 5].map((i, c) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + bronze[c] * k).toString(16).padStart(2, '0')).join('')}`
}

function gradient(x0: number, base: string, light: string, xCross: number, fade0: number, fade1: number): Strand['gradient'] {
  const at = (x: number) => (x - x0) / (fade1 - x0)
  const stops = (theme: HeroTheme, base: string, light: string): [number, string][] => [
    [0, base],
    [at(xCross), light],
    [at(fade0), PALE[theme]],
    [1, HERO_LINE[theme]],
  ]
  return { x0, x1: fade1, stops: { dark: stops('dark', base, light), light: stops('light', deepen(base), deepen(light)) } }
}

/** 圆环：半径、线宽、汇入的纬度（度，null 表示两端收尖）、汇入处经度、金色段终点经度、颜色与渐隐区间 */
const RINGS: { r: number; w: number; lat: number | null; merge: number; end: number; base: string; light: string; fade: [number, number] }[] = [
  { r: 117, w: 18, lat: 0, merge: 15, end: 36, base: '#f2cc7c', light: '#f7d993', fade: [860, 1000] },
  { r: 190, w: 22, lat: 18, merge: -5, end: 25, base: '#ecbd65', light: '#f4cf82', fade: [780, 930] },
  { r: 266, w: 23, lat: 36, merge: -25, end: 10, base: '#e8b257', light: '#f1c574', fade: [700, 830] },
  { r: 338, w: 23, lat: null, merge: 0, end: 0, base: '#e5aa4c', light: '#eebd68', fade: [660, 900] },
]

function ringStrand({ r, w, lat, merge, end, base, light, fade }: (typeof RINGS)[number]): Strand {
  const tc = crossing(r)
  const halves = [1, -1].map((side) => {
    const dense: Dense[] = []
    // 从最左端出发，沿圆弧走到与地球轮廓的交点：上半边 θ 从 180° 减到 θc，下半边从 180° 增到 360° − θc。
    // 两个半边在最左端各多画 3px 互相重叠，否则拼接处会因抗锯齿露出一条细缝
    const overlap = 3 / r
    arc(r, Math.PI + side * overlap, side > 0 ? tc : 2 * Math.PI - tc, w, dense)
    const p0: Pt = [RING.cx + r * Math.cos(tc), RING.cy - side * r * Math.sin(tc)]
    const d0: Pt = [Math.sin(tc), side * Math.cos(tc)]
    if (lat === null) {
      // 两端收成尖，末端转为接近水平
      tail(p0, d0, [p0[0] + 74, p0[1] + side * 12], [1, side * 0.06], 0.4, 0.45, w, 0, dense)
    } else {
      const phi = side * lat * DEG
      const lam = merge * DEG
      tail(p0, d0, project(phi, lam), latTangent(lam), side > 0 ? 0.4 : 0.25, 0.45, w, LINE_WIDTH, dense)
      alongLatitude(phi, lam, end * DEG, LINE_WIDTH, dense)
    }
    return resample(dense)
  })
  return { halves, gradient: gradient(RING.cx - r - w / 2, base, light, RING.cx + r * Math.cos(tc), fade[0], fade[1]), width: w }
}

/** 中心的小圆：从右上方的接口顺时针画满一圈，再沿切线离开、汇入赤道 */
function coreStrand(): Strand {
  const r = 51
  const w = 12
  const tj = 40 * DEG
  const dense: Dense[] = []
  arc(r, tj + 4 * DEG, tj - 2 * Math.PI, w, dense)
  const p0: Pt = [RING.cx + r * Math.cos(tj), RING.cy - r * Math.sin(tj)]
  const lam = -55 * DEG
  tail(p0, [Math.sin(tj), Math.cos(tj)], project(0, lam), latTangent(lam), 0.4, 0.45, w, LINE_WIDTH, dense)
  alongLatitude(0, lam, -15 * DEG, LINE_WIDTH, dense)
  return { halves: [resample(dense)], gradient: gradient(RING.cx - r - w / 2, '#f6d792', '#f9e2a8', p0[0], 540, 690), width: w }
}

/** 由内向外：小圆、四道圆环 */
export const STRANDS: Strand[] = [coreStrand(), ...RINGS.map(ringStrand)]

const LEAD = 60

/**
 * 半边从起点画到弧长 upto 处的填充轮廓（两侧偏移线连成的闭合路径）。未画完时前端在 LEAD 长度内收尖，像笔尖向前生长。
 * 每个半边单独成为一个元素：两个半边在最左端方向相反，放在同一条路径里重叠处会按环绕规则互相抵消。
 */
export function halfPath(h: Half, upto = Infinity): string {
  if (upto <= 0) return ''
  const done = upto >= h.length
  const left: string[] = []
  const right: string[] = []
  const push = (x: number, y: number, nx: number, ny: number, w: number) => {
    left.push(`${(x + nx * w).toFixed(1)} ${(y + ny * w).toFixed(1)}`)
    right.push(`${(x - nx * w).toFixed(1)} ${(y - ny * w).toFixed(1)}`)
  }
  const lead = (s: number) => (done ? 1 : Math.sqrt(Math.min(1, (upto - s) / LEAD)))
  let i = 0
  for (; i < h.s.length && h.s[i] <= upto; i++) push(h.x[i], h.y[i], h.nx[i], h.ny[i], (h.w[i] / 2) * lead(h.s[i]))
  if (!done && i > 0 && i < h.s.length) {
    const f = (upto - h.s[i - 1]) / (h.s[i] - h.s[i - 1])
    const lerp = (a: Float64Array) => a[i - 1] + (a[i] - a[i - 1]) * f
    push(lerp(h.x), lerp(h.y), lerp(h.nx), lerp(h.ny), 0)
  }
  return 'M' + left.join('L') + 'L' + right.reverse().join('L') + 'Z'
}
