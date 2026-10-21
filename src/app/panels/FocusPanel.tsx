import { useCallback } from 'react'
import { BOKEH_BLADES, DEPTH_MODES, MAX_REGIONS, MEDIUM_MODES, OCCLUSION_MODES, type FocusDoc, type FocusSection, type OcclusionStyle } from '@/focus/model'
import { focusDepth } from '@/focus/params'
import { focusInputs } from '@/focus/service'
import { t } from '@/i18n'
import { useDepth } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import { regionColor, useRegionTool, type BrushTool } from '@/state/regions'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { SelectField } from '@/ui/SelectField'
import { Segmented } from '@/ui/Segmented'
import { SliderField } from '@/ui/SliderField'
import { useGestureChange } from '../useGestureChange'
import { DepthSection } from './FusionSections'
import { Empty, Group, Help, More, ToggleRow } from './Group'

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

export function FocusPanel() {
  const hasBackground = useApp((s) => s.doc.background !== null)
  const hasCharacter = useApp((s) => s.doc.character !== null)
  if (!hasBackground) return <Empty>{t.focus.noBackground}</Empty>
  return (
    <div className="flex flex-col gap-2">
      <DofSection />
      <TargetSection />
      {hasCharacter && (
        <DepthSection>
          <ThicknessSlider />
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
  const dof = useApp((s) => s.doc.focus.dof)
  const options = BOKEH_BLADES.map(String)
  const f = t.focus
  return (
    <Group
      id="focus.dof"
      title={f.dof}
      summary={dof.enabled ? f.dofSummary(formatRelative(dof.aperture * 100), t.focus.blades[dof.blades]) : f.off}
      help={f.dofHint}
      toggle={{ checked: dof.enabled, onChange: (v) => useApp.getState().updateFocus('dof', { enabled: v }), testId: 'focus-dof-enabled' }}
      defaultOpen
      testId="focus-dof"
    >
      <FocusSlider section="dof" field="aperture" label={f.aperture} min={0} max={5} step={0.1} />
      <FocusSlider section="dof" field="range" label={f.range} min={0} max={20} step={0.5} />
      <More id="focus.dof.more">
        <span>{f.bokeh}</span>
        <Segmented
          value={String(dof.blades)}
          options={options}
          label={(v) => f.blades[Number(v)]}
          onChange={(v) => useApp.getState().updateFocus('dof', { blades: Number(v) })}
          testId="focus-dof-blades"
        />
        {dof.blades > 0 && <FocusSlider section="dof" field="rotation" label={f.rotation} min={0} max={180} scale={DEG} format={formatDegrees} />}
      </More>
    </Group>
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
    <Group id="focus.target" title={t.focus.target} summary={`${label} · ${formatPercent(depth * 100)}`} help={t.focus.targetHint} defaultOpen testId="focus-target">
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
    </Group>
  )
}

/** 立绘厚度：景深步骤与立绘步骤共用 */
export function ThicknessSlider() {
  const thickness = useApp((s) => s.doc.focus.thickness)
  const onChange = useGestureChange(useCallback((v: number) => useApp.getState().setFocus({ thickness: v / 100 }), []))
  return <SliderField label={t.focus.thickness} value={thickness * 100} min={0} max={50} step={1} format={formatPercent} onChange={onChange} testId="focus-thickness" />
}

function OcclusionSection() {
  const occlusion = useApp((s) => s.doc.focus.occlusion)
  const showMask = useFusion((s) => s.showMask)
  const update = useCallback((u: Partial<OcclusionStyle>) => useApp.getState().updateFocus('occlusion', u), [])
  const depthTested = [occlusion, ...occlusion.regions].some((s) => DEPTH_MODES.includes(s.mode))
  const f = t.focus
  const regions = occlusion.regions.length
  return (
    <Group
      id="focus.occlusion"
      title={f.occlusion}
      summary={occlusion.enabled ? (regions ? f.occlusionSummary(f.modes[occlusion.mode], regions) : f.modes[occlusion.mode]) : f.off}
      help={[f.occlusionHint, f.regionHint]}
      toggle={{ checked: occlusion.enabled, onChange: (v) => useApp.getState().updateFocus('occlusion', { enabled: v }), testId: 'focus-occlusion-enabled' }}
      testId="focus-occlusion"
    >
      <StyleControls style={occlusion} label={regions ? f.outsideMode : f.occlusionMode} update={update} testPrefix="focus-occlusion-" />
      {depthTested && (
        <More id="focus.occlusion.more">
          <FocusSlider section="occlusion" field="tolerance" label={f.tolerance} min={0} max={30} step={0.5} />
          <FocusSlider section="occlusion" field="softness" label={f.softness} min={0} max={20} step={0.5} />
        </More>
      )}
      <RegionList />
      <ToggleRow label={f.showMask} checked={showMask} onChange={useFusion.getState().setShowMask} testId="focus-show-mask" />
    </Group>
  )
}

/** 遮挡方式参数的滑块（0–100%），拖动期间合并为一次撤销记录 */
function StyleSlider({ value, label, onChange, testId }: { value: number; label: string; onChange: (v: number) => void; testId: string }) {
  const change = useGestureChange(useCallback((v: number) => onChange(v / 100), [onChange]))
  return <SliderField label={label} value={value * 100} min={0} max={100} format={formatPercent} onChange={change} testId={testId} />
}

const MEDIUM_FIELDS = ['clarity', 'density', 'detail'] as const
const WATER_FIELDS = ['highlight', 'ripple', 'reflection'] as const
const REFLECTION_FIELDS = ['reflectionBlur', 'reflectionRipple'] as const

/** 遮挡方式及其参数，区域外和每个区域共用 */
function StyleControls({ style, label, update, testPrefix }: { style: OcclusionStyle; label: string; update: (u: Partial<OcclusionStyle>) => void; testPrefix: string }) {
  const { mode } = style
  const { beginGesture, endGesture } = useApp.getState()
  const slider = (field: (typeof MEDIUM_FIELDS)[number] | (typeof WATER_FIELDS)[number] | (typeof REFLECTION_FIELDS)[number]) => (
    <StyleSlider key={field} value={style[field]} label={t.focus[field]} onChange={(v) => update({ [field]: v })} testId={testPrefix + field} />
  )
  return (
    <>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <SelectField
            label={label}
            value={mode}
            options={OCCLUSION_MODES.map((v) => ({ value: v, label: t.focus.modes[v] }))}
            onChange={(v) => update({ mode: v })}
            testId={`${testPrefix}mode`}
          />
        </div>
        <Help title={t.focus.modes[mode]} text={mode === 'water' ? [t.focus.modeHints.water, t.focus.reflectionHint] : t.focus.modeHints[mode]} />
      </div>
      {MEDIUM_MODES.includes(mode) && MEDIUM_FIELDS.map(slider)}
      {mode === 'water' && WATER_FIELDS.map(slider)}
      {mode === 'water' && style.reflection > 0 && (
        <>
          {REFLECTION_FIELDS.map(slider)}
          <div className="flex items-center gap-2">
            <span className="flex-1 text-on-surface-variant">{t.focus.waterColor}</span>
            <ColorSwatch value={style.waterColor} label={t.focus.waterColor} onBegin={beginGesture} onChange={(waterColor) => update({ waterColor })} onEnd={endGesture} testId={`${testPrefix}waterColor`} />
          </div>
        </>
      )}
    </>
  )
}

const BRUSH_TOOLS: readonly BrushTool[] = ['brush', 'eraser']

/** 遮挡区域列表；选中的区域可以在画布上涂抹并设置自己的遮挡方式 */
function RegionList() {
  const regions = useApp((s) => s.doc.focus.occlusion.regions)
  const snap = useApp((s) => s.doc.focus.occlusion.snap)
  const { active, tool, size, setActive, setTool, setSize } = useRegionTool()
  const index = regions.findIndex((r) => r.id === active)
  const region = index >= 0 ? regions[index] : null
  const updateRegion = useCallback((u: Partial<OcclusionStyle>) => region && useApp.getState().updateRegion(region.id, u), [region])

  const add = () => {
    const id = useApp.getState().addRegion()
    if (!id) return
    setActive(id)
    setTool('brush')
  }
  const remove = () => {
    if (region) useApp.getState().removeRegion(region.id)
    setActive(null)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="occlusion-regions">
      <div className="flex items-baseline justify-between">
        <span>{t.focus.regions}</span>
        <span className="text-on-surface-variant tabular-nums">
          {regions.length}/{MAX_REGIONS}
        </span>
      </div>
      {regions.map((r, i) => (
        <button
          key={r.id}
          type="button"
          className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left ${r.id === active ? 'bg-white/15' : 'hover:bg-white/5'}`}
          onClick={() => setActive(r.id === active ? null : r.id)}
          data-testid={`region-${i}`}
          data-active={r.id === active}
        >
          <span className="h-3 w-3 rounded-full" style={{ background: regionColor(i) }} />
          <span className="flex-1">{t.focus.regionName(i + 1)}</span>
          <span className="text-on-surface-variant">{r.strokes.length ? t.focus.modes[r.mode] : t.focus.regionEmpty}</span>
        </button>
      ))}
      {regions.length < MAX_REGIONS && (
        <mdui-button variant="tonal" onClick={add} data-testid="region-add">
          <mdui-icon-add--outlined slot="icon" />
          {t.focus.addRegion}
        </mdui-button>
      )}
      {region && (
        <div className="flex flex-col gap-3 rounded-xl bg-white/5 p-2" data-testid="region-editor">
          <Segmented value={tool} options={BRUSH_TOOLS} label={(v) => t.focus.tools[v]} onChange={setTool} testId="region-tool" />
          <SliderField label={t.focus.brushSize} value={size} min={4} max={200} format={(v) => `${Math.round(v)} px`} onChange={(v) => setSize(v)} testId="region-size" />
          <ToggleRow label={t.focus.snap} checked={snap} onChange={(v) => useApp.getState().updateFocus('occlusion', { snap: v })} testId="region-snap" />
          <StyleControls style={region} label={t.focus.regionMode} update={updateRegion} testPrefix="region-" />
          <div className="flex justify-between">
            <mdui-button variant="text" onClick={remove} data-testid="region-remove">
              <mdui-icon-delete--outlined slot="icon" />
              {t.focus.removeRegion}
            </mdui-button>
            <mdui-button variant="text" onClick={() => setActive(null)} data-testid="region-done">
              {t.focus.regionDone}
            </mdui-button>
          </div>
        </div>
      )}
    </div>
  )
}
