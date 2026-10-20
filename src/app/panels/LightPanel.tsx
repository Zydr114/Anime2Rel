import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import type { Switch } from 'mdui/components/switch.js'
import { toAngles, fromAngles } from '@/algo/camera'
import { hexToLinear, linearToHex, normalizeColor } from '@/algo/color'
import { kelvinToRgb } from '@/algo/kelvin'
import type { Vec3 } from '@/algo/sh'
import type { AnalysisResult } from '@/analysis/protocol'
import { reanalyze } from '@/analysis/service'
import { t } from '@/i18n'
import { MAX_LIGHTS, newDirectionalLight, type Light, type LightType } from '@/lighting/model'
import { computeBallPreview } from '@/lighting/preview'
import { getDepthResult, useDepth } from '@/state/depth'
import { useCharacterInfo } from '@/state/fusion'
import { useHints } from '@/state/hints'
import { useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { cn } from '@/ui/lib/cn'
import { SliderField } from '@/ui/SliderField'
import { useDomEvent } from '@/ui/useDomEvent'
import { lightName } from '../lightName'
import { notify } from '../notify'
import { useGestureChange } from '../useGestureChange'
import { DirectionSphere } from './DirectionSphere'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatDegrees = (v: number) => `${Math.round(v)}°`
const formatIntensity = (v: number) => v.toFixed(2)
const formatMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)
const percent = (v: number) => `${Math.round(v * 100)}%`
/** 自动识别的光源在列表中只显示置信度的高低，具体数值在分析详情中 */
const confidenceLevel = (c: number) => t.light.confidence[c >= 0.6 ? 'high' : c >= 0.3 ? 'medium' : 'low']
const INTRO_HINT = 'light-intro'

export function LightPanel() {
  const background = useApp((s) => s.doc.background)
  if (!background) return <p className="px-1 text-sm text-on-surface-variant">{t.light.noBackground}</p>
  return (
    <div className="flex flex-col gap-4">
      <IntroSection />
      <AnalysisSection assetId={background.id} />
      <LightsSection />
      <SphereSection />
      <SelectedSection />
      <PreviewSection />
    </div>
  )
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3 text-sm" data-testid={testId}>
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  )
}

function LightIcon({ type, className }: { type: LightType; className?: string }) {
  return type === 'directional' ? <mdui-icon-wb-sunny--outlined className={className} /> : <mdui-icon-lightbulb--outlined className={className} />
}

/** 初次使用的说明：两种光源的区别和光照方向球的用法，关闭后不再显示 */
function IntroSection() {
  const dismissed = useHints((s) => s.dismissed.includes(INTRO_HINT))
  if (dismissed) return null
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-primary/10 p-3 text-xs leading-5" data-testid="light-intro">
      <h3 className="text-sm font-medium">{t.light.intro.title}</h3>
      {(['directional', 'point'] as const).map((type) => (
        <div key={type} className="flex gap-2">
          <LightIcon type={type} className="size-5 shrink-0 text-primary" />
          <div>
            <span className="font-medium">{t.light.types[type]}</span>
            <span className="text-on-surface-variant">：{t.light.typeHints[type]}</span>
          </div>
        </div>
      ))}
      <p className="text-on-surface-variant">{t.light.intro.sphere}</p>
      <p className="text-on-surface-variant">{t.light.intro.ball}</p>
      <mdui-button variant="text" className="self-end" onClick={() => useHints.getState().dismiss(INTRO_HINT)} data-testid="light-intro-dismiss">
        {t.light.intro.dismiss}
      </mdui-button>
    </section>
  )
}

function AnalysisSection({ assetId }: { assetId: string }) {
  const status = useLighting((s) => s.analyses[assetId])
  return (
    <Section title={t.light.analysis} testId="light-analysis">
      <div data-state={status?.state ?? 'waiting'} data-testid="light-analysis-state">
        {!status && <div className="text-on-surface-variant">{t.light.waitingDepth}</div>}
        {status?.state === 'running' && (
          <div className="flex flex-col gap-2">
            <div className="text-on-surface-variant">{t.light.analyzing}</div>
            <mdui-linear-progress />
          </div>
        )}
        {status?.state === 'error' && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-error">
              <mdui-icon-error--outlined className="size-5" />
              <span>{t.light.failed}</span>
            </div>
            <div className="text-xs leading-5 break-words text-on-surface-variant">{status.message}</div>
          </div>
        )}
        {status?.state === 'done' && <AnalysisReport result={status.result} />}
      </div>
      <mdui-button variant="text" onClick={reanalyze} disabled={status?.state === 'running' || undefined} data-testid="light-reanalyze">
        <mdui-icon-refresh--outlined slot="icon" />
        {t.light.reanalyze}
      </mdui-button>
    </Section>
  )
}

function AnalysisReport({ result }: { result: AnalysisResult }) {
  const lights = useApp((s) => s.doc.lighting.lights)
  const r = result.report
  const sh = r.sh && toAngles(r.sh.direction)
  return (
    <div className="flex flex-col gap-2">
      <div className="text-on-surface-variant">{t.light.analyzed(formatMs(result.ms))}</div>
      {result.diffuse && (
        <div className="rounded-xl bg-primary/15 px-3 py-2 text-xs leading-5" data-testid="light-diffuse">
          <div className="font-medium text-primary">{t.light.diffuse}</div>
          <div className="text-on-surface-variant">{t.light.diffuseHint}</div>
        </div>
      )}
      <details className="text-xs leading-5 text-on-surface-variant">
        <summary className="cursor-pointer select-none">{t.light.details}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          <li>{t.light.report.visible(r.visible.count, r.visible.sky)}</li>
          <li>{r.sh && sh ? t.light.report.sh(formatDegrees(sh.azimuth * DEG), formatDegrees(sh.elevation * DEG), percent(r.sh.confidence)) : t.light.report.noSh}</li>
          <li>{r.contour ? t.light.report.contour(formatDegrees(r.contour.angle * DEG), percent(r.contour.confidence)) : t.light.report.noContour}</li>
          <li>{r.skyGradient ? t.light.report.sky(formatDegrees(r.skyGradient.angle * DEG), percent(r.skyGradient.confidence)) : t.light.report.noSky}</li>
          <li>{t.light.report.stats(percent(r.skyFraction), r.skyVariation.toFixed(2), r.contrast.toFixed(1))}</li>
          <li>{t.light.angleHint}</li>
          {lights.map(
            (l) => l.origin && <li key={l.id}>{t.light.report.light(lightName(lights, l), l.origin.sources.map((s) => t.light.sources[s]).join('、'), percent(l.origin.confidence))}</li>,
          )}
        </ul>
      </details>
    </div>
  )
}

function LightsSection() {
  const lights = useApp((s) => s.doc.lighting.lights)
  const selected = useLighting((s) => s.selected)
  const tool = useLighting((s) => s.tool)
  const full = lights.length >= MAX_LIGHTS

  const addDirectional = () => {
    const light = newDirectionalLight()
    if (!useApp.getState().addLight(light)) return notify(t.light.full(MAX_LIGHTS))
    useLighting.getState().select(light.id)
  }

  return (
    <Section title={t.light.lights} testId="light-list">
      {lights.length === 0 && <p className="text-xs leading-5 text-on-surface-variant">{t.light.empty}</p>}
      <ul className="flex flex-col gap-1">
        {lights.map((l) => (
          <LightRow key={l.id} light={l} name={lightName(lights, l)} active={l.id === selected} />
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <mdui-button variant="tonal" onClick={addDirectional} disabled={full || undefined} data-testid="light-add-directional">
          <mdui-icon-add--outlined slot="icon" />
          {t.light.addDirectional}
        </mdui-button>
        <mdui-button
          variant={tool === 'add' ? 'filled' : 'outlined'}
          onClick={() => useLighting.getState().setTool(tool === 'add' ? 'select' : 'add')}
          disabled={full || undefined}
          data-testid="light-add-canvas"
        >
          <mdui-icon-ads-click--outlined slot="icon" />
          {t.light.addOnCanvas}
        </mdui-button>
      </div>
      {full && <p className="text-xs text-on-surface-variant">{t.light.full(MAX_LIGHTS)}</p>}
      {tool === 'add' && <p className="text-xs leading-5 text-primary">{t.light.addHint}</p>}
    </Section>
  )
}

function LightRow({ light, name, active }: { light: Light; name: string; active: boolean }) {
  const switchRef = useRef<Switch>(null)
  useDomEvent(switchRef, 'change', (e, el) => {
    if (e.target === el) useApp.getState().updateLight(light.id, { enabled: el.checked })
  })
  const color = linearToHex(light.color)
  const origin = light.origin ? `${t.light.auto} · ${confidenceLevel(light.origin.confidence)}` : t.light.manual

  return (
    <li
      className={cn('flex cursor-pointer items-center gap-2 rounded-xl py-1 pr-1 pl-2 transition-colors hover:bg-white/5', active && 'bg-white/10 hover:bg-white/10')}
      onClick={() => useLighting.getState().select(light.id)}
      data-testid={`light-row-${light.id}`}
      data-type={light.type}
      data-sources={light.origin?.sources.join(',')}
      data-enabled={light.enabled}
    >
      <span className={cn('flex size-5 shrink-0', !light.enabled && 'opacity-40')} style={{ color }}>
        <LightIcon type={light.type} className="size-5" />
      </span>
      <div className={cn('min-w-0 flex-1', !light.enabled && 'opacity-60')}>
        <div className="truncate">{name}</div>
        <div className="truncate text-xs text-on-surface-variant">{origin}</div>
      </div>
      <mdui-switch ref={switchRef} checked={light.enabled} onClick={(e) => e.stopPropagation()} data-testid={`light-enabled-${light.id}`} />
      <mdui-button-icon
        onClick={(e) => {
          e.stopPropagation()
          useApp.getState().removeLight(light.id)
        }}
        data-testid={`light-remove-${light.id}`}
      >
        <mdui-icon-delete--outlined />
      </mdui-button-icon>
    </li>
  )
}

/** 灰球预览的光照（面板里的方向球与画布上的灰球一致） */
function useBallPreview() {
  const doc = useApp((s) => s.doc)
  const analysis = useLighting((s) => s.analyses[doc.background?.id ?? ''])
  // 深度结果存在模块级缓存里，结果更新时 resultsVersion 变化会让选择器重新读取
  const depth = useDepth(() => getDepthResult(doc.background?.id))
  const bbox = useCharacterInfo(doc)?.bbox
  return useMemo(() => computeBallPreview(doc, analysis?.state === 'done' ? analysis.result : undefined, depth, bbox), [doc, analysis, depth, bbox])
}

function SphereSection() {
  const lights = useApp((s) => s.doc.lighting.lights)
  const selected = useLighting((s) => s.selected)
  const preview = useBallPreview()

  const onDirection = useCallback((id: string, direction: Vec3, phase: 'start' | 'move' | 'end') => {
    const s = useApp.getState()
    if (phase === 'start') s.beginGesture()
    else if (phase === 'move') s.updateLight(id, { direction })
    else s.endGesture()
  }, [])

  return (
    <Section title={t.light.sphere}>
      <DirectionSphere lights={lights} preview={preview} selected={selected} onSelect={useLighting.getState().select} onDirection={onDirection} />
      <p className="text-xs leading-5 text-on-surface-variant">{t.light.sphereHint}</p>
    </Section>
  )
}

function SelectedSection() {
  const selected = useLighting((s) => s.selected)
  const light = useApp((s) => s.doc.lighting.lights.find((l) => l.id === selected))
  const name = useApp((s) => (light ? lightName(s.doc.lighting.lights, light) : ''))
  if (!light) return null
  return (
    <Section title={`${t.light.selected}：${name}`} testId="light-selected">
      <LightEditor key={light.id} light={light} />
    </Section>
  )
}

function LightEditor({ light }: { light: Light }) {
  const tool = useLighting((s) => s.tool)
  const id = light.id
  const update = useCallback((u: Partial<Light>) => useApp.getState().updateLight(id, u), [id])
  const { azimuth, elevation } = toAngles(light.direction)
  const back = light.direction[2] < 0

  const onAzimuth = useGestureChange(useCallback((v: number) => update({ direction: fromAngles(v * RAD, toAngles(currentDirection(id)).elevation) }), [id, update]))
  // 仰角到达 ±90° 时方位角无法从方向中恢复，记住最近一次有效的方位角
  const azimuthRef = useRef(azimuth)
  const onElevation = useGestureChange(
    useCallback(
      (v: number) => {
        const d = currentDirection(id)
        if (Math.hypot(d[0], d[2]) > 1e-4) azimuthRef.current = Math.atan2(d[0], d[2])
        update({ direction: fromAngles(azimuthRef.current, v * RAD) })
      },
      [id, update],
    ),
  )
  const onDepth = useGestureChange(useCallback((v: number) => update({ position: { ...currentLight(id)!.position, depth: v / 100 } }), [id, update]))
  const onKelvin = useGestureChange(useCallback((v: number) => update({ kelvin: v, color: kelvinToRgb(v) }), [update]))
  const onIntensity = useGestureChange(useCallback((v: number) => update({ intensity: v }), [update]))
  const onSoftness = useGestureChange(useCallback((v: number) => update({ softness: v / 100 }), [update]))

  const backRef = useRef<Switch>(null)
  useDomEvent(backRef, 'change', (e, el) => {
    if (e.target !== el) return
    const d = currentDirection(id)
    if (el.checked !== d[2] < 0) update({ direction: [d[0], d[1], -d[2]] })
  })

  // 取色器只决定色相和饱和度：颜色按最大分量归一化，亮度由强度控制
  const onColor = (hex: string) => {
    const c = hexToLinear(hex)
    if (c) update({ color: normalizeColor(c), kelvin: null })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-on-surface-variant" data-testid="light-type-hint">
        {t.light.typeHints[light.type]}
      </p>
      {light.type === 'directional' ? (
        <>
          <SliderField label={t.light.azimuth} value={azimuth * DEG} min={-180} max={180} format={formatDegrees} onChange={onAzimuth} testId="light-azimuth" />
          <SliderField label={t.light.elevation} value={elevation * DEG} min={-90} max={90} format={formatDegrees} onChange={onElevation} testId="light-elevation" />
          <div className="flex items-center justify-between">
            <span>{t.light.backlight}</span>
            <mdui-switch ref={backRef} checked={back} data-testid="light-backlight" />
          </div>
        </>
      ) : (
        <>
          <SliderField label={t.light.depth} value={light.position.depth * 100} min={0} max={100} format={formatPercent} onChange={onDepth} testId="light-depth" />
          <p className="text-xs leading-5 text-on-surface-variant">{t.light.depthHint}</p>
        </>
      )}

      <div className="flex items-center gap-2">
        <span className="flex-1 text-on-surface-variant">{t.light.color}</span>
        <ColorSwatch value={linearToHex(light.color)} label={t.light.color} onBegin={useApp.getState().beginGesture} onChange={onColor} onEnd={useApp.getState().endGesture} testId="light-color" />
        <mdui-button-icon
          selectable
          selected={tool === 'pick' || undefined}
          onClick={() => useLighting.getState().setTool(tool === 'pick' ? 'select' : 'pick')}
          aria-label={t.light.pick}
          data-testid="light-pick"
        >
          <mdui-icon-colorize--outlined />
        </mdui-button-icon>
      </div>
      {tool === 'pick' && <p className="text-xs leading-5 text-primary">{t.light.pickHint}</p>}
      <SliderField
        label={t.light.kelvin}
        value={light.kelvin ?? 6500}
        min={1700}
        max={12000}
        step={50}
        format={(v) => (light.kelvin === null ? t.light.customColor : `${Math.round(v)} K`)}
        onChange={onKelvin}
        testId="light-kelvin"
      />
      <SliderField label={t.light.intensity} value={light.intensity} min={0} max={3} step={0.01} format={formatIntensity} onChange={onIntensity} testId="light-intensity" />
      <SliderField label={t.light.softness} value={light.softness * 100} min={0} max={100} format={formatPercent} onChange={onSoftness} testId="light-softness" />
    </div>
  )
}

function currentLight(id: string): Light | undefined {
  return useApp.getState().doc.lighting.lights.find((l) => l.id === id)
}

function currentDirection(id: string): Vec3 {
  return currentLight(id)?.direction ?? [0, 0, 1]
}

function PreviewSection() {
  const showBall = useLighting((s) => s.showBall)
  const ambient = useApp((s) => s.doc.lighting.ambient)
  const ballRef = useRef<Switch>(null)
  useDomEvent(ballRef, 'change', (e, el) => {
    if (e.target === el) useLighting.getState().setShowBall(el.checked)
  })
  const onAmbient = useGestureChange(useCallback((v: number) => useApp.getState().setLighting({ ambient: v / 100 }), []))

  return (
    <Section title={t.light.preview}>
      <div className="flex items-center justify-between">
        <span>{t.light.ball}</span>
        <mdui-switch ref={ballRef} checked={showBall} data-testid="light-ball" />
      </div>
      <p className="text-xs leading-5 text-on-surface-variant">{t.light.ballHint}</p>
      <SliderField label={t.light.ambient} value={ambient * 100} min={0} max={200} format={formatPercent} onChange={onAmbient} testId="light-ambient" />
    </Section>
  )
}
