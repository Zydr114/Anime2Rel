import { useCallback } from 'react'
import { useApp } from '@/state/store'

/** 滑块拖动期间合并为一次撤销记录。 */
export function useGestureChange<T>(apply: (v: T) => void) {
  return useCallback(
    (v: T, phase: 'input' | 'end') => {
      const s = useApp.getState()
      if (phase === 'input') s.beginGesture()
      apply(v)
      if (phase === 'end') useApp.getState().endGesture()
    },
    [apply],
  )
}
