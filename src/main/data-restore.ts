import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileUrl } from '../shared/file-url'
import { DEFAULT_PERMISSION_MODE } from '../shared/approval'
import type { BackupSummary } from '../shared/data-backup'
import { hashBackupFile, readDataBackup } from './data-backup'

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function sourceFile(root: string, parts: string[]): string {
  return (/^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? win32 : posix).join(root, ...parts)
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

const PATH_FIELDS = new Set(['path', 'url', 'session', 'sessionFile', 'conversationFile', 'parentSession', 'chainId'])

function rebase(value: unknown, paths: Map<string, string>, key = ''): unknown {
  if (typeof value === 'string') {
    const next = PATH_FIELDS.has(key) ? paths.get(pathKey(value)) : undefined
    return next ? value.includes('/') && !value.includes('\\') ? next.replace(/\\/g, '/') : next : value
  }
  if (Array.isArray(value)) return value.map((item) => rebase(item, paths, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rebase(item, paths, name)]))
}

async function* sessionLines(input: ReadStream): AsyncGenerator<string> {
  let parts: string[] = []
  let length = 0
  for await (const value of input) {
    const chunk = String(value)
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start)
      const part = chunk.slice(start, end < 0 ? undefined : end)
      parts.push(part)
      length += Buffer.byteLength(part, 'utf8')
      if (length > 64 * 1024 * 1024) throw new Error('Session record exceeds 64 MiB restore limit')
      if (end < 0) break
      yield parts.join('')
      parts = []
      length = 0
      start = end + 1
    }
  }
  if (length) yield parts.join('')
}

async function rewriteSession(file: string, paths: Map<string, string>): Promise<void> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const output = createWriteStream(`${file}.restore.tmp`, { flags: 'wx', mode: 0o600 })
  try {
    await pipeline(Readable.from((async function* () {
      for await (const line of sessionLines(input)) yield (line.trim() ? JSON.stringify(rebase(JSON.parse(line), paths)) : '') + '\n'
    })()), output)
    await rename(`${file}.restore.tmp`, file)
  } finally {
    input.destroy()
    output.destroy()
  }
}

export async function restoreDataBackup(backup: string, parent: string, protectedRoots: string[] = []): Promise<BackupSummary> {
  const { summary, manifest } = await readDataBackup(backup)
  const sources = manifest.version === 2 ? manifest.sources : undefined
  const target = await realpath(parent)
  for (const root of [summary.path, ...protectedRoots]) {
    const actual = await realpath(root).catch(() => root)
    if (inside(actual, target)) throw new Error('Choose a restore folder outside the backup and active data')
  }
  const path = join(target, `Inkstone-restored-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(path, { mode: 0o700 })
  const pi = join(path, 'pi-agent')
  const paths = new Map<string, string>()
  const legacyDirs = new Map<string, string>()
  if (sources) {
    for (const entry of manifest.files.filter((item) => item.path.startsWith('sessions/'))) {
      const parts = entry.path.split('/').slice(1)
      const source = sourceFile(sources.sessions, parts)
      const dest = join(pi, 'sessions', ...parts)
      legacyDirs.set(createHash('sha256').update(source).digest('hex').slice(0, 32), createHash('sha256').update(dest).digest('hex').slice(0, 32))
    }
    for (const entry of manifest.files) {
      const [root, ...parts] = entry.path.split('/')
      const source = sourceFile(root === 'sessions' ? sources.sessions : sources.yan, parts)
      if (root === 'yan' && parts[0] === 'artifacts') parts[1] = legacyDirs.get(parts[1]) ?? parts[1]
      const dest = join(pi, root, ...parts)
      paths.set(pathKey(source), dest)
      paths.set(pathKey(fileUrl(source)), fileUrl(dest))
    }
  }
  try {
    for (const entry of manifest.files) {
      const source = join(summary.path, ...entry.path.split('/'))
      let current = summary.path
      for (const part of entry.path.split('/')) {
        current = join(current, part)
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Backup contains a link')
      }
      const dest = join(pi, ...entry.path.split('/'))
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await copyFile(source, dest, 1)
      if ((await stat(dest)).size !== entry.size || await hashBackupFile(dest) !== entry.sha256) throw new Error(`Backup changed during restore: ${entry.path}`)
    }
    for (const entry of manifest.files) {
      const dest = join(pi, ...entry.path.split('/'))
      if (entry.path.startsWith('sessions/')) {
        if (sources) await rewriteSession(dest, paths)
      } else if (entry.path === 'yan/desktop.json' || /^yan\/(session-(?:chains|layout)\.json|interaction-state\/[a-f0-9]{64}\.json)$/.test(entry.path)) {
        const raw = JSON.parse(await readFile(dest, 'utf8')) as unknown
        const next = rebase(raw, paths) as Record<string, unknown>
        if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`Invalid restored metadata: ${entry.path}`)
        if (entry.path === 'yan/desktop.json') {
          next.cwd = join(path, 'workspace')
          next.permissionMode = DEFAULT_PERMISSION_MODE
          next.guardOutsideWrites = true
          next.remoteAccess = { enabled: false }
        }
        await writeFile(dest, JSON.stringify(next, null, 2), { mode: 0o600 })
        if (entry.path.startsWith('yan/interaction-state/') && typeof next.session === 'string') {
          const name = createHash('sha256').update(next.session).digest('hex') + '.json'
          const rebound = join(dirname(dest), name)
          if (rebound !== dest) {
            try { await lstat(rebound); throw new Error('Restored interaction state paths conflict') }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            await rename(dest, rebound)
          }
        }
      }
    }
    for (const [legacy, rebound] of legacyDirs) {
      const old = join(pi, 'yan', 'artifacts', legacy)
      const next = join(pi, 'yan', 'artifacts', rebound)
      const exists = await lstat(old).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (exists && old !== next) {
        try { await lstat(next); throw new Error('Restored artifact paths conflict') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rename(old, next)
      }
    }
    for (const dir of ['sessions', 'yan']) await mkdir(join(pi, dir), { recursive: true })
    for (const dir of ['electron', 'downloads', 'workspace']) await mkdir(join(path, dir))
    await writeFile(join(path, 'restored.json'), JSON.stringify({ format: 'inkstone-restored', version: 1, source: summary.path, restoredAt: new Date().toISOString(), legacyBackup: manifest.version === 1 }, null, 2), { flag: 'wx', mode: 0o600 })
    return { ...summary, path }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nIncomplete restore retained: ${path}`)
  }
}
