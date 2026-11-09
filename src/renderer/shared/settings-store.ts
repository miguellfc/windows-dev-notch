import { create } from 'zustand'
import type { NotchApi } from '../../shared/ipc/api'
import type { Result } from '../../shared/ipc/result'
import type { Settings } from '../../shared/settings/schema'

type SettingsPatch = Parameters<NotchApi['settings']['update']>[0]

interface SettingsState {
  settings: Settings | null
  load(): Promise<void>
  update(patch: SettingsPatch): Promise<Result<Settings>>
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  load: async () => {
    const result = await window.notch.settings.get()
    // A settings:changed event may have arrived first; never overwrite it with an older read.
    if (result.ok) set((state) => (state.settings ? state : { settings: result.data }))
  },
  update: async (patch) => {
    const result = await window.notch.settings.update(patch)
    if (result.ok) set({ settings: result.data })
    return result
  },
}))

/** Loads settings once and keeps every window in sync with changes made elsewhere. */
export function bindSettings(): void {
  window.notch.events.on('settings:changed', (settings) => useSettings.setState({ settings }))
  void useSettings.getState().load()
}
