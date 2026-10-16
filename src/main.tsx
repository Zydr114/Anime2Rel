import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setColorScheme } from 'mdui/functions/setColorScheme.js'
import './styles/index.css'
import './ui/mdui'
import { App } from './app/App'

// M0 使用固定的暖橙色种子色；M6 改为从背景图提取。
setColorScheme('#e8875c')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
