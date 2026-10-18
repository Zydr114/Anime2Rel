import { useCallback, useRef } from 'react'
import { CubeError, parseCube } from '@/grade/cube'
import { getLut, registerLut } from '@/grade/luts'
import { TONE_KEYS, WHEEL_KEYS, type Tint } from '@/grade/model'
import { t } from '@/i18n'
import { useGradeUi } from '@/state/grade'
import { useApp } from '@/state/store'
import { ColorWheel } from '@/ui/ColorWheel'
import { Segmented } from '@/ui/Segmented'
import { SliderField } from '@/ui/SliderField'
import { notify } from '../notify'
import { useGestureChange } from '../useGestureChange'
import { Hint, Section } from './FusionSections'

const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const formatPercent = (v: number) => `${Math.round(v)}%`
const tintText = (tint: Tint) => (tint.amount > 0 ? t.style.tint(Math.round(tint.hue), Math.round(tint.amount * 100)) : t.style.noTint)
/** 有修改的选项后面加一个圆点 */
const marked = (label: string, changed: boolean) => (changed ? `${label} •` : label)

/** 全局调色（色彩风格）：色轮、分离色调、LUT */
export function StyleSections() {
  return (
    <>
      <Hint>{t.style.hint}</Hint>
      <WheelsSection />
      <SplitSection />
      <LutSection />
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
