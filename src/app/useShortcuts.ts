import { useEffect } from 'react'
import { useApp } from '@/state/store'
import { isTypingTarget } from './keyboard'
import { zoomBy, zoomToActual } from './viewActions'

/** 编辑器快捷键。输入框内不响应。 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return
      const s = useApp.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        s.redo()
        return
      }
      if (mod || e.altKey) return

      if (key === 'f') s.fitToView()
      else if (key === '1') zoomToActual()
      else if (key === '+' || key === '=') zoomBy(1.25)
      else if (key === '-') zoomBy(1 / 1.25)
      else if (key === 'h' && s.doc.character) s.setCharTransform({ flipX: !s.doc.charTransform.flipX })
      else if (key.startsWith('arrow') && s.doc.character && (s.step === 'assets' || s.step === 'character')) {
        e.preventDefault()
        const d = e.shiftKey ? 10 : 1
        const t = s.doc.charTransform
        if (key === 'arrowleft') s.setCharTransform({ x: t.x - d })
        if (key === 'arrowright') s.setCharTransform({ x: t.x + d })
        if (key === 'arrowup') s.setCharTransform({ y: t.y - d })
        if (key === 'arrowdown') s.setCharTransform({ y: t.y + d })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
