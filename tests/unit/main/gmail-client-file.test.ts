import { describe, expect, it, vi } from 'vitest'
import { CLIENT_FILE_MAX_BYTES, createClientFilePicker } from '../../../src/main/gmail/client-file'
import { ExposedIpcError } from '../../../src/main/ipc/errors'

const valid = JSON.stringify({ installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'GOCSPX-test' } })

function setup(options: { canceled?: boolean; files?: string[]; size?: number; content?: string } = {}) {
  const showOpenDialog = vi.fn(async () => ({ canceled: options.canceled ?? false, filePaths: options.files ?? ['/x/client.json'] }))
  const content = options.content ?? valid
  const stat = vi.fn(async () => ({ size: options.size ?? Buffer.byteLength(content) }))
  const readFile = vi.fn(async () => content)
  return { showOpenDialog, stat, readFile, pick: createClientFilePicker({ showOpenDialog, stat, readFile }) }
}

describe('gmail client file picker', () => {
  it('asks for a single JSON file', async () => {
    const { pick, showOpenDialog } = setup()
    await pick()
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }))
  })

  it('returns the credentials of a desktop client file', async () => {
    await expect(setup().pick()).resolves.toEqual({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' })
  })

  it('returns null on cancel without reading anything', async () => {
    for (const options of [{ canceled: true }, { files: [] }]) {
      const { pick, readFile } = setup(options)
      await expect(pick()).resolves.toBeNull()
      expect(readFile).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['not JSON', { content: 'nope {' }],
    ['a web client', { content: JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }) }],
    ['too big', { size: CLIENT_FILE_MAX_BYTES + 1 }],
    ['an oversize secret', { content: JSON.stringify({ installed: { client_id: 'a', client_secret: `GOCSPX-${'x'.repeat(300)}` } }) }],
  ])('rejects %s with INVALID_INPUT, never echoing the content', async (_name, options) => {
    const { pick, readFile } = setup(options)
    const error = await pick().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExposedIpcError)
    expect(error).toMatchObject({ code: 'INVALID_INPUT' })
    expect((error as Error).message).not.toMatch(/GOCSPX|client_secret/)
    if ('size' in options) expect(readFile).not.toHaveBeenCalled()
  })

  it('treats an unreadable file as invalid too', async () => {
    const pick = createClientFilePicker({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['x'] }),
      stat: async () => {
        throw new Error('EACCES')
      },
      readFile: async () => '',
    })
    await expect(pick()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
