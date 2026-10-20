import { useCallback } from 'react'
import { raysLight, TONE_MAPPINGS, type PostDoc, type PostSection } from '@/grade/post'
import { t } from '@/i18n'
import { getDepthResult, useDepth } from '@/state/depth'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { lightName } from '../lightName'
import { useGestureChange } from '../useGestureChange'
import { FlareSection } from './FlareSection'
import { Hint, Section, ToggleRow } from './FusionSections'

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const AUTO = 'auto'

type NumberField<K extends PostSection> = { [F in keyof PostDoc[K]]: PostDoc[K][F] extends number ? F : never }[keyof PostDoc[K]] & string

/** 后期参数滑块：显示值 = 参数 × 100，拖动期间合并为一次撤销记录。 */
function PostSlider<K extends PostSection>({ section, field, label, min = 0, format = formatPercent }: { section: K; field: NumberField<K>; label: string; min?: number; format?: (v: number) => string }) {
  const value = useApp((s) => s.doc.post[section][field] as number)
  const onChange = useGestureChange(useCallback((v: number) => useApp.getState().updatePost(section, { [field]: v / 100 } as Partial<PostDoc[K]>), [section, field]))
  return <SliderField label={label} value={value * 100} min={min} max={100} format={format} onChange={onChange} testId={`post-${section}-${field}`} />
}

export function EffectsPanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  if (!hasBackground) return <p className="px-1 text-sm text-on-surface-variant">{t.effects.noBackground}</p>
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t.effects.hint}</Hint>
      <Section title={t.effects.bloom} testId="post-bloom">
        <PostSlider section="bloom" field="intensity" label={t.effects.intensity} />
        <PostSlider section="bloom" field="threshold" label={t.effects.threshold} />
        <PostSlider section="bloom" field="radius" label={t.effects.radius} />
        <Hint>{t.effects.bloomHint}</Hint>
      </Section>
      <HalationSection />
      <RaysSection />
      <FlareSection />
      <Section title={t.effects.lens} testId="post-lens">
        <PostSlider section="lens" field="aberration" label={t.effects.aberration} />
        <PostSlider section="lens" field="vignette" label={t.effects.vignette} min={-100} format={formatSigned} />
        <PostSlider section="lens" field="midpoint" label={t.effects.midpoint} />
        <PostSlider section="lens" field="feather" label={t.effects.feather} />
      </Section>
      <Section title={t.effects.grain} testId="post-grain">
        <PostSlider section="grain" field="amount" label={t.effects.grainAmount} />
        <PostSlider section="grain" field="size" label={t.effects.grainSize} />
        <PostSlider section="grain" field="color" label={t.effects.grainColor} />
        <Hint>{t.effects.grainHint}</Hint>
      </Section>
      <ToneMappingSection />
      <mdui-button variant="text" onClick={() => useApp.getState().resetPost()} data-testid="post-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.effects.reset}
      </mdui-button>
    </div>
  )
}

function HalationSection() {
  const color = useApp((s) => s.doc.post.halation.color)
  const { beginGesture, endGesture } = useApp.getState()
  return (
    <Section title={t.effects.halation} testId="post-halation">
      <PostSlider section="halation" field="intensity" label={t.effects.intensity} />
      <PostSlider section="halation" field="threshold" label={t.effects.threshold} />
      <PostSlider section="halation" field="radius" label={t.effects.radius} />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-on-surface-variant">{t.effects.halationColor}</span>
        <ColorSwatch
          value={color}
          label={t.effects.halationColor}
          onBegin={beginGesture}
          onChange={(c) => useApp.getState().updatePost('halation', { color: c })}
          onEnd={endGesture}
          testId="post-halation-color"
        />
      </div>
      <Hint>{t.effects.halationHint}</Hint>
    </Section>
  )
}

function RaysSection() {
  const rays = useApp((s) => s.doc.post.rays)
  const lighting = useApp((s) => s.doc.lighting)
  const fovDeg = useApp((s) => s.doc.camera.fovDeg)
  const background = useApp((s) => s.doc.background)
  const fusionRim = useApp((s) => s.doc.fusion.relight.rim)
  // 深度结果存在模块级缓存里，结果更新时 resultsVersion 变化会让选择器重新读取
  const hasDepth = useDepth(() => !!getDepthResult(background?.id))
  const used = background ? raysLight(lighting, rays.light, background, fovDeg) : null
  const auto = background ? raysLight(lighting, null, background, fovDeg) : null
  const options = [
    { value: AUTO, label: t.effects.raysAuto(auto ? lightName(lighting.lights, auto.light) : null) },
    ...lighting.lights.map((l) => ({ value: l.id, label: lightName(lighting.lights, l) })),
  ]
  const selected = rays.light !== null && lighting.lights.some((l) => l.id === rays.light) ? rays.light : AUTO
  return (
    <Section title={t.effects.rays} testId="post-rays">
      <PostSlider section="rays" field="intensity" label={t.effects.intensity} />
      <PostSlider section="rays" field="rim" label={t.effects.raysRim} />
      <PostSlider section="rays" field="threshold" label={t.effects.threshold} />
      <PostSlider section="rays" field="length" label={t.effects.raysLength} />
      <SelectField
        label={t.effects.raysLight}
        value={selected}
        options={options}
        onChange={(v) => useApp.getState().updatePost('rays', { light: v === AUTO ? null : v })}
        testId="post-rays-light"
      />
      <ToggleRow label={t.effects.raysSkyOnly} checked={rays.skyOnly} onChange={(skyOnly) => useApp.getState().updatePost('rays', { skyOnly })} testId="post-rays-sky" />
      <Hint>{t.effects.raysHint}</Hint>
      {!used && <Hint>{t.effects.raysNoLight}</Hint>}
      {rays.rim > 0 && fusionRim === 0 && <Hint>{t.effects.raysNoRim}</Hint>}
      {rays.skyOnly && !hasDepth && <Hint>{t.effects.raysNoSky}</Hint>}
    </Section>
  )
}

function ToneMappingSection() {
  const mode = useApp((s) => s.doc.post.toneMapping)
  return (
    <Section title={t.effects.toneMapping} testId="post-tone">
      <Segmented value={mode} options={TONE_MAPPINGS} label={(m) => t.effects.toneMappings[m]} onChange={useApp.getState().setToneMapping} testId="post-tone-mapping" />
      <Hint>{t.effects.toneMappingHint}</Hint>
    </Section>
  )
}
