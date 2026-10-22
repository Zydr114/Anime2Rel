import { useCallback } from 'react'
import { CURVE_CHANNELS, GRADE_LEVELS, HSL_BANDS, isIdentityCurve, type BasicAdjust, type CurveChannel, type CurvePoints } from '@/grade/model'
import { t } from '@/i18n'
import { GRADE_TABS, useGradeUi } from '@/state/grade'
import { useApp } from '@/state/store'
import { CurveEditor } from '@/ui/CurveEditor'
import { Segmented } from '@/ui/Segmented'
import { SliderField } from '@/ui/SliderField'
import { useGestureChange } from '../useGestureChange'
import { Empty, Group, Help, Hint, More } from './Group'
import { LocalSections } from './LocalSections'
import { PresetSections } from './PresetSections'
import { StyleSections } from './StyleSections'

type ScalarField = { [K in keyof BasicAdjust]: BasicAdjust[K] extends number ? K : never }[keyof BasicAdjust]

const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const formatEv = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`

/** 色相段色块的颜色（sRGB），与 src/grade/color.ts 的色相段中心一致 */
const BAND_SWATCHES = ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff00ff']
/** 主曲线用前景色（随主题变化） */
const CHANNEL_COLORS: Record<CurveChannel, string> = { master: 'currentColor', r: '#f87171', g: '#4ade80', b: '#60a5fa' }

const currentAdjust = () => {
  const level = useGradeUi.getState().level
  return { level, adjust: useApp.getState().doc.grade.levels[level] }
}

interface FieldSpec {
  field: ScalarField
  label: string
  scale?: number
  format?: (v: number) => string
}

/** 收起时的摘要：列出有修改的前两项 */
function useAdjustSummary(fields: readonly FieldSpec[]): string {
  const level = useGradeUi((s) => s.level)
  const adjust = useApp((s) => s.doc.grade.levels[level])
  const changed = fields.filter((f) => adjust[f.field] !== 0).map((f) => `${f.label} ${(f.format ?? formatSigned)(adjust[f.field] * (f.scale ?? 100))}`)
  if (!changed.length) return t.adjust.unchanged
  return changed.slice(0, 2).join(' · ') + (changed.length > 2 ? ' …' : '')
}

const LIGHT_FIELDS: readonly FieldSpec[] = [
  { field: 'exposure', label: t.adjust.exposure, scale: 1, format: formatEv },
  { field: 'contrast', label: t.adjust.contrast },
  { field: 'highlights', label: t.adjust.highlights },
  { field: 'shadows', label: t.adjust.shadows },
  { field: 'whites', label: t.adjust.whites },
  { field: 'blacks', label: t.adjust.blacks },
]
const COLOR_FIELDS: readonly FieldSpec[] = [
  { field: 'temperature', label: t.adjust.temperature },
  { field: 'tint', label: t.adjust.tint },
  { field: 'vibrance', label: t.adjust.vibrance },
  { field: 'saturation', label: t.adjust.saturation },
]
const DETAIL_FIELDS: readonly FieldSpec[] = [
  { field: 'clarity', label: t.adjust.clarity },
  { field: 'sharpen', label: t.adjust.sharpen },
]

/** 当前级别的基础调整滑块：显示值 = 参数 × scale，拖动期间合并为一次撤销记录。 */
function AdjustSlider({ field, label, min = -100, max = 100, step = 1, scale = 100, format = formatSigned }: { field: ScalarField; label: string; min?: number; max?: number; step?: number; scale?: number; format?: (v: number) => string }) {
  const level = useGradeUi((s) => s.level)
  const value = useApp((s) => s.doc.grade.levels[level][field])
  const onChange = useGestureChange(useCallback((v: number) => useApp.getState().updateAdjust(level, { [field]: v / scale }), [level, field, scale]))
  return <SliderField label={label} value={value * scale} min={min} max={max} step={step} format={format} onChange={onChange} testId={`adjust-${field}`} />
}

export function AdjustPanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  const tab = useGradeUi((s) => s.tab)
  if (!hasBackground) return <Empty>{t.adjust.noBackground}</Empty>
  return (
    <div className="flex flex-col gap-2">
      <Segmented value={tab} options={GRADE_TABS} label={(v) => t.adjust.tabs[v]} onChange={useGradeUi.getState().setTab} testId="grade-tab" />
      {tab === 'basic' ? <BasicSections /> : tab === 'local' ? <LocalSections /> : tab === 'style' ? <StyleSections /> : <PresetSections />}
    </div>
  )
}

function BasicSections() {
  const light = useAdjustSummary(LIGHT_FIELDS)
  const color = useAdjustSummary(COLOR_FIELDS)
  const detail = useAdjustSummary(DETAIL_FIELDS)
  return (
    <>
      <LevelSection />
      <Group id="adjust.light" title={t.adjust.light} summary={light} defaultOpen testId="adjust-light">
        <AdjustSlider field="exposure" label={t.adjust.exposure} min={-5} max={5} step={0.05} scale={1} format={formatEv} />
        <AdjustSlider field="contrast" label={t.adjust.contrast} />
        <AdjustSlider field="highlights" label={t.adjust.highlights} />
        <AdjustSlider field="shadows" label={t.adjust.shadows} />
        <More id="adjust.light.more">
          <AdjustSlider field="whites" label={t.adjust.whites} />
          <AdjustSlider field="blacks" label={t.adjust.blacks} />
        </More>
      </Group>
      <Group id="adjust.color" title={t.adjust.color} summary={color} defaultOpen testId="adjust-color">
        <AdjustSlider field="temperature" label={t.adjust.temperature} />
        <AdjustSlider field="tint" label={t.adjust.tint} />
        <AdjustSlider field="vibrance" label={t.adjust.vibrance} />
        <AdjustSlider field="saturation" label={t.adjust.saturation} />
      </Group>
      <HslSection />
      <CurveSection />
      <Group id="adjust.detail" title={t.adjust.detail} summary={detail} testId="adjust-detail">
        <AdjustSlider field="clarity" label={t.adjust.clarity} />
        <AdjustSlider field="sharpen" label={t.adjust.sharpen} min={0} />
      </Group>
      <ResetButton />
    </>
  )
}

function LevelSection() {
  const level = useGradeUi((s) => s.level)
  const hasCharacter = useApp((s) => s.doc.character !== null)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Segmented value={level} options={GRADE_LEVELS} label={(l) => t.adjust.levels[l]} onChange={useGradeUi.getState().setLevel} testId="adjust-level" />
        </div>
        <Help title={t.adjust.levels[level]} text={t.adjust.levelHints[level]} />
      </div>
      {level === 'character' && !hasCharacter && <Hint warn>{t.adjust.noCharacter}</Hint>}
    </div>
  )
}

/** 修改当前级别、当前色相段的一项 HSL 参数 */
function setHsl(key: keyof BasicAdjust['hsl'], value: number) {
  const { level, adjust } = currentAdjust()
  const band = useGradeUi.getState().band
  useApp.getState().updateAdjust(level, { hsl: { ...adjust.hsl, [key]: adjust.hsl[key].map((x, i) => (i === band ? value : x)) } })
}

function HslSection() {
  const level = useGradeUi((s) => s.level)
  const band = useGradeUi((s) => s.band)
  const hsl = useApp((s) => s.doc.grade.levels[level].hsl)
  const onHue = useGestureChange(useCallback((v: number) => setHsl('hue', v / 100), []))
  const onSaturation = useGestureChange(useCallback((v: number) => setHsl('saturation', v / 100), []))
  const onLuminance = useGestureChange(useCallback((v: number) => setHsl('luminance', v / 100), []))
  const changed = HSL_BANDS.filter((_, i) => hsl.hue[i] !== 0 || hsl.saturation[i] !== 0 || hsl.luminance[i] !== 0).map((b) => t.adjust.bands[b])
  return (
    <Group id="adjust.hsl" title={t.adjust.hsl} summary={changed.length ? changed.join('、') : t.adjust.unchanged} testId="adjust-hsl">
      <div className="flex justify-between">
        {HSL_BANDS.map((b, i) => {
          const changed = hsl.hue[i] !== 0 || hsl.saturation[i] !== 0 || hsl.luminance[i] !== 0
          return (
            <button
              key={b}
              type="button"
              title={t.adjust.bands[b]}
              aria-pressed={band === i}
              onClick={() => useGradeUi.getState().setBand(i)}
              className={`relative size-7 rounded-full border-2 ${band === i ? 'border-on-surface' : 'border-transparent'}`}
              style={{ background: BAND_SWATCHES[i] }}
              data-testid={`hsl-band-${b}`}
            >
              {changed && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-white ring-2 ring-black/60" />}
            </button>
          )
        })}
      </div>
      <SliderField label={`${t.adjust.bands[HSL_BANDS[band]]} · ${t.adjust.hslHue}`} value={hsl.hue[band] * 100} min={-100} max={100} format={formatSigned} onChange={onHue} testId="adjust-hsl-hue" />
      <SliderField label={t.adjust.hslSaturation} value={hsl.saturation[band] * 100} min={-100} max={100} format={formatSigned} onChange={onSaturation} testId="adjust-hsl-saturation" />
      <SliderField label={t.adjust.hslLuminance} value={hsl.luminance[band] * 100} min={-100} max={100} format={formatSigned} onChange={onLuminance} testId="adjust-hsl-luminance" />
    </Group>
  )
}

function CurveSection() {
  const level = useGradeUi((s) => s.level)
  const channel = useGradeUi((s) => s.channel)
  const curves = useApp((s) => s.doc.grade.levels[level].curves)
  const setCurve = (points: CurvePoints) => {
    const { level, adjust } = currentAdjust()
    useApp.getState().updateAdjust(level, { curves: { ...adjust.curves, [useGradeUi.getState().channel]: points } })
  }
  const others = CURVE_CHANNELS.filter((c) => c !== channel && !isIdentityCurve(curves[c])).map((c) => ({ points: curves[c], color: CHANNEL_COLORS[c] }))
  const changed = CURVE_CHANNELS.filter((c) => !isIdentityCurve(curves[c])).map((c) => t.adjust.channels[c])
  return (
    <Group id="adjust.curves" title={t.adjust.curves} summary={changed.length ? changed.join('、') : t.adjust.unchanged} help={t.adjust.curveHint} testId="adjust-curves">
      <Segmented value={channel} options={CURVE_CHANNELS} label={(c) => t.adjust.channels[c]} onChange={useGradeUi.getState().setChannel} testId="curve-channel" />
      <CurveEditor
        points={curves[channel]}
        color={CHANNEL_COLORS[channel]}
        others={others}
        onBegin={useApp.getState().beginGesture}
        onChange={setCurve}
        onEnd={useApp.getState().endGesture}
        testId="curve-editor"
      />
      {!isIdentityCurve(curves[channel]) && (
        <mdui-button variant="text" onClick={() => setCurve([[0, 0], [1, 1]])} data-testid="curve-reset">
          {t.adjust.curveReset}
        </mdui-button>
      )}
    </Group>
  )
}

function ResetButton() {
  const level = useGradeUi((s) => s.level)
  return (
    <mdui-button variant="text" onClick={() => useApp.getState().resetAdjust(level)} data-testid="adjust-reset">
      <mdui-icon-restart-alt--outlined slot="icon" />
      {t.adjust.reset(t.adjust.levels[level])}
    </mdui-button>
  )
}
