import { useEffect, useRef } from 'react'
import { useDomEvent } from './useDomEvent'

interface Props {
  /** sRGB 十六进制颜色 */
  value: string
  label: string
  /** 选色过程中连续调用；onBegin、onEnd 用于把一次选色合并为一次撤销记录 */
  onBegin: () => void
  onChange: (hex: string) => void
  onEnd: () => void
  testId?: string
}

/** 系统取色器。选色期间不回写外部的值，避免取色器跳动。 */
export function ColorSwatch({ value, label, onBegin, onChange, onEnd, testId }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el) el.value = value
  }, [value])
  useDomEvent(ref, 'input', (_e, el) => {
    onBegin()
    onChange(el.value)
  })
  useDomEvent(ref, 'change', onEnd)
  useDomEvent(ref, 'blur', onEnd)
  return (
    <input
      ref={ref}
      type="color"
      defaultValue={value}
      className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-white/15 bg-transparent p-0.5"
      aria-label={label}
      title={label}
      data-testid={testId}
    />
  )
}
