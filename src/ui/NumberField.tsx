import { useRef } from 'react'
import type { TextField } from 'mdui/components/text-field.js'
import { useDomEvent } from './useDomEvent'

interface Props {
  label: string
  value: number
  onCommit: (value: number) => void
  testId?: string
}

/** 数字输入框：失焦或回车时提交，非法输入恢复原值。 */
export function NumberField({ label, value, onCommit, testId }: Props) {
  // mdui 的 TextField 类型与新版 DOM 类型中的 autocorrect 定义冲突，这里按 HTMLElement 持有再转换
  const ref = useRef<HTMLElement>(null)
  useDomEvent(ref, 'change', (_e, host) => {
    const el = host as unknown as TextField
    const v = Number(el.value)
    if (Number.isFinite(v) && v !== value) onCommit(v)
    else el.value = String(value)
  })
  return <mdui-text-field ref={ref} label={label} type="number" variant="filled" value={String(value)} data-testid={testId} />
}
