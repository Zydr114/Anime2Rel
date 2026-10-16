// 会接收文字输入的 input 类型；复选框、单选框、滑块等不算，快捷键（如按住空格平移）照常生效
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'password', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

/** 键盘事件是否来自文本输入控件（包括 mdui 组件内部的 input）。 */
export function isTypingTarget(e: Event): boolean {
  return e.composedPath().some((n) => {
    if (!(n instanceof HTMLElement)) return false
    if (n instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(n.type)
    return n.isContentEditable || n.tagName === 'TEXTAREA' || n.tagName === 'MDUI-TEXT-FIELD'
  })
}
