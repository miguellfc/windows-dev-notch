import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemindersStore } from '../../../src/main/reminders/reminders-store'
import type { Reminder } from '../../../src/shared/reminders/schema'
import { writeFileAtomic } from '../../../src/main/services/fs-atomic'
import { createMemoryLogger } from '../helpers/memory-logger'

vi.mock('../../../src/main/services/fs-atomic', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/services/fs-atomic')>()
  return { ...original, writeFileAtomic: vi.fn(original.writeFileAtomic) }
})

const reminder = (n: number, text = `secret text ${n}`): Reminder => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  text,
  dueAt: '2026-11-10T12:00:00.000Z',
  repeat: 'none',
  state: 'pending',
  createdAt: '2026-11-10T10:00:00.000Z',
})

let dir: string
let file: string
const now = () => new Date('2026-11-10T10:00:00.000Z')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reminders-store-'))
  file = join(dir, 'reminders.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const make = () => {
  const logger = createMemoryLogger()
  return { logger, store: createRemindersStore({ file, logger, now }) }
}

describe('reminders store', () => {
  it('treats a missing file as ok with an empty list', async () => {
    const { store } = make()
    expect(await store.load()).toBe('ok')
    expect(store.all()).toEqual([])
  })

  it('writes and reloads reminders', async () => {
    const a = make()
    await a.store.load()
    await a.store.write([reminder(1)])
    expect(a.store.all()).toEqual([reminder(1)])
    const b = make()
    expect(await b.store.load()).toBe('ok')
    expect(b.store.all()).toEqual([reminder(1)])
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['schema mismatch', JSON.stringify({ version: 1, reminders: [{ id: 'x' }] })],
    ['no version', JSON.stringify({ reminders: [] })],
  ])('quarantines a file with %s', async (_name, content) => {
    await writeFile(file, content, 'utf8')
    const { store } = make()
    expect(await store.load()).toBe('quarantined')
    expect(store.all()).toEqual([])
    const names = await readdir(dir)
    expect(names).toContain('reminders.corrupt-2026-11-10T10-00-00-000Z.json')
    expect(names).not.toContain('reminders.json')
    await store.write([reminder(1)])
    expect(store.all()).toHaveLength(1)
  })

  it('goes read-only for a newer version and never writes over it', async () => {
    const original = JSON.stringify({ version: 2, reminders: [{ anything: true }] })
    await writeFile(file, original, 'utf8')
    const { store } = make()
    expect(await store.load()).toBe('read-only')
    expect(store.all()).toEqual([])
    await expect(store.write([reminder(1)])).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(store.all()).toEqual([])
  })

  it('serializes writes: a slow first write finishes before the second starts', async () => {
    const { store } = make()
    await store.load()
    const real = vi.mocked(writeFileAtomic).getMockImplementation()!
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve))
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (target, data) => {
      events.push('first:start')
      await gate
      await real(target, data)
      events.push('first:end')
    })
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (target, data) => {
      events.push('second:start')
      await real(target, data)
      events.push('second:end')
    })

    const first = store.write([reminder(1)])
    const second = store.write([reminder(2)])
    // let the queue run: only the first write may have started while it is held back
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual(['first:start'])
    expect(store.all()).toEqual([])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(JSON.parse(await readFile(file, 'utf8')).reminders).toEqual([reminder(2)])
    expect(store.all()).toEqual([reminder(2)])
  })

  it('survives an I/O failure: rejects, keeps the list and accepts later writes', async () => {
    const { store } = make()
    await store.load()
    await store.write([reminder(1)])
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('EIO: disk gone'))
    const failing = store.write([reminder(2)])
    const queued = store.write([reminder(3)])
    await expect(failing).rejects.toThrow('EIO')
    await queued
    expect(store.all()).toEqual([reminder(3)])
    expect(JSON.parse(await readFile(file, 'utf8')).reminders).toEqual([reminder(3)])
  })

  it('keeps the previous list when a write fails', async () => {
    const { store } = make()
    await store.load()
    await store.write([reminder(1)])
    await expect(store.write([{ ...reminder(2), text: '' }])).rejects.toThrow()
    expect(store.all()).toEqual([reminder(1)])
    // a failure does not poison later writes
    await store.write([reminder(3)])
    expect(store.all()).toEqual([reminder(3)])
  })

  it('never logs reminder text', async () => {
    await writeFile(file, '{bad secret text 9', 'utf8')
    const { store, logger } = make()
    await store.load()
    await store.write([reminder(1), reminder(2)])
    expect(logger.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(logger.entries)).not.toContain('secret text')
  })
})
