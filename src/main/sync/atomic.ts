import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES'])

export interface AtomicWriteOptions {
  mode?: number
  syncDir?: boolean
}

async function syncDirectory(file: string): Promise<void> {
  const dir = await open(dirname(file), 'r').catch(() => null)
  if (!dir) return
  try {
    await dir.sync()
  } catch {
  } finally {
    await dir.close().catch(() => undefined)
  }
}

export async function atomicWriteFile(file: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: options.mode })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temp, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code || !RETRY_CODES.has(code)) {
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
  if (options.syncDir) await syncDirectory(file)
}
