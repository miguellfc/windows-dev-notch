import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/global.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// Placeholder entry so the multi-page build is in place; the window is created in plan task 1.11.
createRoot(root).render(
  <StrictMode>
    <main className="p-6">
      <h1 className="text-[15px] font-semibold">Control Center</h1>
    </main>
  </StrictMode>,
)
