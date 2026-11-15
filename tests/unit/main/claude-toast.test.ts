import { describe, expect, it, vi } from 'vitest'
import { createPermissionToast, createQuestionToast } from '../../../src/main/claude/toast'
import type { PendingPermission, PendingQuestionView } from '../../../src/shared/claude/types'
import { translate } from '../../../src/shared/i18n/messages'

const permission: PendingPermission = {
  id: 'p1',
  sessionId: 's1',
  sessionName: 'mi-proyecto',
  toolName: 'Bash',
  preview: 'rm -rf secret-command',
  previewTruncated: false,
  previewLength: 21,
  receivedAt: 1,
}

describe('createPermissionToast', () => {
  it('shows title and session name without the command', () => {
    const notify = vi.fn()
    const translate = vi.fn((key: string) => (key === 'claude.toast.title' ? 'Claude espera permiso' : key))
    createPermissionToast({ notify, translate }).show(permission, () => undefined)

    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0]![0] as { title: string; body: string }
    expect(arg.title).toBe('Claude espera permiso')
    expect(arg.body).toBe('mi-proyecto')
    expect(JSON.stringify(arg)).not.toContain('secret-command')
    expect(JSON.stringify(arg)).not.toContain('Bash')
  })

  it('invokes the callback on click', () => {
    let click: (() => void) | undefined
    const notify = vi.fn((arg: { onClick: () => void }) => {
      click = arg.onClick
    })
    const onClick = vi.fn()
    createPermissionToast({ notify, translate: (k) => k }).show(permission, onClick)
    expect(onClick).not.toHaveBeenCalled()
    click?.()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('createQuestionToast', () => {
  const question: PendingQuestionView = {
    id: 'q1',
    project: 'mi-proyecto',
    arrivedAt: 1,
    questions: [
      {
        question: 'SECRET-QUESTION?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'SECRET-OPTION', description: '' },
          { label: 'B', description: '' },
        ],
      },
    ],
  }

  it('shows the question title and the project, never the question or its options', () => {
    const notify = vi.fn()
    const translate = vi.fn((key: string) => (key === 'claude.toast.question' ? 'Claude te pregunta' : key))
    const onClick = vi.fn()
    createQuestionToast({ notify, translate }).show(question, onClick)
    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0]![0] as { title: string; body: string; onClick: () => void }
    expect(arg.title).toBe('Claude te pregunta')
    expect(arg.body).toBe('mi-proyecto')
    expect(JSON.stringify(arg)).not.toContain('SECRET')
    arg.onClick()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('has both translations', () => {
    expect(translate('es', 'claude.toast.question')).toBe('Claude te pregunta')
    expect(translate('en', 'claude.toast.question')).toBe('Claude asks')
  })
})
