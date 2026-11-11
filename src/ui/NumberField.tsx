import { useRef } from 'react'
import type { TextField } from 'mdui/components/text-field.js'
import { useDomEvent } from './useDomEvent'

interface Props {
  label: string
  value: number
  onCommit: (value: number) => void
  /** 步进。不传时沿用浏览器默认的 1，小数会被判为非法，微调也只走整数 */
  step?: number
  min?: number
  max?: number
  testId?: string
}

/** 对齐到 step，并按步长的小数位数去掉二进制误差 */
function alignToStep(value: number, step: number): number {
  const places = Math.max(0, (String(step).split('.')[1] ?? '').length)
  return Number((Math.round(value / step) * step).toFixed(places))
}

/**
 * 数字输入框：失焦或回车时提交，非法或超出范围时恢复原值。
 * 输入过程中不回写，否则浏览器会把尚未完成的 “1.” 收成 “1”，小数点被吃掉。
 */
export function NumberField({ label, value, onCommit, step, min, max, testId }: Props) {
  const ref = useRef<HTMLElement>(null)
  useDomEvent(ref, 'change', (_e, host) => {
    const el = host as unknown as TextField
    const raw = Number(el.value)
    const v = Number.isFinite(raw) && step ? alignToStep(raw, step) : raw
    const inRange = Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)
    if (inRange && v !== value) onCommit(v)
    else el.value = String(value)
  })
  return (
    <mdui-text-field
      ref={ref}
      label={label}
      type="number"
      variant="filled"
      value={String(value)}
      step={step}
      min={min}
      max={max}
      inputmode={step !== undefined && step < 1 ? 'decimal' : undefined}
      data-testid={testId}
    />
  )
}
