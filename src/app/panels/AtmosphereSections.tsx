import { useCallback } from 'react'
import { linearToHex } from '@/algo/color'
import { DUST_FAR_RANGE, DUST_NEAR_RANGE, DUST_SEED_RANGE, FOG_START_RANGE, NOISE_SIZE_RANGE, type AtmosphereDoc, type AtmosphereSection } from '@/atmosphere/model'
import { currentAutoFogColor } from '@/atmosphere/service'
import { depthScaleFor } from '@/camera/depthScale'
import { t } from '@/i18n'
import { getDepthResult, useDepth } from '@/state/depth'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { SliderField } from '@/ui/SliderField'
import { useGestureChange } from '../useGestureChange'
import { Group, Hint, More, ToggleRow } from './Group'

const formatPercent = (v: number) => `${Math.round(v)}%`
const percent = { scale: 100, format: formatPercent }
const meters = { scale: 1, format: t.atmosphere.meters }

type NumberField<K extends AtmosphereSection> = { [F in keyof AtmosphereDoc[K]]: AtmosphereDoc[K][F] extends number ? F : never }[keyof AtmosphereDoc[K]] & string

/** 雾与尘埃的参数滑块：显示值 = 参数 × scale，拖动期间合并为一次撤销记录。 */
function AtmosphereSlider<K extends AtmosphereSection>(props: {
  section: K
  field: NumberField<K>
  label: string
  min?: number
  max?: number
  step?: number
  scale: number
  format: (v: number) => string
}) {
  const { section, field, scale } = props
  const value = useApp((s) => s.doc.atmosphere[section][field] as number)
  const onChange = useGestureChange(
    useCallback((v: number) => useApp.getState().updateAtmosphere(section, { [field]: v / scale } as Partial<AtmosphereDoc[K]>), [section, field, scale]),
  )
  return (
    <SliderField
      label={props.label}
      value={value * scale}
      min={props.min ?? 0}
      max={props.max ?? 100}
      step={props.step}
      format={props.format}
      onChange={onChange}
      testId={`atmosphere-${section}-${field}`}
    />
  )
}

/** 背景深度是否就绪、是否按地面校准、有没有启用的光源：两个分组共用的提示 */
function useSceneState() {
  const camera = useApp((s) => s.doc.camera)
  const background = useApp((s) => s.doc.background)
  const lights = useApp((s) => s.doc.lighting.lights)
  // 深度结果存在模块级缓存里，结果更新时 resultsVersion 变化会让组件重新读取
  useDepth((s) => s.resultsVersion)
  const depth = getDepthResult(background?.id)
  return {
    hasDepth: !!depth,
    approximate: !!background && !!depth && depthScaleFor(camera, background, depth).state !== 'ground',
    hasLights: lights.some((l) => l.enabled && l.intensity > 0),
  }
}

/** 雾（镜头步骤，docs/Plan.md §3.7 M8.8c） */
export function FogSection() {
  const fog = useApp((s) => s.doc.atmosphere.fog)
  const scene = useSceneState()
  const a = t.atmosphere
  const update = (u: Partial<AtmosphereDoc['fog']>) => useApp.getState().updateAtmosphere('fog', u)
  const { beginGesture, endGesture } = useApp.getState()
  const active = fog.density > 0
  const setAuto = (auto: boolean) => {
    if (auto) return update({ color: null })
    const color = currentAutoFogColor(useApp.getState().doc)
    update({ color: color ? linearToHex(color) : '#b3b3b3' })
  }
  return (
    <Group id="atmosphere.fog" title={a.fog} summary={active ? a.densitySummary(formatPercent(fog.density * 100)) : a.off} help={a.fogHint} testId="atmosphere-fog">
      {active && !scene.hasDepth && <Hint warn>{a.noDepth}</Hint>}
      {active && scene.approximate && <Hint>{a.approximate}</Hint>}
      <AtmosphereSlider section="fog" field="density" label={a.density} {...percent} />
      <AtmosphereSlider section="fog" field="start" label={a.start} min={FOG_START_RANGE[0]} max={FOG_START_RANGE[1]} step={0.5} {...meters} />
      <AtmosphereSlider section="fog" field="falloff" label={a.falloff} {...percent} />
      <AtmosphereSlider section="fog" field="light" label={a.light} {...percent} />
      {active && fog.light > 0 && !scene.hasLights && <Hint>{a.noLights}</Hint>}
      <ToggleRow label={a.autoColor} checked={fog.color === null} onChange={setAuto} testId="atmosphere-fog-auto-color" />
      {fog.color !== null && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-on-surface-variant">{a.color}</span>
          <ColorSwatch value={fog.color} label={a.color} onBegin={beginGesture} onChange={(color) => update({ color })} onEnd={endGesture} testId="atmosphere-fog-color" />
        </div>
      )}
      <More id="atmosphere.fog.more">
        <AtmosphereSlider section="fog" field="noise" label={a.noise} {...percent} />
        <AtmosphereSlider section="fog" field="noiseSize" label={a.noiseSize} min={NOISE_SIZE_RANGE[0]} max={NOISE_SIZE_RANGE[1]} step={0.5} {...meters} />
        <ToggleRow label={a.sky} checked={fog.sky} onChange={(sky) => update({ sky })} testId="atmosphere-fog-sky" />
      </More>
    </Group>
  )
}

/** 尘埃（镜头步骤，docs/Plan.md §3.7 M8.8c） */
export function DustSection() {
  const dust = useApp((s) => s.doc.atmosphere.dust)
  const scene = useSceneState()
  const a = t.atmosphere
  const active = dust.amount > 0
  const reseed = () => useApp.getState().updateAtmosphere('dust', { seed: dust.seed >= DUST_SEED_RANGE[1] ? DUST_SEED_RANGE[0] : dust.seed + 1 })
  return (
    <Group id="atmosphere.dust" title={a.dust} summary={active ? a.amountSummary(formatPercent(dust.amount * 100)) : a.off} help={a.dustHint} testId="atmosphere-dust">
      {active && !scene.hasDepth && <Hint warn>{a.noDepth}</Hint>}
      {active && scene.hasDepth && !scene.hasLights && <Hint warn>{a.noLights}</Hint>}
      {active && scene.approximate && <Hint>{a.approximate}</Hint>}
      <AtmosphereSlider section="dust" field="amount" label={a.amount} {...percent} />
      <AtmosphereSlider section="dust" field="size" label={a.size} {...percent} />
      <AtmosphereSlider section="dust" field="brightness" label={a.brightness} {...percent} />
      <More id="atmosphere.dust.more">
        <AtmosphereSlider section="dust" field="near" label={a.near} min={DUST_NEAR_RANGE[0]} max={DUST_NEAR_RANGE[1]} step={0.1} {...meters} />
        <AtmosphereSlider section="dust" field="far" label={a.far} min={DUST_FAR_RANGE[0]} max={DUST_FAR_RANGE[1]} step={1} {...meters} />
        <mdui-button variant="tonal" onClick={reseed} data-testid="atmosphere-dust-reseed">
          <mdui-icon-refresh--outlined slot="icon" />
          {a.reseed}
        </mdui-button>
      </More>
    </Group>
  )
}
