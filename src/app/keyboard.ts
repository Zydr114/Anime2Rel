/** 键盘事件是否来自文本输入控件（包括 mdui 组件内部的 input）。 */
export function isTypingTarget(e: Event): boolean {
  return e.composedPath().some((n) => {
    if (!(n instanceof HTMLElement)) return false
    return n.isContentEditable || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'MDUI-TEXT-FIELD'
  })
}
