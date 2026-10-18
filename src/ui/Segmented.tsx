import { useRef } from 'react'
import type { SegmentedButtonGroup } from 'mdui/components/segmented-button-group.js'
import { useDomEvent } from './useDomEvent'

/** 单选分段按钮；再次点击已选项会取消选中，此时恢复原值 */
export function Segmented<T extends string>({ value, options, label, onChange, testId }: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void; testId: string }) {
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
