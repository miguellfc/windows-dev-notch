import { describe, expect, it } from 'vitest'
import {
  accountFolderLabel,
  accountInitial,
  chosenAccount,
  IDLE_PAUSE_RANGE,
  linkedAccounts,
  needsAccountChoice,
  type AccountRow,
} from '../../../src/renderer/control-center/work-log-account'

const account = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: 'claude',
  dir: 'C:\\Users\\me\\.claude',
  email: null,
  organization: null,
  linked: false,
  hookStatus: 'missing',
  ...over,
})

const work = { id: 'claude-work', dir: 'C:\\Users\\me\\.claude-work' }

describe('work log page: which account is measured', () => {
  const accounts = [account({ linked: true }), account({ ...work, linked: false })]

  it('asks for an account when none is chosen', () => {
    expect(needsAccountChoice(accounts, null)).toBe(true)
  })

  it('asks for an account when the chosen one is not linked or no longer exists', () => {
    expect(needsAccountChoice(accounts, 'claude-work')).toBe(true)
    expect(needsAccountChoice(accounts, 'gone')).toBe(true)
  })

  it('is satisfied by a linked account', () => {
    expect(needsAccountChoice(accounts, 'claude')).toBe(false)
    expect(chosenAccount(accounts, 'claude')?.id).toBe('claude')
    expect(chosenAccount(accounts, 'claude-work')).toBeNull()
  })

  it('lists only the linked accounts', () => {
    expect(linkedAccounts(accounts).map((a) => a.id)).toEqual(['claude'])
  })
})

describe('work log page: account labels', () => {
  it('uses the e-mail (else the account name) initial, uppercased', () => {
    expect(accountInitial(account({ email: 'ana@x.com' }))).toBe('A')
    expect(accountInitial(account(work))).toBe('W')
    expect(accountInitial(account())).toBe('C')
  })

  it('shows home folders as ~/name and others in full', () => {
    expect(accountFolderLabel(account(work))).toBe('~/.claude-work')
    expect(accountFolderLabel(account({ id: 'dir-1a2b3c4d', dir: 'D:\\profiles\\claude' }))).toBe('D:\\profiles\\claude')
  })

  it('bounds the idle pause at 5 to 240 minutes', () => {
    expect(IDLE_PAUSE_RANGE).toEqual({ min: 5, max: 240 })
  })
})
