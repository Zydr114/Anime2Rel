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
import { Group, Hint, More, ToggleRow } from './Group'

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const AUTO = 'auto'
/** 收起时的摘要：强度为 0 时显示“关闭” */
const intensitySummary = (v: number) => (v > 0 ? `${t.effects.intensity} ${formatPercent(v * 100)}` : t.effects.off)

type NumberField<K extends PostSection> = { [F in keyof PostDoc[K]]: PostDoc[K][F] extends number ? F : never }[keyof PostDoc[K]] & string

/** 后期参数滑块：显示值 = 参数 × 100，拖动期间合并为一次撤销记录。 */
function PostSlider<K extends PostSection>({ section, field, label, min = 0, format = formatPercent }: { section: K; field: NumberField<K>; label: string; min?: number; format?: (v: number) => string }) {
  const value = useApp((s) => s.doc.post[section][field] as number)
  const onChange = useGestureChange(useCallback((v: number) => useApp.getState().updatePost(section, { [field]: v / 100 } as Partial<PostDoc[K]>), [section, field]))
  return <SliderField label={label} value={value * 100} min={min} max={100} format={format} onChange={onChange} testId={`post-${section}-${field}`} />
}

/** 镜头步骤中后期效果的各组 */
export function PostSections() {
  const post = useApp((s) => s.doc.post)
  const e = t.effects
  const lens = [post.lens.aberration > 0 && `${e.aberration} ${formatPercent(post.lens.aberration * 100)}`, post.lens.vignette !== 0 && `${e.vignette} ${formatSigned(post.lens.vignette * 100)}`].filter(Boolean)
  return (
    <>
      <Group id="post.bloom" title={e.bloom} summary={intensitySummary(post.bloom.intensity)} help={[e.bloomHint, e.hint]} testId="post-bloom">
        <PostSlider section="bloom" field="intensity" label={e.intensity} />
        <PostSlider section="bloom" field="threshold" label={e.threshold} />
        <PostSlider section="bloom" field="radius" label={e.radius} />
      </Group>
      <Group id="post.diffusion" title={e.diffusion} summary={intensitySummary(post.diffusion.intensity)} help={e.diffusionHint} testId="post-diffusion">
        <PostSlider section="diffusion" field="intensity" label={e.intensity} />
        <PostSlider section="diffusion" field="radius" label={e.radius} />
        <PostSlider section="diffusion" field="threshold" label={e.threshold} />
      </Group>
      <Group id="post.softFocus" title={e.softFocus} summary={intensitySummary(post.softFocus.intensity)} help={e.softFocusHint} testId="post-softFocus">
        <PostSlider section="softFocus" field="intensity" label={e.intensity} />
        <PostSlider section="softFocus" field="radius" label={e.radius} />
        <PostSlider section="softFocus" field="glow" label={e.softFocusGlow} />
      </Group>
      <Group id="post.soften" title={e.soften} summary={intensitySummary(post.soften.intensity)} help={e.softenHint} testId="post-soften">
        <PostSlider section="soften" field="intensity" label={e.intensity} />
        <PostSlider section="soften" field="radius" label={e.radius} />
      </Group>
      <HalationSection />
      <RaysSection />
      <FlareSection />
      <Group id="post.lens" title={e.lens} summary={lens.length ? lens.join(' · ') : e.off} testId="post-lens">
        <PostSlider section="lens" field="aberration" label={e.aberration} />
        <PostSlider section="lens" field="vignette" label={e.vignette} min={-100} format={formatSigned} />
        <More id="post.lens.more">
          <PostSlider section="lens" field="midpoint" label={e.midpoint} />
          <PostSlider section="lens" field="feather" label={e.feather} />
        </More>
      </Group>
      <Group id="post.grain" title={e.grain} summary={intensitySummary(post.grain.amount)} help={e.grainHint} testId="post-grain">
        <PostSlider section="grain" field="amount" label={e.grainAmount} />
        <PostSlider section="grain" field="size" label={e.grainSize} />
        <More id="post.grain.more">
          <PostSlider section="grain" field="color" label={e.grainColor} />
        </More>
      </Group>
      <ToneMappingSection />
    </>
  )
}

function HalationSection() {
  const halation = useApp((s) => s.doc.post.halation)
  const color = halation.color
  const { beginGesture, endGesture } = useApp.getState()
  return (
    <Group id="post.halation" title={t.effects.halation} summary={intensitySummary(halation.intensity)} help={t.effects.halationHint} testId="post-halation">
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
    </Group>
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
  const active = rays.intensity > 0 || rays.rim > 0
  return (
    <Group id="post.rays" title={t.effects.rays} summary={intensitySummary(rays.intensity)} help={t.effects.raysHint} testId="post-rays">
      {active && !used && <Hint warn>{t.effects.raysNoLight}</Hint>}
      {rays.rim > 0 && fusionRim === 0 && <Hint warn>{t.effects.raysNoRim}</Hint>}
      <PostSlider section="rays" field="intensity" label={t.effects.intensity} />
      <PostSlider section="rays" field="rim" label={t.effects.raysRim} />
      <More id="post.rays.more">
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
        {rays.skyOnly && !hasDepth && <Hint>{t.effects.raysNoSky}</Hint>}
      </More>
    </Group>
  )
}

function ToneMappingSection() {
  const mode = useApp((s) => s.doc.post.toneMapping)
  return (
    <Group id="post.tone" title={t.effects.toneMapping} summary={t.effects.toneMappings[mode]} help={t.effects.toneMappingHint} testId="post-tone">
      <Segmented value={mode} options={TONE_MAPPINGS} label={(m) => t.effects.toneMappings[m]} onChange={useApp.getState().setToneMapping} testId="post-tone-mapping" />
    </Group>
  )
}
