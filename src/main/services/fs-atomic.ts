import { randomBytes } from 'node:crypto'
import { mkdir, readFile as fsReadFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const readTextFile = async (path: string): Promise<string | null> => {
  try {
    return await fsReadFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Writes to a unique temp file in the same directory, then renames over the target. */
export const writeFileAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
