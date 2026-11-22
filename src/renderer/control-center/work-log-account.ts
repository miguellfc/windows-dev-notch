import { WORK_LOG_IDLE_PAUSE_MAX, WORK_LOG_IDLE_PAUSE_MIN } from '../../shared/settings/schema'

/** One Claude Code account as `claude:accounts` reports it. */
export interface AccountRow {
  id: string
  dir: string
  email: string | null
  organization: string | null
  linked: boolean
  hookStatus: 'installed' | 'outdated' | 'missing'
}

export const IDLE_PAUSE_RANGE = { min: WORK_LOG_IDLE_PAUSE_MIN, max: WORK_LOG_IDLE_PAUSE_MAX } as const

export const linkedAccounts = (accounts: readonly AccountRow[]): AccountRow[] => accounts.filter((account) => account.linked)

/** The measured account, only while it exists and is linked. */
export const chosenAccount = (accounts: readonly AccountRow[], accountId: string | null): AccountRow | null =>
  accountId === null ? null : (linkedAccounts(accounts).find((account) => account.id === accountId) ?? null)

/** True when the work log has no usable account («Elige una cuenta»). */
export const needsAccountChoice = (accounts: readonly AccountRow[], accountId: string | null): boolean =>
  chosenAccount(accounts, accountId) === null

const folderName = (dir: string): string => dir.split(/[\\/]+/).filter(Boolean).pop() ?? dir

/** The account's short name: `claude-work` -> `work`, the default -> `claude`, an extra folder -> its name. */
function shortName(account: AccountRow): string {
  if (account.id === 'claude') return 'claude'
  if (account.id.startsWith('claude-')) return account.id.slice('claude-'.length)
  return folderName(account.dir).replace(/^\.+/, '')
}

/** One uppercase letter for the avatar: the e-mail's first letter, else the account's name. */
export function accountInitial(account: AccountRow): string {
  const source = account.email?.trim() || shortName(account)
  return (source[0] ?? '?').toUpperCase()
}

/** `~/.claude-work` for the folders of the home; any other folder in full. */
export const accountFolderLabel = (account: AccountRow): string =>
  account.id === 'claude' || account.id.startsWith('claude-') ? `~/${folderName(account.dir)}` : account.dir
