import { useEffect, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import { acceleratorFromKey, formatAccelerator } from '../../shared/settings/accelerator'
import type { Settings } from '../../shared/settings/schema'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { Kbd } from '../ui/Kbd'
import { SettingRow, type Runtime } from './ControlCenterApp'

type Status = { tone: 'info' | 'error'; key: MessageKey; shortcut?: string } | null

export function ShortcutPage({
  settings,
  runtime,
  onChanged,
}: {
  settings: Settings
  runtime: Runtime
  onChanged: () => void
}) {
  const t = useT()
  const update = useSettings((state) => state.update)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      const noModifiers = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
      if (event.code === 'Escape' && noModifiers) {
        setRecording(false)
        setStatus(null)
        return
      }
      const result = acceleratorFromKey(event)
      if (result.kind === 'incomplete') return
      if (result.kind === 'needs-modifier') return setStatus({ tone: 'error', key: 'cc.shortcut.needsModifier' })
      if (result.kind === 'unsupported') return setStatus({ tone: 'error', key: 'cc.shortcut.unsupported' })

      setRecording(false)
      void update({ shortcut: result.accelerator }).then((saved) => {
        if (saved.ok) setStatus({ tone: 'info', key: 'cc.shortcut.saved' })
        else if (saved.error.code === 'UNAVAILABLE')
          setStatus({ tone: 'error', key: 'cc.shortcut.unavailable', shortcut: result.accelerator })
        else if (saved.error.code === 'READ_ONLY') setStatus({ tone: 'error', key: 'error.readOnly' })
        else setStatus({ tone: 'error', key: 'error.generic' })
        onChanged()
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, update, onChanged])

  const message =
    status && t(status.key, status.shortcut ? { shortcut: formatAccelerator(status.shortcut).join(' + ') } : undefined)

  return (
    <div>
      <SettingRow label={t('cc.shortcut.title')} hint={t('cc.shortcut.description')}>
        <div className="flex items-center gap-3">
          {recording ? (
            <span className="text-small text-ice">{t('cc.shortcut.recording')}</span>
          ) : (
            <Kbd accelerator={settings.shortcut} />
          )}
          <button
            type="button"
            onClick={() => {
              setStatus(null)
              setRecording(!recording)
            }}
            className="h-8 cursor-pointer rounded-control border border-line bg-veil px-3 text-small text-chalk transition-colors duration-150 hover:bg-veil-tile"
          >
            {recording ? t('cc.shortcut.cancel') : t('cc.shortcut.change')}
          </button>
        </div>
      </SettingRow>
      <p role="status" aria-live="polite" className={`min-h-5 text-small ${status?.tone === 'error' ? 'text-fail' : 'text-graphite'}`}>
        {message ?? (!runtime.shortcutRegistered ? t('cc.shortcut.notRegistered') : '')}
      </p>
    </div>
  )
}
