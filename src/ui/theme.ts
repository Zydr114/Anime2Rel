/**
 * 浅色 / 深色主题（docs/Plan.md §3.7 M8.7b）。在 <html> 上设置 mdui 的主题类和 data-theme，各处的主题色见 styles/index.css。
 * index.html 中的脚本在样式生效前按同样的规则先设置一次，避免打开页面时闪一下另一种颜色。
 */
import { resolveTheme, useAppearance, type Theme } from '@/state/appearance'

function apply(theme: Theme) {
  const root = document.documentElement
  root.classList.toggle('mdui-theme-dark', theme === 'dark')
  root.classList.toggle('mdui-theme-light', theme === 'light')
  root.dataset.theme = theme
}

/** 在渲染界面之前调用一次 */
export function startTheme(): void {
  apply(resolveTheme(useAppearance.getState()))
  useAppearance.subscribe((s) => apply(resolveTheme(s)))
}
