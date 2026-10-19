import { useRef } from 'react'
import { useDomEvent } from './useDomEvent'

interface Props<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  testId?: string
}

/** mdui 下拉选择框（单选）。 */
export function SelectField<T extends string>({ label, value, options, onChange, testId }: Props<T>) {
  // 与 NumberField 相同，按 HTMLElement 持有以避开 mdui 类型和 DOM 类型的冲突
  const ref = useRef<HTMLElement>(null)
  useDomEvent(ref, 'change', (_e, el) => {
    const v = (el as HTMLElement & { value: string }).value as T
    // 必选项：mdui 允许再次点击取消选中，这里恢复原值
    if (v) onChange(v)
    else (el as HTMLElement & { value: string }).value = value
  })
  return (
    <mdui-select ref={ref} label={label} value={value} variant="filled" data-testid={testId}>
      {options.map((o) => (
        <mdui-menu-item key={o.value} value={o.value}>
          {o.label}
        </mdui-menu-item>
      ))}
    </mdui-select>
  )
}
