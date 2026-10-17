import { useEffect, useRef, type ReactNode } from 'react'
import type { Tooltip } from 'mdui/components/tooltip.js'
import { cn } from './lib/cn'
import { useDomEvent } from './useDomEvent'

interface Props {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  className?: string
  testId?: string
  /** 为 true 时不显示悬浮提示（例如按钮打开的菜单会被提示遮挡时） */
  tooltipDisabled?: boolean
  /** 开关类按钮的按下状态 */
  pressed?: boolean
}

/** 带悬浮提示的图标按钮。图标尺寸随容器缩放，可放进 Dock。 */
export function IconButton({ label, onClick, disabled, children, className, testId, tooltipDisabled, pressed }: Props) {
  const tooltipRef = useRef<Tooltip>(null)
  // 禁用不会收起已显示的提示，也拦不住禁用前已开始计时的悬停，因此手动关闭并取消之后的打开
  useEffect(() => {
    if (tooltipDisabled && tooltipRef.current) tooltipRef.current.open = false
  }, [tooltipDisabled])
  useDomEvent(tooltipRef, 'open', (e, el) => {
    if (!tooltipDisabled || e.target !== el) return
    e.preventDefault()
    queueMicrotask(() => (el.open = false))
  })

  return (
    <mdui-tooltip ref={tooltipRef} content={label} placement="top" disabled={tooltipDisabled}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
        className={cn(
          'flex size-full cursor-pointer items-center justify-center rounded-full text-on-surface transition-colors',
          'hover:bg-white/10 active:bg-white/15 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent',
          '[&>*]:size-[55%]',
          className,
        )}
      >
        {children}
      </button>
    </mdui-tooltip>
  )
}
