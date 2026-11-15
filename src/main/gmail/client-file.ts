import { parseClientFile } from '../../shared/gmail/schema'
import { ExposedIpcError } from '../ipc/errors'

/** Google's client JSON is under 1 KB; anything near this is not one. */
export const CLIENT_FILE_MAX_BYTES = 64 * 1024

interface PickerDeps {
  showOpenDialog(options: { properties: ['openFile']; filters: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }>
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<string>
}

const invalid = (): ExposedIpcError => new ExposedIpcError('INVALID_INPUT', 'Not a Google desktop client file')

/**
 * Lets the user pick the JSON Google gives for a "Desktop app" OAuth client. Returns null on
 * cancel. The file is read once and never copied; nothing from it (the secret above all) is logged
 * or put in an error.
 */
export function createClientFilePicker(deps: PickerDeps): () => Promise<{ clientId: string; clientSecret: string } | null> {
  return async () => {
    const choice = await deps.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    const path = choice.filePaths[0]
    if (choice.canceled || path === undefined) return null
    let json: unknown
    try {
      if ((await deps.stat(path)).size > CLIENT_FILE_MAX_BYTES) throw invalid()
      json = JSON.parse(await deps.readFile(path))
    } catch {
      throw invalid()
    }
    const client = parseClientFile(json)
    if (!client) throw invalid()
    return client
  }
}
