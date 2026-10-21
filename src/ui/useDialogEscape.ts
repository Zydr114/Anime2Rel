import { useEffect, type RefObject } from 'react'
import type { Dropdown } from 'mdui/components/dropdown.js'

/**
 * 对话框的 Esc：mdui 只在焦点位于对话框内时响应，这里在窗口级补充处理。
 * 对话框中的下拉框打开时只关闭下拉框（否则对话框会先收到按键，连同自己一起关闭）。
 */
export function useDialogEscape(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const menus = [...(ref.current?.querySelectorAll('mdui-select') ?? [])]
        .map((s) => s.shadowRoot?.querySelector<Dropdown>('mdui-dropdown'))
        .filter((d) => d?.open)
      if (!menus.length) return onClose()
      e.stopPropagation()
      for (const d of menus) d!.open = false
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ref, open, onClose])
}
