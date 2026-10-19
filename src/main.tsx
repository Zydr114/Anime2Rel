import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import './ui/mdui'
import { App } from './app/App'
import { startGlass } from './ui/glass/liquid'

startGlass()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
