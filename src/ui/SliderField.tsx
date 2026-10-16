import { useEffect, useRef } from 'react'
import type { Slider } from 'mdui/components/slider.js'
import { useDomEvent } from './useDomEvent'

interface Props {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 数值显示格式 */
  format?: (v: number) => string
  /** 拖动过程中持续调用，phase 为 end 表示松手（用于合并撤销记录） */
  onChange: (value: number, phase: 'input' | 'end') => void
  testId?: string
}

/** 带标签和数值显示的 mdui 滑块。 */
export function SliderField({ label, value, min, max, step = 1, format = (v) => String(v), onChange, testId }: Props) {
  const ref = useRef<Slider>(null)

  useEffect(() => {
    if (ref.current) ref.current.labelFormatter = format
  }, [format])

  useDomEvent(ref, 'input', (_e, el) => onChange(el.value, 'input'))
  useDomEvent(ref, 'change', (_e, el) => onChange(el.value, 'end'))

  return (
    <label className="block">
      <div className="flex items-baseline justify-between px-1 text-sm">
        <span className="text-on-surface-variant">{label}</span>
        <span className="font-medium tabular-nums">{format(value)}</span>
      </div>
      <mdui-slider ref={ref} value={value} min={min} max={max} step={step} nolabel data-testid={testId} />
    </label>
  )
}
