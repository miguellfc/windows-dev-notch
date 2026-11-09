import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bindSettings } from '../shared/settings-store'
import '../styles/global.css'
import { NotchApp } from './NotchApp'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

bindSettings()

createRoot(root).render(
  <StrictMode>
    <NotchApp />
  </StrictMode>,
)
