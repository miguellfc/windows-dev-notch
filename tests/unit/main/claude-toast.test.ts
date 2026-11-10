import { describe, expect, it, vi } from 'vitest'
import { createPermissionToast } from '../../../src/main/claude/toast'
import type { PendingPermission } from '../../../src/shared/claude/types'

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
