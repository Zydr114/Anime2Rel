import { useCallback, useRef } from 'react'
import type { SegmentedButtonGroup } from 'mdui/components/segmented-button-group.js'
import { BOKEH_BLADES, MEDIUM_MODES, OCCLUSION_MODES, type FocusDoc, type FocusSection } from '@/focus/model'
import { focusDepth } from '@/focus/params'
import { focusInputs } from '@/focus/service'
import { t } from '@/i18n'
import { useDepth } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { useDomEvent } from '@/ui/useDomEvent'
import { useGestureChange } from '../useGestureChange'
import { DepthSection, Hint, Section, ToggleRow } from './FusionSections'

const DEG = 180 / Math.PI

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatRelative = (v: number) => `${v.toFixed(1)}%`
const formatDegrees = (v: number) => `${Math.round(v)}°`

/** 景深参数滑块：显示值 = 参数 × scale，拖动期间合并为一次撤销记录。 */
function FocusSlider<K extends FocusSection>(props: {
  section: K
  field: keyof FocusDoc[K] & string
  label: string
  min: number
  max: number
  step?: number
  scale?: number
  format?: (v: number) => string
}) {
  const { section, field, scale = 100 } = props
  const value = useApp((s) => s.doc.focus[section][field] as number)
  const onChange = useGestureChange(
    useCallback((v: number) => useApp.getState().updateFocus(section, { [field]: v / scale } as Partial<FocusDoc[K]>), [section, field, scale]),
  )
  return (
    <SliderField
      label={props.label}
      value={value * scale}
      min={props.min}
      max={props.max}
      step={props.step}
      format={props.format ?? formatRelative}
      onChange={onChange}
      testId={`focus-${section}-${field}`}
    />
  )
}

/** 单选分段按钮；再次点击已选项会取消选中，此时恢复原值 */
function Segmented<T extends string>({ value, options, label, onChange, testId }: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void; testId: string }) {
  const ref = useRef<SegmentedButtonGroup>(null)
  useDomEvent(ref, 'change', (e, el) => {
    if (e.target !== el) return
    if (el.value) onChange(el.value as T)
    else el.value = value
  })
  return (
    <mdui-segmented-button-group ref={ref} selects="single" value={value} full-width data-testid={testId}>
      {options.map((v) => (
        <mdui-segmented-button key={v} value={v}>
          {label(v)}
        </mdui-segmented-button>
      ))}
    </mdui-segmented-button-group>
  )
}

export function FocusPanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  const hasCharacter = useApp((s) => s.doc.character !== null)
  if (!hasBackground) return <p className="px-1 text-sm text-on-surface-variant">{t.focus.noBackground}</p>
  return (
    <div className="flex flex-col gap-4">
      <DofSection />
      <TargetSection />
      {hasCharacter && (
        <DepthSection>
          <ThicknessSlider />
          <Hint>{t.focus.thicknessHint}</Hint>
        </DepthSection>
      )}
      {hasCharacter && <OcclusionSection />}
      <mdui-button variant="text" onClick={() => useApp.getState().resetFocus()} data-testid="focus-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.focus.reset}
      </mdui-button>
    </div>
  )
}

function DofSection() {
  const enabled = useApp((s) => s.doc.focus.dof.enabled)
  const blades = useApp((s) => s.doc.focus.dof.blades)
  const options = BOKEH_BLADES.map(String)
  return (
    <Section title={t.focus.dof} testId="focus-dof">
      <ToggleRow label={t.focus.dofEnabled} checked={enabled} onChange={(v) => useApp.getState().updateFocus('dof', { enabled: v })} testId="focus-dof-enabled" />
      <FocusSlider section="dof" field="aperture" label={t.focus.aperture} min={0} max={5} step={0.1} />
      <FocusSlider section="dof" field="range" label={t.focus.range} min={0} max={20} step={0.5} />
      <span>{t.focus.bokeh}</span>
      <Segmented
        value={String(blades)}
        options={options}
        label={(v) => t.focus.blades[Number(v)]}
        onChange={(v) => useApp.getState().updateFocus('dof', { blades: Number(v) })}
        testId="focus-dof-blades"
      />
      {blades > 0 && <FocusSlider section="dof" field="rotation" label={t.focus.rotation} min={0} max={180} scale={DEG} format={formatDegrees} />}
      <Hint>{t.focus.dofHint}</Hint>
    </Section>
  )
}

function TargetSection() {
  const doc = useApp((s) => s.doc)
  // 深度结果和立绘信息在模块级缓存与融合状态中，订阅它们以便更新焦点深度
  useDepth((s) => s.resultsVersion)
  useFusion((s) => s.character)
  const view = useDepth((s) => s.view)
  const target = doc.focus.target
  const label = !target ? t.focus.targetAuto : target.kind === 'character' ? t.focus.targetCharacter : t.focus.targetBackground
  const depth = focusDepth(focusInputs(doc))
  return (
    <Section title={t.focus.target} testId="focus-target">
      <div className="flex items-baseline justify-between">
        <span data-testid="focus-target-kind" data-kind={target?.kind ?? 'auto'}>
          {label}
        </span>
        <span className="text-on-surface-variant tabular-nums" data-testid="focus-depth">
          {t.focus.focusDepth} {formatPercent(depth * 100)}
        </span>
      </div>
      {doc.character && (
        <mdui-button variant="tonal" disabled={!target} onClick={() => useApp.getState().setFocus({ target: null })} data-testid="focus-auto">
          <mdui-icon-center-focus-strong--outlined slot="icon" />
          {t.focus.focusOnCharacter}
        </mdui-button>
      )}
      <ToggleRow
        label={t.focus.showFocusView}
        checked={view === 'focus'}
        onChange={(v) => useDepth.getState().setView(v ? 'focus' : 'composite')}
        testId="focus-show-view"
      />
      <Hint>{t.focus.targetHint}</Hint>
    </Section>
  )
}

function ThicknessSlider() {
  const thickness = useApp((s) => s.doc.focus.thickness)
  const onChange = useGestureChange(useCallback((v: number) => useApp.getState().setFocus({ thickness: v / 100 }), []))
  return <SliderField label={t.focus.thickness} value={thickness * 100} min={0} max={50} step={1} format={formatPercent} onChange={onChange} testId="focus-thickness" />
}

function OcclusionSection() {
  const { enabled, mode } = useApp((s) => s.doc.focus.occlusion)
  const showMask = useFusion((s) => s.showMask)
  return (
    <Section title={t.focus.occlusion} testId="focus-occlusion">
      <ToggleRow
        label={t.focus.occlusionEnabled}
        checked={enabled}
        onChange={(v) => useApp.getState().updateFocus('occlusion', { enabled: v })}
        testId="focus-occlusion-enabled"
      />
      <SelectField
        label={t.focus.occlusionMode}
        value={mode}
        options={OCCLUSION_MODES.map((v) => ({ value: v, label: t.focus.modes[v] }))}
        onChange={(v) => useApp.getState().updateFocus('occlusion', { mode: v })}
        testId="focus-occlusion-mode"
      />
      <Hint>{t.focus.modeHints[mode]}</Hint>
      {mode !== 'water' && (
        <>
          <FocusSlider section="occlusion" field="tolerance" label={t.focus.tolerance} min={0} max={30} step={0.5} />
          <FocusSlider section="occlusion" field="softness" label={t.focus.softness} min={0} max={20} step={0.5} />
        </>
      )}
      {MEDIUM_MODES.includes(mode) && (
        <>
          <FocusSlider section="occlusion" field="clarity" label={t.focus.clarity} min={0} max={100} format={formatPercent} />
          <FocusSlider section="occlusion" field="density" label={t.focus.density} min={0} max={100} format={formatPercent} />
          <FocusSlider section="occlusion" field="detail" label={t.focus.detail} min={0} max={100} format={formatPercent} />
        </>
      )}
      {mode === 'water' && (
        <>
          <FocusSlider section="occlusion" field="highlight" label={t.focus.highlight} min={0} max={100} format={formatPercent} />
          <FocusSlider section="occlusion" field="ripple" label={t.focus.ripple} min={0} max={100} format={formatPercent} />
        </>
      )}
      <ToggleRow label={t.focus.showMask} checked={showMask} onChange={useFusion.getState().setShowMask} testId="focus-show-mask" />
      <Hint>{t.focus.occlusionHint}</Hint>
    </Section>
  )
}
