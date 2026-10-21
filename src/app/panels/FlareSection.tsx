import { useCallback, useState } from 'react'
import {
  FLARE_ELEMENT_TYPES,
  FLARE_PRESET_IDS,
  FOLLOW_APERTURE,
  GHOST_SIDES,
  MAX_FLARE_ELEMENTS,
  flarePreset,
  flareScale,
  sameFlareElements,
  type FlareDoc,
  type FlareElement,
  type FlareElementType,
  type FlarePresetId,
} from '@/grade/flare'
import { flareFade, raysLight } from '@/grade/post'
import { t } from '@/i18n'
import { useFlares } from '@/state/flares'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { cn } from '@/ui/lib/cn'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { lightName } from '../lightName'
import { askText, notify } from '../notify'
import { useGestureChange } from '../useGestureChange'
import { Group, Help, Hint, More } from './Group'
import { PresetItem } from './PresetSections'

const f = t.effects.flare
const AUTO = 'auto'
const formatSize = (v: number) => `${+v.toFixed(1)}%`
const formatPercent = (v: number) => `${+v.toFixed(1)}%`
/** 内置光晕的元素，用于比较当前元素是否来自某个预设 */
const BUILTIN = Object.fromEntries(FLARE_PRESET_IDS.map((id) => [id, flarePreset(id)])) as Record<FlarePresetId, FlareElement[]>
const SIDES_OPTIONS = GHOST_SIDES.map((n) => ({ value: String(n), label: n === FOLLOW_APERTURE ? f.sidesFollow : n === 0 ? f.sidesCircle : f.sidesN(n) }))
/** 有旋转参数的元素（圆形鬼影旋转没有意义） */
const rotates = (e: FlareElement) => e.type === 'streaks' || e.type === 'anamorphic' || e.type === 'sparkles' || (e.type === 'ghost' && e.sides !== 0)

const updateFlare = (update: Partial<Omit<FlareDoc, 'elements'>>) => useApp.getState().updatePost('flare', update)

/** 整体参数的滑块：显示值 = 参数 × 100，拖动期间合并为一次撤销记录 */
function FlareSlider({ field, label, format }: { field: 'intensity' | 'size'; label: string; format: (v: number) => string }) {
  const value = useApp((s) => s.doc.post.flare[field])
  const onChange = useGestureChange(useCallback((v: number) => updateFlare({ [field]: v / 100 }), [field]))
  return <SliderField label={label} value={value * 100} min={0} max={100} format={format} onChange={onChange} testId={`post-flare-${field}`} />
}

async function saveCustom() {
  const name = (await askText(f.saveName, f.defaultName, f.saveConfirm, f.saveCancel))?.trim()
  if (!name) return
  useFlares.getState().add({ name, elements: useApp.getState().doc.post.flare.elements })
  notify(f.saved(name))
}

/** 镜头光晕：开关、整体参数、光源、预设和元素编辑器（docs/Plan.md §3.7 M8.2） */
export function FlareSection() {
  const flare = useApp((s) => s.doc.post.flare)
  const lighting = useApp((s) => s.doc.lighting)
  const fovDeg = useApp((s) => s.doc.camera.fovDeg)
  const background = useApp((s) => s.doc.background)
  const custom = useFlares((s) => s.custom)
  const [selectedId, select] = useState<string | null>(null)
  const used = background ? raysLight(lighting, flare.light, background, fovDeg) : null
  const auto = background ? raysLight(lighting, null, background, fovDeg) : null
  const lightOptions = [
    { value: AUTO, label: t.effects.raysAuto(auto ? lightName(lighting.lights, auto.light) : null) },
    ...lighting.lights.map((l) => ({ value: l.id, label: lightName(lighting.lights, l) })),
  ]
  const light = flare.light !== null && lighting.lights.some((l) => l.id === flare.light) ? flare.light : AUTO
  const { elements } = flare
  // 选中的元素被删除或换掉（套用预设、撤销）时改为选中第一个
  const element = elements.find((e) => e.id === selectedId) ?? elements[0] ?? null
  const index = element ? elements.indexOf(element) : -1
  const full = elements.length >= MAX_FLARE_ELEMENTS
  const { setFlareElements } = useApp.getState()
  const preset = FLARE_PRESET_IDS.find((id) => sameFlareElements(elements, BUILTIN[id]))
  const customPreset = custom.find((c) => sameFlareElements(elements, c.elements))
  return (
    <Group
      id="post.flare"
      title={f.title}
      summary={flare.enabled ? (preset ? f.presetNames[preset] : (customPreset?.name ?? f.custom)) : t.effects.off}
      help={[f.hint, f.customHint]}
      toggle={{ checked: flare.enabled, onChange: (enabled) => updateFlare({ enabled }), testId: 'post-flare-enabled' }}
      testId="post-flare"
    >
      {flare.enabled && (!used ? <Hint warn>{t.effects.raysNoLight}</Hint> : background && flareFade(used.uv, background) === 0 && <Hint warn>{f.far}</Hint>)}
      <FlareSlider field="intensity" label={f.intensity} format={(v) => `${Math.round(v)}%`} />
      <FlareSlider field="size" label={f.size} format={(v) => `${Math.round(flareScale(v / 100) * 100)}%`} />
      <SelectField label={f.light} value={light} options={lightOptions} onChange={(v) => updateFlare({ light: v === AUTO ? null : v })} testId="post-flare-light" />

      <h4 className="mt-1 font-medium">{f.presets}</h4>
      {FLARE_PRESET_IDS.map((id) => (
        <PresetItem
          key={id}
          name={f.presetNames[id]}
          description={f.presetDescriptions[id]}
          active={flare.enabled && sameFlareElements(elements, BUILTIN[id])}
          onClick={() => setFlareElements(BUILTIN[id])}
          testId={`flare-preset-${id}`}
        />
      ))}
      {custom.map((c, i) => (
        <div key={c.name} className="flex items-center gap-1">
          <div className="flex flex-1 flex-col">
            <PresetItem name={c.name} active={flare.enabled && sameFlareElements(elements, c.elements)} onClick={() => setFlareElements(c.elements)} testId={`flare-custom-${i}`} />
          </div>
          <mdui-button-icon onClick={() => useFlares.getState().remove(c.name)} aria-label={f.remove(c.name)} data-testid={`flare-custom-${i}-remove`}>
            <mdui-icon-delete--outlined />
          </mdui-button-icon>
        </div>
      ))}
      <More id="post.flare.more">
        <FlareElements elements={elements} element={element} index={index} full={full} select={select} />
      </More>
    </Group>
  )
}

/** 光晕元素的列表与编辑器 */
function FlareElements({ elements, element, index, full, select }: { elements: FlareElement[]; element: FlareElement | null; index: number; full: boolean; select: (id: string | null) => void }) {
  const { addFlareElement, duplicateFlareElement, moveFlareElement, removeFlareElement } = useApp.getState()
  return (
    <>
      <mdui-button variant="tonal" disabled={elements.length === 0 || undefined} onClick={() => void saveCustom()} data-testid="flare-save">
        <mdui-icon-save--outlined slot="icon" />
        {f.save}
      </mdui-button>

      <div className="mt-1 flex items-center gap-1">
        <h4 className="font-medium">{f.elements}</h4>
        <Help title={f.elements} text={[f.elementsHint(MAX_FLARE_ELEMENTS), f.positionHint]} />
        <span className="flex-1" />
        <mdui-button-icon disabled={!element || full || undefined} onClick={() => element && select(duplicateFlareElement(element.id))} aria-label={f.duplicate} data-testid="flare-duplicate">
          <mdui-icon-content-copy--outlined />
        </mdui-button-icon>
        <mdui-button-icon disabled={index <= 0 || undefined} onClick={() => element && moveFlareElement(element.id, -1)} aria-label={f.up} data-testid="flare-up">
          <mdui-icon-arrow-upward--outlined />
        </mdui-button-icon>
        <mdui-button-icon disabled={index < 0 || index >= elements.length - 1 || undefined} onClick={() => element && moveFlareElement(element.id, 1)} aria-label={f.down} data-testid="flare-down">
          <mdui-icon-arrow-downward--outlined />
        </mdui-button-icon>
        <mdui-button-icon
          disabled={!element || undefined}
          onClick={() => {
            if (!element) return
            select((elements[index + 1] ?? elements[index - 1])?.id ?? null)
            removeFlareElement(element.id)
          }}
          aria-label={f.delete}
          data-testid="flare-remove"
        >
          <mdui-icon-delete--outlined />
        </mdui-button-icon>
      </div>
      {elements.length === 0 ? (
        <Hint>{f.empty}</Hint>
      ) : (
        <div className="flex flex-col gap-1" data-testid="flare-elements">
          {elements.map((e, i) => (
            <button
              key={e.id}
              type="button"
              className={cn('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors', e === element ? 'bg-primary/20' : 'bg-white/5 hover:bg-white/10')}
              onClick={() => select(e.id)}
              aria-pressed={e === element}
              data-testid={`flare-element-${i}`}
              data-type={e.type}
            >
              <span
                className="size-3 shrink-0 rounded-full ring-1 ring-white/30"
                style={{ background: e.type === 'rainbow' ? 'conic-gradient(#f44, #fd4, #4f4, #4ff, #44f, #f4f, #f44)' : e.color }}
              />
              <span className="flex-1">{f.types[e.type]}</span>
              <span className="text-xs text-on-surface-variant">{f.summary(e.position.toFixed(2), formatSize(e.size * 100))}</span>
            </button>
          ))}
        </div>
      )}
      <AddElementMenu
        disabled={full}
        onAdd={(type) => {
          const id = addFlareElement(type)
          if (id) select(id)
        }}
      />
      {element && <ElementEditor key={element.id} element={element} />}
    </>
  )
}

function AddElementMenu({ disabled, onAdd }: { disabled: boolean; onAdd: (type: FlareElementType) => void }) {
  return (
    <mdui-dropdown disabled={disabled || undefined}>
      <mdui-button slot="trigger" variant="tonal" full-width disabled={disabled || undefined} data-testid="flare-add">
        <mdui-icon-add--outlined slot="icon" />
        {f.add}
      </mdui-button>
      <mdui-menu data-testid="flare-add-menu">
        {FLARE_ELEMENT_TYPES.map((type) => (
          <mdui-menu-item key={type} onClick={() => onAdd(type)} data-testid={`flare-add-${type}`}>
            {f.types[type]}
          </mdui-menu-item>
        ))}
      </mdui-menu>
    </mdui-dropdown>
  )
}

/** 选中元素的参数：只显示该类型用到的字段 */
function ElementEditor({ element }: { element: FlareElement }) {
  const { id, type } = element
  const update = useCallback((u: Partial<Omit<FlareElement, 'id'>>) => useApp.getState().updateFlareElement(id, u), [id])
  const onPosition = useGestureChange(useCallback((v: number) => update({ position: v / 100 }), [update]))
  const onSize = useGestureChange(useCallback((v: number) => update({ size: v / 100 }), [update]))
  const onIntensity = useGestureChange(useCallback((v: number) => update({ intensity: v / 100 }), [update]))
  const onSoftness = useGestureChange(useCallback((v: number) => update({ softness: v / 100 }), [update]))
  const onDispersion = useGestureChange(useCallback((v: number) => update({ dispersion: v / 100 }), [update]))
  const onRotation = useGestureChange(useCallback((rotation: number) => update({ rotation }), [update]))
  const onCount = useGestureChange(useCallback((count: number) => update({ count }), [update]))
  const { beginGesture, endGesture } = useApp.getState()
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white/5 p-2.5" data-testid="flare-editor" data-type={type}>
      <div className="flex items-center gap-1">
        <span className="font-medium">{f.types[type]}</span>
        <Help title={f.types[type]} text={f.typeHints[type]} />
      </div>
      <SliderField label={f.position} value={element.position * 100} min={-100} max={300} format={(v) => (v / 100).toFixed(2)} onChange={onPosition} testId="flare-position" />
      <SliderField label={f.elementSize} value={element.size * 100} min={0} max={100} step={0.5} format={formatSize} onChange={onSize} testId="flare-size" />
      <SliderField label={f.elementIntensity} value={element.intensity * 100} min={0} max={100} step={0.5} format={formatPercent} onChange={onIntensity} testId="flare-intensity" />
      <SliderField label={f.softness} value={element.softness * 100} min={0} max={100} format={(v) => `${Math.round(v)}%`} onChange={onSoftness} testId="flare-softness" />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-on-surface-variant">{f.color}</span>
        <ColorSwatch value={element.color} label={f.color} onBegin={beginGesture} onChange={(color) => update({ color })} onEnd={endGesture} testId="flare-color" />
      </div>
      {type === 'ghost' && <SelectField label={f.sides} value={String(element.sides)} options={SIDES_OPTIONS} onChange={(v) => update({ sides: Number(v) })} testId="flare-sides" />}
      {rotates(element) && <SliderField label={f.rotation} value={element.rotation} min={0} max={359} format={(v) => `${Math.round(v)}°`} onChange={onRotation} testId="flare-rotation" />}
      {type === 'rainbow' && <SliderField label={f.dispersion} value={element.dispersion * 100} min={0} max={100} format={(v) => `${Math.round(v)}%`} onChange={onDispersion} testId="flare-dispersion" />}
      {(type === 'streaks' || type === 'sparkles') && (
        <>
          <SliderField label={type === 'streaks' ? f.rays : f.count} value={element.count} min={2} max={32} onChange={onCount} testId="flare-count" />
          <mdui-button variant="text" onClick={() => update({ seed: Math.floor(Math.random() * 10000) })} data-testid="flare-reseed">
            <mdui-icon-refresh--outlined slot="icon" />
            {f.reseed}
          </mdui-button>
        </>
      )}
    </div>
  )
}
