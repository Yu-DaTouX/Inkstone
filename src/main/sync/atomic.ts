import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temp, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    const existing = await lstat(file).catch(() => null)
    if (!existing || existing.isDirectory()) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    const backup = `${file}.${randomUUID()}.bak`
    try {
      await rename(file, backup)
    } catch {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    try {
      await rename(temp, file)
    } catch (retryError) {
      await rename(backup, file).catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw retryError
    }
    await rm(backup, { force: true }).catch(() => undefined)
  }
}
