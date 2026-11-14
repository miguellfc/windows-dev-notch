import type { Language, Settings } from '../../shared/settings/schema'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { SettingRow, type Runtime } from './ControlCenterApp'

// Language names stay in their own language, so people can always find theirs.
const LANGUAGES: readonly { value: Language; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
]

export function GeneralPage({ settings, runtime }: { settings: Settings; runtime: Runtime }) {
  const t = useT()
  const update = useSettings((state) => state.update)

  return (
    <div>
      <SettingRow label={t('cc.general.language')} hint={t('cc.general.languageHint')}>
        <Segmented
          label={t('cc.general.language')}
          value={settings.language}
          options={LANGUAGES}
          onChange={(language) => void update({ language })}
        />
      </SettingRow>
      <SettingRow
        label={t('cc.general.launchAtLogin')}
        hint={runtime.isPackaged ? t('cc.general.launchAtLoginHint') : t('cc.general.launchAtLoginUnavailable')}
      >
        <Switch
          label={t('cc.general.launchAtLogin')}
          checked={settings.launchAtLogin}
          disabled={!runtime.isPackaged}
          onChange={(launchAtLogin) => void update({ launchAtLogin })}
        />
      </SettingRow>
    </div>
  )
}
