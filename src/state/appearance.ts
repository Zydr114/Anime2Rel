import { create } from 'zustand'

const REDUCE_EFFECTS_KEY = 'a2r.ui.reduceEffects'
/** index.html 中的脚本在样式生效前读取同一个键，两处需要一致 */
export const THEME_KEY = 'a2r.ui.theme'

export type Theme = 'light' | 'dark'
/** 主题的选择：跟随系统、浅色、深色 */
export type ThemeChoice = 'system' | Theme
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

const systemDark = matchMedia('(prefers-color-scheme: dark)')

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式等情况下无法持久化，忽略
  }
}

function loadTheme(): ThemeChoice {
  const v = read(THEME_KEY)
  return THEME_CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system'
}

/** 界面外观的设置，保存在浏览器中。不参与撤销。 */
interface AppearanceState {
  /** 减少特效：玻璃面板改为不透明，不做折射和背景模糊 */
  reduceEffects: boolean
  theme: ThemeChoice
  /** 系统当前是否为深色 */
  systemDark: boolean
  setReduceEffects: (on: boolean) => void
  setTheme: (theme: ThemeChoice) => void
}

export const useAppearance = create<AppearanceState>()((set) => ({
  reduceEffects: read(REDUCE_EFFECTS_KEY) === '1',
  theme: loadTheme(),
  systemDark: systemDark.matches,
  setReduceEffects: (on) => {
    write(REDUCE_EFFECTS_KEY, on ? '1' : '0')
    set({ reduceEffects: on })
  },
  setTheme: (theme) => {
    write(THEME_KEY, theme)
    set({ theme })
  },
}))

systemDark.addEventListener('change', (e) => useAppearance.setState({ systemDark: e.matches }))

/** 实际使用的主题 */
export const resolveTheme = ({ theme, systemDark }: Pick<AppearanceState, 'theme' | 'systemDark'>): Theme => (theme === 'system' ? (systemDark ? 'dark' : 'light') : theme)

export const useTheme = (): Theme => useAppearance(resolveTheme)
