import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@xterm/xterm/css/xterm.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bindClaude } from '../shared/claude-store'
import { bindSettings } from '../shared/settings-store'
import '../styles/global.css'
import { NotchApp } from './NotchApp'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

bindSettings()
bindClaude()

createRoot(root).render(
  <StrictMode>
    <NotchApp />
  </StrictMode>,
)
