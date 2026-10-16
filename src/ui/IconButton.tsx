import type { ReactNode } from 'react'
import { cn } from './lib/cn'

interface Props {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  className?: string
  testId?: string
}

/** 带悬浮提示的图标按钮。图标尺寸随容器缩放，可放进 Dock。 */
export function IconButton({ label, onClick, disabled, children, className, testId }: Props) {
  return (
    <mdui-tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
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
