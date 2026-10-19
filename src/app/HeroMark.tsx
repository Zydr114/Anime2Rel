import { memo, useEffect, useRef, useState } from 'react'
import { GLOBE, LINE_WIDTH, MERIDIAN_COUNT, OUTLINE_WIDTH, STRANDS, VIEW_BOX, halfPath, latitudePaths, meridianPath } from './heroGeometry'

const DEG = Math.PI / 180
const SPACING = (2 * Math.PI) / MERIDIAN_COUNT
/** 静止画面（减少动态效果时）的经线转角，与原图一致 */
const REST = 2.4 * DEG
/** 自转：每 6 秒转过一个经线间隔 */
const SPIN = SPACING / 6

// 入场：小圆先画，圆环由内向外依次生长（秒）
const GROW_START = 0.35
const GROW_STAGGER = 0.14
const growDuration = (i: number) => 1 + 0.2 * i
/** 同一条线的两个半边以相同速度生长，按较长的一边计时 */
const longest = STRANDS.map((s) => Math.max(...s.halves.map((h) => h.length)))

// 高光：入场后每隔一段时间从左端出发，沿线流进地球，由内向外依次出发
const GLINT_START = 3.2
const GLINT_PERIOD = 7
const GLINT_STAGGER = 0.22
const GLINT_SPEED = 520
const GLINT_LENGTH = 120
/** 划线移出路径两端时再多留的距离，免得圆头端点在端点处露出一个点 */
const GLINT_MARGIN = 30

const easeOut = (u: number) => 1 - (1 - u) ** 3
const easeInOut = (u: number) => (1 - Math.cos(Math.PI * u)) / 2
const clamp01 = (u: number) => Math.min(1, Math.max(0, u))

const halves = STRANDS.flatMap((s, i) => s.halves.map((h) => ({ strand: i, half: h, width: s.width })))

/** 首页主视觉：金色圆环流入缓缓自转的地球（图标原图的矢量重建）。入场时线条依次画出，之后地球自转、高光沿圆环流入地球；系统要求减少动态效果时显示静止画面。 */
export const HeroMark = memo(function HeroMark({ className }: { className?: string }) {
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const meridianEls = useRef<(SVGPathElement | null)[]>([])
  const goldEls = useRef<(SVGPathElement | null)[]>([])
  const glintEls = useRef<(SVGPathElement | null)[]>([])

  useEffect(() => {
    if (still) return
    const done = halves.map(() => false)
    const start = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const t = (now - start) / 1000
      const angle = REST + SPIN * t
      meridianEls.current.forEach((el, i) => el?.setAttribute('d', meridianPath(angle + i * SPACING)))
      halves.forEach(({ strand, half }, i) => {
        if (done[i]) return
        const u = clamp01((t - GROW_START - strand * GROW_STAGGER) / growDuration(strand))
        goldEls.current[i]?.setAttribute('d', halfPath(half, u < 1 ? longest[strand] * easeOut(u) : Infinity))
        done[i] = u >= 1
      })
      halves.forEach(({ strand, half }, i) => {
        const el = glintEls.current[i]
        if (!el) return
        const distance = half.length + GLINT_LENGTH + 2 * GLINT_MARGIN
        const phase = t - GLINT_START - strand * GLINT_STAGGER
        const u = phase < 0 ? 0 : (phase % GLINT_PERIOD) / (distance / GLINT_SPEED)
        // 划线从路径起点之前滑到终点之后
        el.style.strokeDashoffset = String(GLINT_LENGTH + GLINT_MARGIN - distance * easeInOut(clamp01(u)))
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [still])

  return (
    <svg viewBox={VIEW_BOX} className={className} aria-hidden="true" data-testid="hero-mark">
      <defs>
        {STRANDS.map(({ gradient }, i) => (
          <linearGradient key={i} id={`hero-gold-${i}`} gradientUnits="userSpaceOnUse" x1={gradient.x0} x2={gradient.x1} y1={0} y2={0}>
            {gradient.stops.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        ))}
        <filter id="hero-glint-blur" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        {/* 高光进入地球后随金色一起淡去 */}
        {STRANDS.map(({ gradient }, i) => (
          <linearGradient key={i} id={`hero-glint-${i}`} gradientUnits="userSpaceOnUse" x1={gradient.x0} x2={gradient.x1} y1={0} y2={0}>
            <stop offset={0} stopColor="#fffaf0" stopOpacity={0.95} />
            <stop offset={gradient.stops[2][0]} stopColor="#fffaf0" stopOpacity={0.7} />
            <stop offset={1} stopColor="#fffaf0" stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>

      <g fill="none" stroke="var(--color-ivory)">
        <circle
          cx={GLOBE.cx}
          cy={GLOBE.cy}
          r={GLOBE.r}
          strokeWidth={OUTLINE_WIDTH}
          pathLength={1}
          transform={`rotate(180 ${GLOBE.cx} ${GLOBE.cy})`}
          className="animate-hero-draw [stroke-dasharray:1_1] motion-reduce:animate-none"
        />
        <g strokeWidth={LINE_WIDTH}>
          {latitudePaths.map((d, i) => (
            <path
              key={i}
              d={d}
              pathLength={1}
              className="animate-hero-draw [stroke-dasharray:1_1] motion-reduce:animate-none"
              style={{ animationDelay: `${0.25 + Math.abs(i - (latitudePaths.length - 1) / 2) * 0.07}s` }}
            />
          ))}
        </g>
        <g strokeWidth={LINE_WIDTH} strokeLinecap="round" className="animate-hero-fade [animation-delay:0.5s] motion-reduce:animate-none">
          {Array.from({ length: MERIDIAN_COUNT }, (_, i) => (
            <path
              key={i}
              ref={(el) => {
                meridianEls.current[i] = el
              }}
              d={meridianPath(REST + i * SPACING)}
            />
          ))}
        </g>
      </g>

      {halves.map(({ strand, half }, i) => (
        <path
          key={i}
          ref={(el) => {
            goldEls.current[i] = el
          }}
          d={still ? halfPath(half) : ''}
          fill={`url(#hero-gold-${strand})`}
        />
      ))}

      {!still && (
        <g fill="none" strokeLinecap="round" filter="url(#hero-glint-blur)" className="mix-blend-plus-lighter">
          {halves.map(({ strand, half, width }, i) => (
            <path
              key={i}
              ref={(el) => {
                glintEls.current[i] = el
              }}
              d={half.path}
              stroke={`url(#hero-glint-${strand})`}
              strokeWidth={width * 0.7}
              strokeDasharray={`${GLINT_LENGTH} ${half.length + 2 * (GLINT_LENGTH + GLINT_MARGIN)}`}
              strokeDashoffset={GLINT_LENGTH + GLINT_MARGIN}
              opacity={0.8}
            />
          ))}
        </g>
      )}
    </svg>
  )
})
