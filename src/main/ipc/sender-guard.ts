import { normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SenderGuardOptions {
  /** Folder that holds the bundled renderer pages (`out/renderer`). */
  rendererDir: string
  /** Vite dev server origin; only set in development. */
  devServerUrl?: string | undefined
  caseInsensitive?: boolean
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Returns a predicate that accepts only URLs of our own renderer pages:
 * files inside the bundled renderer folder, or the exact dev server origin.
 */
export function createSenderGuard(options: SenderGuardOptions): (url: string) => boolean {
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value)
  const rendererRoot = fold(normalize(options.rendererDir).replace(/[\\/]+$/, '') + sep)
  const devOrigin = options.devServerUrl ? parseUrl(options.devServerUrl)?.origin : undefined

  return (value) => {
    const url = parseUrl(value)
    if (!url) return false

    if (url.protocol === 'file:') {
      try {
        return fold(normalize(fileURLToPath(url))).startsWith(rendererRoot)
      } catch {
        return false
      }
    }

    return devOrigin !== undefined && devOrigin !== 'null' && url.origin === devOrigin
  }
}
