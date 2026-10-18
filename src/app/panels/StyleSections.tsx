import { useCallback, useRef } from 'react'
import { CubeError, parseCube } from '@/grade/cube'
import { getLut, registerLut } from '@/grade/luts'
import {
  BLEND_MODES,
  MAX_BLEND_LAYERS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  TONE_KEYS,
  WHEEL_KEYS,
  type BlendKind,
  type BlendLayer,
  type Tint,
} from '@/grade/model'
import { t } from '@/i18n'
import { useGradeUi } from '@/state/grade'
import { useApp } from '@/state/store'
import { ColorSwatch } from '@/ui/ColorSwatch'
import { ColorWheel } from '@/ui/ColorWheel'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { notify } from '../notify'
import { useGestureChange } from '../useGestureChange'
import { Hint, Section } from './FusionSections'

const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const formatPercent = (v: number) => `${Math.round(v)}%`
const tintText = (tint: Tint) => (tint.amount > 0 ? t.style.tint(Math.round(tint.hue), Math.round(tint.amount * 100)) : t.style.noTint)
/** 有修改的选项后面加一个圆点 */
const marked = (label: string, changed: boolean) => (changed ? `${label} •` : label)

/** 全局调色（色彩风格）：色轮、分离色调、LUT、混色层 */
export function StyleSections() {
  return (
    <>
      <Hint>{t.style.hint}</Hint>
      <WheelsSection />
      <SplitSection />
      <LutSection />
      <BlendSection />
      <mdui-button variant="text" onClick={() => useApp.getState().resetCreative()} data-testid="style-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.style.reset}
      </mdui-button>
    </>
  )
}

function WheelsSection() {
  const key = useGradeUi((s) => s.wheel)
  const wheels = useApp((s) => s.doc.grade.creative.wheels)
  const wheel = wheels[key]
  const onLuma = useGestureChange(useCallback((v: number) => useApp.getState().updateWheel(useGradeUi.getState().wheel, { luma: v / 100 }), []))
  const { beginGesture, endGesture } = useApp.getState()
  return (
    <Section title={t.style.wheels} testId="style-wheels">
      <Segmented
        value={key}
        options={WHEEL_KEYS}
        label={(k) => marked(t.style.wheelKeys[k], wheels[k].amount !== 0 || wheels[k].luma !== 0)}
        onChange={useGradeUi.getState().setWheel}
        testId="wheel-key"
      />
      <ColorWheel
        hue={wheel.hue}
        amount={wheel.amount}
        onBegin={beginGesture}
        onChange={(hue, amount) => useApp.getState().updateWheel(useGradeUi.getState().wheel, { hue, amount })}
        onEnd={endGesture}
        testId="wheel-pad"
      />
      <p className="text-center text-xs text-on-surface-variant tabular-nums">{tintText(wheel)}</p>
      <SliderField label={t.style.luma} value={wheel.luma * 100} min={-100} max={100} format={formatSigned} onChange={onLuma} testId="wheel-luma" />
      <Hint>{t.style.wheelHint}</Hint>
    </Section>
  )
}

function SplitSection() {
  const key = useGradeUi((s) => s.tone)
  const split = useApp((s) => s.doc.grade.creative.split)
  const tint = split[key]
  const onBalance = useGestureChange(useCallback((v: number) => useApp.getState().updateSplit({ balance: v / 100 }), []))
  const { beginGesture, endGesture } = useApp.getState()
  return (
    <Section title={t.style.split} testId="style-split">
      <Segmented value={key} options={TONE_KEYS} label={(k) => marked(t.style.tones[k], split[k].amount !== 0)} onChange={useGradeUi.getState().setTone} testId="split-tone" />
      <ColorWheel
        hue={tint.hue}
        amount={tint.amount}
        onBegin={beginGesture}
        onChange={(hue, amount) => useApp.getState().updateSplit({ [useGradeUi.getState().tone]: { hue, amount } })}
        onEnd={endGesture}
        testId="split-pad"
      />
      <p className="text-center text-xs text-on-surface-variant tabular-nums">{tintText(tint)}</p>
      <SliderField label={t.style.balance} value={split.balance * 100} min={-100} max={100} format={formatSigned} onChange={onBalance} testId="split-balance" />
    </Section>
  )
}

async function importLut(file: File) {
  try {
    const ref = registerLut(parseCube(await file.text()), file.name)
    useApp.getState().updateCreative({ lut: ref, lutIntensity: 1 })
  } catch (e) {
    if (!(e instanceof CubeError)) console.error(e)
    notify(t.style.lutError(file.name, e instanceof CubeError ? e.message : t.style.lutUnreadable))
  }
}

function LutSection() {
  const lut = useApp((s) => s.doc.grade.creative.lut)
  const intensity = useApp((s) => s.doc.grade.creative.lutIntensity)
  const inputRef = useRef<HTMLInputElement>(null)
  const onIntensity = useGestureChange(useCallback((v: number) => useApp.getState().updateCreative({ lutIntensity: v / 100 }), []))
  return (
    <Section title={t.style.lut} testId="style-lut">
      {lut && (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={lut.name} data-testid="lut-name">
              {lut.name}
            </span>
            <mdui-button-icon onClick={() => useApp.getState().updateCreative({ lut: null })} aria-label={t.style.lutRemove} data-testid="lut-remove">
              <mdui-icon-close--outlined />
            </mdui-button-icon>
          </div>
          {!getLut(lut.id) && <Hint>{t.style.lutMissing}</Hint>}
          <SliderField label={t.style.lutIntensity} value={intensity * 100} min={0} max={100} format={formatPercent} onChange={onIntensity} testId="lut-intensity" />
        </>
      )}
      <mdui-button variant="tonal" onClick={() => inputRef.current?.click()} data-testid="lut-import">
        <mdui-icon-upload--outlined slot="icon" />
        {lut ? t.style.lutReplace : t.style.lutImport}
      </mdui-button>
      <input
        ref={inputRef}
        type="file"
        accept=".cube"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (file) void importLut(file)
        }}
        data-testid="lut-file"
      />
      <Hint>{t.style.lutHint}</Hint>
    </Section>
  )
}

const BLEND_KINDS: readonly BlendKind[] = ['color', 'gradient']
const MODE_OPTIONS = BLEND_MODES.map((value) => ({ value, label: t.style.modes[value] }))

const currentLayer = (id: string) => useApp.getState().doc.grade.creative.layers.find((l) => l.id === id)

function BlendSection() {
  const layers = useApp((s) => s.doc.grade.creative.layers)
  return (
    <Section title={t.style.blend} testId="style-blend">
      {/* 与图层面板的习惯一致：最上面的层排在最前 */}
      {[...layers].reverse().map((layer, i) => (
        <BlendLayerCard key={layer.id} layer={layer} index={layers.length - 1 - i} count={layers.length} />
      ))}
      <mdui-button variant="tonal" disabled={layers.length >= MAX_BLEND_LAYERS || undefined} onClick={() => useApp.getState().addBlendLayer()} data-testid="blend-add">
        <mdui-icon-add--outlined slot="icon" />
        {t.style.blendAdd}
      </mdui-button>
      <Hint>{layers.length >= MAX_BLEND_LAYERS ? t.style.blendLimit(MAX_BLEND_LAYERS) : t.style.blendHint}</Hint>
    </Section>
  )
}

function BlendLayerCard({ layer, index, count }: { layer: BlendLayer; index: number; count: number }) {
  const { id } = layer
  const update = useCallback((u: Partial<Omit<BlendLayer, 'id'>>) => useApp.getState().updateBlendLayer(id, u), [id])
  const onOpacity = useGestureChange(useCallback((v: number) => update({ opacity: v / 100 }), [update]))
  // 下限不超过上限
  const onLow = useGestureChange(useCallback((v: number) => update({ maskLow: Math.min(v / 100, currentLayer(id)?.maskHigh ?? 1) }), [id, update]))
  const onHigh = useGestureChange(useCallback((v: number) => update({ maskHigh: Math.max(v / 100, currentLayer(id)?.maskLow ?? 0) }), [id, update]))
  const { beginGesture, endGesture, moveBlendLayer, removeBlendLayer } = useApp.getState()
  const setStop = (k: number, hex: string) => update({ gradient: (currentLayer(id)?.gradient ?? layer.gradient).map((c, j) => (j === k ? hex : c)) })
  const testId = (name: string) => `blend-${index}-${name}`
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white/5 p-2.5" data-testid={`blend-layer-${index}`}>
      <div className="flex items-center gap-1">
        <span className="flex-1 font-medium">{t.style.blendLayer(index + 1)}</span>
        <mdui-button-icon disabled={index >= count - 1 || undefined} onClick={() => moveBlendLayer(id, 1)} aria-label={t.style.blendUp} data-testid={testId('up')}>
          <mdui-icon-arrow-upward--outlined />
        </mdui-button-icon>
        <mdui-button-icon disabled={index <= 0 || undefined} onClick={() => moveBlendLayer(id, -1)} aria-label={t.style.blendDown} data-testid={testId('down')}>
          <mdui-icon-arrow-downward--outlined />
        </mdui-button-icon>
        <mdui-button-icon onClick={() => removeBlendLayer(id)} aria-label={t.style.blendRemove} data-testid={testId('remove')}>
          <mdui-icon-delete--outlined />
        </mdui-button-icon>
      </div>
      <Segmented value={layer.kind} options={BLEND_KINDS} label={(k) => t.style.kinds[k]} onChange={(kind) => update({ kind })} testId={testId('kind')} />
      {layer.kind === 'color' ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-on-surface-variant">{t.style.blendColor}</span>
          <ColorSwatch value={layer.color} label={t.style.blendColor} onBegin={beginGesture} onChange={(color) => update({ color })} onEnd={endGesture} testId={testId('color')} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="h-3 rounded-full ring-1 ring-white/15" style={{ background: `linear-gradient(to right, ${layer.gradient.join(', ')})` }} />
          <div className="flex items-center gap-2">
            {layer.gradient.map((c, k) => (
              <ColorSwatch key={k} value={c} label={t.style.gradientStop(k, layer.gradient.length)} onBegin={beginGesture} onChange={(hex) => setStop(k, hex)} onEnd={endGesture} testId={testId(`stop-${k}`)} />
            ))}
            <span className="flex-1" />
            {layer.gradient.length < MAX_GRADIENT_STOPS ? (
              <mdui-button variant="text" onClick={() => update({ gradient: [layer.gradient[0], mixHex(layer.gradient[0], layer.gradient[1]), layer.gradient[1]] })} data-testid={testId('add-stop')}>
                {t.style.gradientAddMid}
              </mdui-button>
            ) : (
              layer.gradient.length > MIN_GRADIENT_STOPS && (
                <mdui-button variant="text" onClick={() => update({ gradient: [layer.gradient[0], layer.gradient[layer.gradient.length - 1]] })} data-testid={testId('remove-stop')}>
                  {t.style.gradientRemoveMid}
                </mdui-button>
              )
            )}
          </div>
        </div>
      )}
      <SelectField label={t.style.blendMode} value={layer.mode} options={MODE_OPTIONS} onChange={(mode) => update({ mode })} testId={testId('mode')} />
      <SliderField label={t.style.opacity} value={layer.opacity * 100} min={0} max={100} format={formatPercent} onChange={onOpacity} testId={testId('opacity')} />
      <SliderField label={t.style.maskLow} value={layer.maskLow * 100} min={0} max={100} format={formatPercent} onChange={onLow} testId={testId('mask-low')} />
      <SliderField label={t.style.maskHigh} value={layer.maskHigh * 100} min={0} max={100} format={formatPercent} onChange={onHigh} testId={testId('mask-high')} />
    </div>
  )
}

/** 两个十六进制颜色的中间色 */
function mixHex(a: string, b: string): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const c = [16, 8, 0].map((shift) => Math.round((((pa >> shift) & 255) + ((pb >> shift) & 255)) / 2))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
