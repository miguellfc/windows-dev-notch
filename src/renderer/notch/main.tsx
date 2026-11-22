import '@fontsource-variable/nunito'
import '@fontsource-variable/geist-mono'
import '@fontsource/jersey-10'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bindClaude } from '../shared/claude-store'
import { bindCodeReview, bindCodeReviewContributions } from '../shared/code-review-store'
import { bindGmail, bindGmailPanel } from '../shared/gmail-store'
import { bindNotes } from '../shared/notes-store'
import { bindQuestions } from '../shared/questions-store'
import { bindRedmine } from '../shared/redmine-store'
import { bindReminders } from '../shared/reminders-store'
import { bindSettings } from '../shared/settings-store'
import { bindSystem } from '../shared/system-store'
import { bindWorkLog } from '../shared/work-log-store'
import '../styles/global.css'
import { NotchApp } from './NotchApp'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

bindSettings()
bindClaude()
bindQuestions()
bindReminders()
bindNotes()
bindSystem()
bindGmail()
bindGmailPanel()
bindCodeReview()
bindCodeReviewContributions()
bindRedmine()
bindWorkLog()

createRoot(root).render(
  <StrictMode>
    <NotchApp />
  </StrictMode>,
)
