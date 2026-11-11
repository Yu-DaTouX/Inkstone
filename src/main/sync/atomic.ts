import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES'])
const TRANSIENT_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const RENAME_ATTEMPTS = 8
const RENAME_BACKOFF_MS = 25

export interface AtomicWriteOptions {
  mode?: number
  syncDir?: boolean
  durable?: boolean
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

async function writeTemp(temp: string, content: string, options: AtomicWriteOptions): Promise<void> {
  if (!options.durable) {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: options.mode })
    return
  }
  const handle = await open(temp, 'wx', options.mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error
      if (attempt === 0) {
        const target = await lstat(to).catch(() => null)
        if (target?.isDirectory()) throw error
      }
      await new Promise((done) => setTimeout(done, RENAME_BACKOFF_MS * (attempt + 1)))
    }
  }
}

export async function atomicWriteFile(file: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeTemp(temp, content, options)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await renameWithRetry(temp, file)
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
      await renameWithRetry(file, backup)
    } catch {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    try {
      await renameWithRetry(temp, file)
    } catch (retryError) {
      await renameWithRetry(backup, file).catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw retryError
    }
    await rm(backup, { force: true }).catch(() => undefined)
  }
  if (options.syncDir) await syncDirectory(file)
}
