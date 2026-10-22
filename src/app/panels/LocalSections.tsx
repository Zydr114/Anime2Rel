import { useCallback } from 'react'
import { MASK_RANGES, MASK_SHAPES, MAX_MASKS, hasBrush, type LocalMask, type MaskAdjust, type MaskPart } from '@/grade/mask'
import { BLEND_MODES } from '@/grade/model'
import { t } from '@/i18n'
import { getDepthResult, useDepth } from '@/state/depth'
import { useGradeUi } from '@/state/grade'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { useGestureChange } from '../useGestureChange'
import { Group, Hint, ToggleRow } from './Group'

const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const formatEv = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`
const formatPercent = (v: number) => `${Math.round(v)}%`

const MODE_OPTIONS = BLEND_MODES.map((value) => ({ value, label: t.style.modes[value] }))
const RANGE_OPTIONS = MASK_RANGES.map((value) => ({ value, label: t.local.ranges[value] }))
const SIDES = ['near', 'far'] as const
const BRUSH_TOOLS = ['brush', 'eraser'] as const

type NumericField<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T] & string
type NumericPart = Exclude<MaskPart, 'linear'>

/** 选中的局部调整（被撤销删除时为 null） */
function useSelected(): { mask: LocalMask; index: number } | null {
  const id = useGradeUi((s) => s.mask)
  const masks = useApp((s) => s.doc.masks)
  const index = masks.findIndex((m) => m.id === id)
  return index >= 0 ? { mask: masks[index], index } : null
}

const currentMask = (id: string) => useApp.getState().doc.masks.find((m) => m.id === id)

/** 局部调整的一个数值参数：显示值 = 参数 × scale，拖动期间合并为一次撤销记录 */
function MaskSlider<P extends NumericPart>(props: {
  mask: LocalMask
  part: P
  field: NumericField<LocalMask[P]>
  label: string
  min: number
  max: number
  step?: number
  scale?: number
  format?: (v: number) => string
  /** 写入前修正（例如亮度下限不超过上限） */
  clamp?: (v: number) => number
}) {
  const { mask, part, field, scale = 100, clamp } = props
  const id = mask.id
  const onChange = useGestureChange(
    useCallback(
      (v: number) => {
        const value = v / scale
        useApp.getState().updateMaskPart(id, part, { [field]: clamp ? clamp(value) : value } as Partial<LocalMask[P]>)
      },
      [id, part, field, scale, clamp],
    ),
  )
  const value = (mask[part] as unknown as Record<string, number>)[field]
  return (
    <SliderField
      label={props.label}
      value={value * scale}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      format={props.format ?? formatSigned}
      onChange={onChange}
      testId={`mask-${field}`}
    />
  )
}

/** “局部”页：局部调整列表，选中一项后在下面编辑它的形状、范围和调整 */
export function LocalSections() {
  const selected = useSelected()
  return (
    <>
      <MaskList selected={selected?.mask.id ?? null} />
      {selected && <MaskEditor key={selected.mask.id} mask={selected.mask} />}
    </>
  )
}

function MaskList({ selected }: { selected: string | null }) {
  const masks = useApp((s) => s.doc.masks)
  const { setMask } = useGradeUi.getState()
  const add = () => {
    const id = useApp.getState().addMask()
    if (id) setMask(id)
  }
  return (
    <Group id="local.list" title={t.local.list} summary={masks.length ? t.local.count(masks.length) : t.local.none} help={t.local.hint} defaultOpen testId="local-list">
      {masks.map((m, i) => (
        <div key={m.id} className={`flex items-center gap-1 rounded-lg pr-1 ${m.id === selected ? 'bg-on-surface/15' : 'hover:bg-on-surface/5'}`}>
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
            onClick={() => setMask(m.id === selected ? null : m.id)}
            data-testid={`mask-${i}`}
            data-active={m.id === selected}
          >
            <span className={`flex-1 ${m.enabled ? '' : 'text-on-surface-variant line-through'}`}>{t.local.name(i + 1)}</span>
            <span className="text-on-surface-variant">{m.enabled ? t.local.shapes[m.shape] : t.local.disabled}</span>
          </button>
          <mdui-button-icon
            onClick={() => useApp.getState().updateMask(m.id, { enabled: !m.enabled })}
            aria-label={m.enabled ? t.local.disable : t.local.enable}
            data-testid={`mask-${i}-enabled`}
            data-enabled={m.enabled}
          >
            {m.enabled ? <mdui-icon-visibility--outlined /> : <mdui-icon-visibility-off--outlined />}
          </mdui-button-icon>
        </div>
      ))}
      <mdui-button variant="tonal" disabled={masks.length >= MAX_MASKS || undefined} onClick={add} data-testid="mask-add">
        <mdui-icon-add--outlined slot="icon" />
        {t.local.add}
      </mdui-button>
      {masks.length >= MAX_MASKS && <Hint>{t.local.limit(MAX_MASKS)}</Hint>}
    </Group>
  )
}

function MaskEditor({ mask }: { mask: LocalMask }) {
  const id = mask.id
  const showMask = useGradeUi((s) => s.showMask)
  return (
    <>
      <ShapeSection mask={mask} />
      <RangeSection mask={mask} />
      <AdjustSection mask={mask} />
      <ToggleRow label={t.local.showMask} checked={showMask} onChange={useGradeUi.getState().setShowMask} testId="mask-show" />
      <Hint>{t.local.showMaskHint}</Hint>
      <mdui-button
        variant="text"
        onClick={() => {
          useApp.getState().removeMask(id)
          useGradeUi.getState().setMask(null)
        }}
        data-testid="mask-remove"
      >
        <mdui-icon-delete--outlined slot="icon" />
        {t.local.remove}
      </mdui-button>
    </>
  )
}

function ShapeSection({ mask }: { mask: LocalMask }) {
  const id = mask.id
  const tool = useGradeUi((s) => s.maskTool)
  const size = useGradeUi((s) => s.maskBrushSize)
  const update = useApp.getState().updateMask
  return (
    <Group id="local.shape" title={t.local.shape} summary={t.local.shapes[mask.shape]} defaultOpen testId="local-shape">
      <Segmented value={mask.shape} options={MASK_SHAPES} label={(v) => t.local.shapes[v]} onChange={(shape) => update(id, { shape })} testId="mask-shape" />
      <Hint>{t.local.shapeHints[mask.shape]}</Hint>
      {mask.shape === 'ellipse' && <MaskSlider mask={mask} part="ellipse" field="feather" label={t.local.feather} min={0} max={100} format={formatPercent} />}
      {mask.shape === 'brush' && (
        <>
          <Segmented value={tool} options={BRUSH_TOOLS} label={(v) => t.focus.tools[v]} onChange={useGradeUi.getState().setMaskTool} testId="mask-tool" />
          <SliderField label={t.focus.brushSize} value={size} min={4} max={400} format={(v) => `${Math.round(v)} px`} onChange={(v) => useGradeUi.getState().setMaskBrushSize(v)} testId="mask-size" />
          <ToggleRow label={t.local.snap} checked={mask.snap} onChange={(snap) => update(id, { snap })} testId="mask-snap" />
          {!hasBrush(mask) && <Hint warn>{t.local.brushEmpty}</Hint>}
        </>
      )}
      {mask.shape !== 'full' && <ToggleRow label={t.local.invert} checked={mask.invert} onChange={(invert) => update(id, { invert })} testId="mask-invert" />}
    </Group>
  )
}

function RangeSection({ mask }: { mask: LocalMask }) {
  const id = mask.id
  const range = mask.range
  const hasCharacter = useApp((s) => s.doc.character !== null)
  // 深度结果更新时重新判断
  useDepth((s) => s.resultsVersion)
  const hasDepth = !!getDepthResult(useApp.getState().doc.background?.id)
  const set = (u: Partial<LocalMask['range']>) => useApp.getState().updateMaskPart(id, 'range', u)
  const clampLow = useCallback((v: number) => Math.min(v, currentMask(id)?.range.high ?? 1), [id])
  const clampHigh = useCallback((v: number) => Math.max(v, currentMask(id)?.range.low ?? 0), [id])
  const empty = ((range.kind === 'sky' || range.kind === 'depth') && !hasDepth) || (range.kind === 'character' && !hasCharacter)
  return (
    <Group id="local.range" title={t.local.range} summary={t.local.ranges[range.kind]} defaultOpen testId="local-range">
      <SelectField label={t.local.range} value={range.kind} options={RANGE_OPTIONS} onChange={(kind) => set({ kind })} testId="mask-range" />
      <Hint>{t.local.rangeHints[range.kind]}</Hint>
      {empty && <Hint warn>{range.kind === 'character' ? t.local.noCharacter : t.local.noDepth}</Hint>}
      {range.kind === 'depth' && (
        <>
          <Segmented value={range.near ? 'near' : 'far'} options={SIDES} label={(v) => t.local.sides[v]} onChange={(v) => set({ near: v === 'near' })} testId="mask-side" />
          <MaskSlider mask={mask} part="range" field="depth" label={t.local.depth} min={0} max={100} format={formatPercent} />
          <MaskSlider mask={mask} part="range" field="softness" label={t.local.softness} min={0} max={50} format={formatPercent} />
        </>
      )}
      {range.kind === 'luminance' && (
        <>
          <MaskSlider mask={mask} part="range" field="low" label={t.local.low} min={0} max={100} format={formatPercent} clamp={clampLow} />
          <MaskSlider mask={mask} part="range" field="high" label={t.local.high} min={0} max={100} format={formatPercent} clamp={clampHigh} />
        </>
      )}
    </Group>
  )
}

const ADJUST_FIELDS = ['exposure', 'contrast', 'temperature', 'tint', 'saturation'] as const satisfies readonly NumericField<MaskAdjust>[]

/** 收起时的摘要：列出有修改的前两项 */
function adjustSummary(a: MaskAdjust): string {
  const changed = ADJUST_FIELDS.filter((f) => a[f] !== 0).map((f) => `${t.adjust[f]} ${f === 'exposure' ? formatEv(a[f]) : formatSigned(a[f] * 100)}`)
  if (a.opacity > 0) changed.push(`${t.local.overlay} ${formatPercent(a.opacity * 100)}`)
  if (!changed.length) return t.adjust.unchanged
  return changed.slice(0, 2).join(' · ') + (changed.length > 2 ? ' …' : '')
}

function AdjustSection({ mask }: { mask: LocalMask }) {
  const id = mask.id
  const a = mask.adjust
  const { beginGesture, endGesture, updateMaskPart } = useApp.getState()
  const set = (u: Partial<MaskAdjust>) => updateMaskPart(id, 'adjust', u)
  return (
    <Group id="local.adjust" title={t.local.adjust} summary={adjustSummary(a)} defaultOpen testId="local-adjust">
      <MaskSlider mask={mask} part="adjust" field="exposure" label={t.adjust.exposure} min={-5} max={5} step={0.05} scale={1} format={formatEv} />
      <MaskSlider mask={mask} part="adjust" field="contrast" label={t.adjust.contrast} min={-100} max={100} />
      <MaskSlider mask={mask} part="adjust" field="temperature" label={t.adjust.temperature} min={-100} max={100} />
      <MaskSlider mask={mask} part="adjust" field="tint" label={t.adjust.tint} min={-100} max={100} />
      <MaskSlider mask={mask} part="adjust" field="saturation" label={t.adjust.saturation} min={-100} max={100} />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-on-surface-variant">{t.local.overlay}</span>
        <ColorSwatch value={a.color} label={t.local.color} onBegin={beginGesture} onChange={(color) => set({ color })} onEnd={endGesture} testId="mask-color" />
      </div>
      <SelectField label={t.local.mode} value={a.mode} options={MODE_OPTIONS} onChange={(mode) => set({ mode })} testId="mask-mode" />
      <MaskSlider mask={mask} part="adjust" field="opacity" label={t.local.opacity} min={0} max={100} format={formatPercent} />
      <mdui-button variant="text" onClick={() => set({ exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, opacity: 0 })} data-testid="mask-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.local.resetAdjust}
      </mdui-button>
    </Group>
  )
}
