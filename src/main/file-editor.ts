import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { EditableFileError, EditableFileView, EditableFileWriteResult } from '../shared/ipc'
import { isStrictlyWithin, isWithin, pathKey, realRoot } from './file-path-gate'

const MAX_BYTES = 1024 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const writeChains = new Map<string, Promise<void>>()

function statusForError(error: unknown): EditableFileError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  return 'error'
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function missingView(error: EditableFileError, abs: string, name: string): EditableFileView {
  return { ok: false, abs, name, text: '', hash: '', size: 0, mtimeMs: 0, error }
}

async function withWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const tail = previous.then(() => gate)
  writeChains.set(key, tail)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (writeChains.get(key) === tail) writeChains.delete(key)
  }
}

async function readDiskBytes(target: string): Promise<{ exists: boolean; bytes: Buffer | null }> {
  try {
    return { exists: true, bytes: await readFile(target) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, bytes: null }
    throw error
  }
}

export async function readEditableFile(root: string, target: string): Promise<EditableFileView> {
  if (typeof root !== 'string' || typeof target !== 'string' || !target.trim()) {
    return missingView('denied', '', '')
  }
  const rootReal = await realRoot(root)
  if (!rootReal) return missingView('denied', '', '')

  const candidate = isAbsolute(target) ? resolve(target) : resolve(rootReal, target)
  const name = basename(candidate)

  let info: Stats
  try {
    info = await lstat(candidate)
  } catch (error) {
    if (statusForError(error) !== 'missing') return missingView(statusForError(error), candidate, name)
    try {
      const parentReal = await realpath(dirname(candidate))
      if (!isStrictlyWithin(rootReal, join(parentReal, name))) return missingView('denied', candidate, name)
    } catch {
      return missingView('denied', candidate, name)
    }
    return missingView('missing', candidate, name)
  }

  if (info.isSymbolicLink() || !info.isFile()) return missingView('denied', candidate, name)

  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error) {
    return missingView(statusForError(error), candidate, name)
  }
  if (!isStrictlyWithin(rootReal, canonical)) return missingView('denied', candidate, name)
  if (info.size > MAX_BYTES) return missingView('too-large', candidate, name)

  let bytes: Buffer
  try {
    bytes = await readFile(candidate)
  } catch (error) {
    return missingView(statusForError(error), candidate, name)
  }

  if (bytes.includes(0)) return missingView('binary', candidate, name)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return missingView('encoding', candidate, name)
  }

  return {
    ok: true,
    abs: candidate,
    name,
    text,
    hash: sha256(bytes),
    size: bytes.length,
    mtimeMs: info.mtimeMs
  }
}

export async function writeEditableFile(
  root: string,
  target: string,
  text: string,
  expectedHash: string | null
): Promise<EditableFileWriteResult> {
  if (typeof root !== 'string' || typeof target !== 'string' || !target.trim()) return { status: 'denied' }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { status: 'denied' }
  if (expectedHash !== null && !(typeof expectedHash === 'string' && HASH_PATTERN.test(expectedHash))) {
    return { status: 'denied' }
  }

  const rootReal = await realRoot(root)
  if (!rootReal) return { status: 'denied' }

  const candidate = isAbsolute(target) ? resolve(target) : resolve(rootReal, target)
  const name = basename(candidate)
  const dir = dirname(candidate)

  let parentReal: string
  try {
    parentReal = await realpath(dir)
  } catch {
    return { status: 'denied' }
  }
  if (!isWithin(rootReal, parentReal)) return { status: 'denied' }
  if (!isStrictlyWithin(rootReal, join(parentReal, name))) return { status: 'denied' }

  return withWriteLock(pathKey(join(parentReal, name)), async () => {
    let info: Stats | null
    try {
      info = await lstat(candidate)
    } catch (error) {
      if (statusForError(error) !== 'missing') return { status: 'failed' as const, error: messageOf(error) }
      info = null
    }
    if (info && (info.isSymbolicLink() || !info.isFile())) return { status: 'denied' as const }

    let mode: number
    let preserveMode = false
    let keepBom = false
    if (info) {
      let current: Buffer
      try {
        current = await readFile(candidate)
      } catch (error) {
        return { status: 'failed' as const, error: messageOf(error) }
      }
      const currentHash = sha256(current)
      if (expectedHash === null || currentHash !== expectedHash) return { status: 'conflict' as const, currentHash }
      keepBom = current.subarray(0, 3).equals(UTF8_BOM) && !text.startsWith('\uFEFF')
      mode = info.mode & 0o777
      preserveMode = true
    } else {
      if (expectedHash !== null) return { status: 'denied' as const }
      let parentNow: string
      try {
        parentNow = await realpath(dir)
      } catch {
        return { status: 'denied' as const }
      }
      if (!isStrictlyWithin(rootReal, join(parentNow, name))) return { status: 'denied' as const }
      if (pathKey(parentNow) !== pathKey(parentReal)) return { status: 'denied' as const }
      mode = 0o666
    }

    const bytes = keepBom ? Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8')
    if (bytes.length > MAX_BYTES) return { status: 'denied' as const }
    const hash = sha256(bytes)
    const temp = join(dir, `.${name}.yan-${randomBytes(6).toString('hex')}.tmp`)
    let handle: FileHandle | null = null
    try {
      handle = await open(temp, 'wx', mode)
      await handle.writeFile(bytes)
      await handle.close()
      handle = null
      if (preserveMode) await chmod(temp, mode)

      let parentAfter: string
      try {
        parentAfter = await realpath(dir)
      } catch {
        return { status: 'failed' as const, error: '保存时目标目录已不可用' }
      }
      if (pathKey(parentAfter) !== pathKey(parentReal)) {
        return { status: 'failed' as const, error: '目标目录在校验后发生变化' }
      }
      if (!isStrictlyWithin(rootReal, join(parentAfter, name))) return { status: 'denied' as const }

      let disk: { exists: boolean; bytes: Buffer | null }
      try {
        disk = await readDiskBytes(candidate)
      } catch (error) {
        return { status: 'failed' as const, error: messageOf(error) }
      }
      const diskHash = disk.bytes ? sha256(disk.bytes) : null
      if (diskHash !== expectedHash) {
        return { status: 'conflict' as const, ...(diskHash ? { currentHash: diskHash } : {}) }
      }

      await rename(temp, candidate)
      return { status: 'saved' as const, hash }
    } catch (error) {
      return { status: 'failed' as const, error: messageOf(error) }
    } finally {
      if (handle) await handle.close().catch(() => {})
      await rm(temp, { force: true }).catch(() => {})
    }
  })
}
