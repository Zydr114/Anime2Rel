import { useCallback } from 'react'
import { TONE_KEYS, WHEEL_KEYS, type Tint } from '@/grade/model'
import { t } from '@/i18n'
import { useGradeUi } from '@/state/grade'
import { useApp } from '@/state/store'
import { ColorWheel } from '@/ui/ColorWheel'
import { Segmented } from '@/ui/Segmented'
import { SliderField } from '@/ui/SliderField'
import { useGestureChange } from '../useGestureChange'
import { Hint, Section } from './FusionSections'

const formatSigned = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)
const tintText = (tint: Tint) => (tint.amount > 0 ? t.style.tint(Math.round(tint.hue), Math.round(tint.amount * 100)) : t.style.noTint)
/** 有修改的选项后面加一个圆点 */
const marked = (label: string, changed: boolean) => (changed ? `${label} •` : label)

/** 全局调色（色彩风格）：色轮、分离色调 */
export function StyleSections() {
  return (
    <>
      <Hint>{t.style.hint}</Hint>
      <WheelsSection />
      <SplitSection />
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
