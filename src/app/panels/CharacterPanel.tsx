import { useCallback, useRef } from 'react'
import { useGestureChange } from '../useGestureChange'
import type { Switch } from 'mdui/components/switch.js'
import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { SliderField } from '@/ui/SliderField'
import { NumberField } from '@/ui/NumberField'
import { useDomEvent } from '@/ui/useDomEvent'
import { FusionSections } from './FusionSections'

const RAD = Math.PI / 180

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatDegrees = (v: number) => `${v.toFixed(1)}°`

export function CharacterPanel() {
  const character = useApp((s) => s.doc.character)
  const tr = useApp((s) => s.doc.charTransform)
  const setCharTransform = useApp((s) => s.setCharTransform)
  const resetCharTransform = useApp((s) => s.resetCharTransform)

  const onScale = useGestureChange(useCallback((v: number) => setCharTransform({ scale: Math.max(0.005, v / 100) }), [setCharTransform]))
  const onRotation = useGestureChange(useCallback((v: number) => setCharTransform({ rotation: v * RAD }), [setCharTransform]))

  if (!character) return <p className="px-1 text-sm text-on-surface-variant">{t.character.noCharacter}</p>

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
        <h3 className="text-sm font-medium">{t.character.transform}</h3>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label={t.character.x} value={Math.round(tr.x)} onCommit={(x) => setCharTransform({ x })} testId="char-x" />
          <NumberField label={t.character.y} value={Math.round(tr.y)} onCommit={(y) => setCharTransform({ y })} testId="char-y" />
        </div>
        <SliderField label={t.character.scale} value={tr.scale * 100} min={1} max={300} step={0.5} format={formatPercent} onChange={onScale} testId="char-scale" />
        <SliderField label={t.character.rotation} value={tr.rotation / RAD} min={-180} max={180} step={0.5} format={formatDegrees} onChange={onRotation} testId="char-rotation" />
        <div className="flex items-center justify-between">
          <span className="text-sm">{t.character.flip}</span>
          <FlipSwitch checked={tr.flipX} onChange={(flipX) => setCharTransform({ flipX })} />
        </div>
        <mdui-button variant="outlined" onClick={resetCharTransform}>
          <mdui-icon-restart-alt--outlined slot="icon" />
          {t.character.reset}
        </mdui-button>
        <p className="text-xs leading-5 text-on-surface-variant">{t.character.gizmoHint}</p>
      </section>
      <FusionSections />
    </div>
  )
}

function FlipSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<Switch>(null)
  useDomEvent(ref, 'change', (_e, el) => onChange(el.checked))
  return <mdui-switch ref={ref} checked={checked} data-testid="char-flip" />
}
