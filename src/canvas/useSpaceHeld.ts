import { useEffect, useState } from 'react'
import { isTypingTarget } from '@/app/keyboard'

/** 空格键是否按住（按住空格拖动可平移视图）。 */
export function useSpaceHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e)) return
      e.preventDefault()
      setHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setHeld(false)
    }
    const blur = () => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return held
}
