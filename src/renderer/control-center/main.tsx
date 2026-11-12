import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bindClaude } from '../shared/claude-store'
import { bindGmail } from '../shared/gmail-store'
import { bindReminders } from '../shared/reminders-store'
import { bindSettings } from '../shared/settings-store'
import '../styles/global.css'
import { ControlCenterApp } from './ControlCenterApp'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

bindSettings()
bindClaude()
bindReminders()
bindGmail()

createRoot(root).render(
  <StrictMode>
    <ControlCenterApp />
  </StrictMode>,
)
