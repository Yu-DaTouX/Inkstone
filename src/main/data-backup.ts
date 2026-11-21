import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BackupChange, BackupPartId, BackupPartUsage, BackupSummary, BackupTooLarge } from '../shared/data-backup'

type Entry = { path: string; size: number; sha256: string }
export type BackupManifest = {
  format: 'inkstone-backup'
  version: 1 | 2
  createdAt: string
  files: Entry[]
  sources?: { sessions: string; yan: string }
  skipped?: BackupPartUsage[]
  changed?: BackupChange[]
  changedTotal?: number
}
type Source = { path: string; source: string; size: number; mtime: number }
const MAX_FILES = 50000
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const MAX_BYTES = 10 * 1024 ** 3
const COPY_ATTEMPTS = 3
const CHANGED_LISTED = 200
const PART_IDS: readonly BackupPartId[] = ['sessions', 'attachments', 'artifacts', 'session-quotes']

export class BackupTooLargeError extends Error {
  constructor(readonly info: BackupTooLarge) {
    super('Backup limit exceeded (50,000 files / 10 GiB)')
    this.name = 'BackupTooLargeError'
  }
}

interface BackupLimits {
  maxFiles: number
  maxBytes: number
}

export interface BackupOptions {
  skipParts?: readonly BackupPartId[]
  autoSkipLarge?: boolean
  limits?: Partial<BackupLimits>
}

function partOf(path: string): BackupPartId | null {
  if (path.startsWith('sessions/')) return 'sessions'
  const match = /^yan\/(attachments|artifacts|session-quotes)\//.exec(path)
  return match ? (match[1] as BackupPartId) : null
}
const MANIFEST = 'manifest.json'
export const AUTO_BACKUP_DIRNAME = 'auto-backups'
export const AUTO_BACKUP_MARKER = 'auto-backup.json'

function allowed(path: string, version: 1 | 2): boolean {
  if (!path || path.includes('\\') || path.split('/').some((p) => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) return false
  if (path === 'yan/desktop.json' || /^sessions\/.+\.jsonl$/.test(path) || /^yan\/interaction-state\/[a-f0-9]{64}\.json$/.test(path)) return true
  return version === 2 && (['yan/session-chains.json', 'yan/session-layout.json', 'yan/manual-titles.json', 'yan/titles.json'].includes(path) || /^yan\/antigravity-sessions\/[^/]+\.json$/.test(path) || /^yan\/(attachments|artifacts|session-quotes)\/.+/.test(path) && !path.endsWith('.tmp'))
}

export async function hashBackupFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

function metadataFile(path: string): boolean {
  return /^yan\/(desktop\.json|(?:manual-)?titles\.json|session-(?:chains|layout)\.json|interaction-state\/[a-f0-9]{64}\.json|antigravity-sessions\/[^/]+\.json|artifacts\/[^/]+\/manifest\.json)$/.test(path)
}

async function scan(sessions: string, yan: string): Promise<Source[]> {
  const files: Source[] = []
  const visit = async (source: string, path: string, depth: number): Promise<void> => {
    if (depth > 20) throw new Error('Backup directory is too deep')
    let info
    try { info = await lstat(source) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    if (info.isSymbolicLink()) throw new Error(`Backup does not follow links: ${path}`)
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await visit(join(source, name), `${path}/${name}`, depth + 1)
    } else if (info.isFile() && allowed(path, 2)) {
      if (metadataFile(path) && info.size > MAX_METADATA_BYTES) throw new Error(`Backup metadata is too large: ${path}`)
      files.push({ path, source, size: info.size, mtime: info.mtimeMs })
    }
  }
  await visit(sessions, 'sessions', 0)
  await visit(join(yan, 'desktop.json'), 'yan/desktop.json', 0)
  await visit(join(yan, 'interaction-state'), 'yan/interaction-state', 0)
  for (const name of ['session-chains.json', 'session-layout.json', 'manual-titles.json', 'titles.json', 'antigravity-sessions', 'attachments', 'artifacts', 'session-quotes']) await visit(join(yan, name), `yan/${name}`, 0)
  return files
}

export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

function usageOf(files: readonly Source[]): { parts: BackupPartUsage[]; core: { files: number; bytes: number } } {
  const parts = new Map<BackupPartId, BackupPartUsage>(PART_IDS.map((part) => [part, { part, files: 0, bytes: 0 }]))
  const core = { files: 0, bytes: 0 }
  for (const file of files) {
    const part = partOf(file.path)
    const target = part ? parts.get(part)! : core
    target.files += 1
    target.bytes += file.size
  }
  return { parts: [...parts.values()].filter((item) => item.files > 0), core }
}

function withinLimits(files: number, bytes: number, limits: BackupLimits): boolean {
  return files <= limits.maxFiles && bytes <= limits.maxBytes
}

function suggestSkips(parts: readonly BackupPartUsage[], core: { files: number; bytes: number }, limits: BackupLimits, locked: ReadonlySet<BackupPartId> = new Set()): BackupPartId[] | null {
  const kept = new Map(parts.map((item) => [item.part, item]))
  const totals = (): { files: number; bytes: number } => ({
    files: core.files + [...kept.values()].reduce((sum, item) => sum + item.files, 0),
    bytes: core.bytes + [...kept.values()].reduce((sum, item) => sum + item.bytes, 0)
  })
  const skipped: BackupPartUsage[] = []
  for (let now = totals(); !withinLimits(now.files, now.bytes, limits); now = totals()) {
    const biggest = [...kept.values()].filter((item) => !locked.has(item.part)).sort((a, b) => (now.bytes > limits.maxBytes ? b.bytes - a.bytes : b.files - a.files))[0]
    if (!biggest) return null
    kept.delete(biggest.part)
    skipped.push(biggest)
  }
  for (const item of [...skipped].sort((a, b) => a.bytes - b.bytes)) {
    kept.set(item.part, item)
    const now = totals()
    if (withinLimits(now.files, now.bytes, limits)) skipped.splice(skipped.indexOf(item), 1)
    else kept.delete(item.part)
  }
  return skipped.map((item) => item.part)
}

async function copyStable(entry: Source, dest: string): Promise<{ sha256: string; size: number; changed: boolean } | null> {
  for (let attempt = 1; ; attempt++) {
    await rm(dest, { force: true })
    try {
      await copyFile(entry.source, dest, 1)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const sha256 = await hashBackupFile(dest)
    const original = await hashBackupFile(entry.source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (original === null) return null
    if (original === sha256) return { sha256, size: (await stat(dest)).size, changed: false }
    if (attempt >= COPY_ATTEMPTS) return { sha256, size: (await stat(dest)).size, changed: true }
  }
}

export async function createDataBackup(parent: string, sessions: string, yan: string, options: BackupOptions = {}): Promise<BackupSummary> {
  const target = await realpath(parent)
  for (const source of [sessions, yan]) {
    const actual = await realpath(source).catch(() => resolve(source))
    if (inside(actual, target)) throw new Error('Choose a folder outside the source data')
  }
  const limits: BackupLimits = { maxFiles: options.limits?.maxFiles ?? MAX_FILES, maxBytes: options.limits?.maxBytes ?? MAX_BYTES }
  const found = await scan(sessions, yan)
  const usage = usageOf(found)
  let skipParts = new Set<BackupPartId>(options.skipParts ?? [])
  const plan = (): Source[] => found.filter((entry) => {
    const part = partOf(entry.path)
    return !part || !skipParts.has(part)
  })
  let planned = plan()
  if (!withinLimits(planned.length, planned.reduce((sum, entry) => sum + entry.size, 0), limits)) {
    const extra = suggestSkips(usage.parts.filter((item) => !skipParts.has(item.part)), usage.core, limits, options.autoSkipLarge ? new Set<BackupPartId>(['sessions']) : undefined)
    if (!extra) throw new Error('Backup limit exceeded (50,000 files / 10 GiB)')
    if (!options.autoSkipLarge) throw new BackupTooLargeError({ parts: usage.parts, suggested: [...skipParts, ...extra], maxFiles: limits.maxFiles, maxBytes: limits.maxBytes })
    skipParts = new Set([...skipParts, ...extra])
    planned = plan()
  }
  if (!planned.length) throw new Error('No data to back up')
  const skipped = usage.parts.filter((item) => skipParts.has(item.part))
  const createdAt = new Date().toISOString()
  const path = join(target, `Inkstone-backup-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(path, { recursive: false, mode: 0o700 })
  const files: Entry[] = []
  const changed: BackupChange[] = []
  try {
    for (const entry of planned) {
      const dest = join(path, ...entry.path.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      const copied = await copyStable(entry, dest)
      if (!copied) {
        await rm(dest, { force: true })
        changed.push({ path: entry.path, kind: 'removed' })
        continue
      }
      if (copied.changed) changed.push({ path: entry.path, kind: 'modified' })
      files.push({ path: entry.path, size: copied.size, sha256: copied.sha256 })
    }
    if (!files.length) throw new Error('No data to back up')
    const copiedPaths = new Set(planned.map((entry) => entry.path))
    const added = await scan(sessions, yan).then((now) => now.filter((entry) => !copiedPaths.has(entry.path) && !skipParts.has(partOf(entry.path) as BackupPartId)), () => [])
    for (const entry of added) changed.push({ path: entry.path, kind: 'added' })
    const manifest: BackupManifest = {
      format: 'inkstone-backup',
      version: 2,
      createdAt,
      files,
      sources: { sessions: resolve(sessions), yan: resolve(yan) },
      ...(skipped.length ? { skipped } : {}),
      ...(changed.length ? { changed: changed.slice(0, CHANGED_LISTED), changedTotal: changed.length } : {})
    }
    await writeFile(join(path, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    return await verifyDataBackup(path)
  } catch (e) {
    const removed = await rm(path, { recursive: true, force: true }).then(() => true, () => false)
    throw new Error(`${e instanceof Error ? e.message : String(e)}${removed ? '' : `\nIncomplete backup retained: ${path}`}`)
  }
}

export async function readDataBackup(root: string): Promise<{ summary: BackupSummary; manifest: BackupManifest }> {
  const path = await realpath(root)
  const manifestPath = join(path, MANIFEST)
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Invalid backup manifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest
  if (!manifest || manifest.format !== 'inkstone-backup' || ![1, 2].includes(manifest.version) || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error('Invalid backup manifest')
  if (manifest.version === 2 && (!manifest.sources || ![manifest.sources.sessions, manifest.sources.yan].every((source) => typeof source === 'string' && source.length > 0 && source.length <= 32768 && !/[\x00-\x1f]/.test(source)))) throw new Error('Invalid backup source paths')
  let bytes = 0
  const seen = new Set<string>()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !allowed(entry.path, manifest.version) || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path.toLowerCase())) throw new Error('Invalid backup entry')
    if (metadataFile(entry.path) && entry.size > MAX_METADATA_BYTES) throw new Error(`Backup metadata is too large: ${entry.path}`)
    seen.add(entry.path.toLowerCase())
    bytes += entry.size
    if (bytes > MAX_BYTES) throw new Error('Backup is too large')
    let file = path
    for (const part of entry.path.split('/')) {
      file = join(file, part)
      if ((await lstat(file)).isSymbolicLink()) throw new Error('Backup contains a link')
    }
    const fileInfo = await stat(file)
    if (!fileInfo.isFile() || fileInfo.size !== entry.size || await hashBackupFile(file) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`)
  }
  const skipped = (Array.isArray(manifest.skipped) ? manifest.skipped : []).filter((item): item is BackupPartUsage => !!item && PART_IDS.includes(item.part) && Number.isSafeInteger(item.files) && Number.isSafeInteger(item.bytes))
  const changed = (Array.isArray(manifest.changed) ? manifest.changed : []).filter((item): item is BackupChange => !!item && typeof item.path === 'string' && (item.kind === 'modified' || item.kind === 'removed' || item.kind === 'added')).slice(0, CHANGED_LISTED)
  const changedTotal = Number.isSafeInteger(manifest.changedTotal) ? Math.max(manifest.changedTotal as number, changed.length) : changed.length
  return {
    summary: {
      path,
      createdAt: manifest.createdAt,
      files: manifest.files.length,
      bytes,
      ...(skipped.length ? { skipped } : {}),
      ...(changed.length ? { changed, changedTotal } : {})
    },
    manifest
  }
}

export async function verifyDataBackup(root: string): Promise<BackupSummary> {
  return (await readDataBackup(root)).summary
}

export function autoBackupRoot(userData: string): string {
  return join(userData, AUTO_BACKUP_DIRNAME)
}

async function pruneUpdateAutoBackups(root: string, keep: string, keepComplete: boolean): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const keepPath = resolve(keep)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (resolve(path) === keepPath) continue
    const marker = await readFile(join(path, AUTO_BACKUP_MARKER), 'utf8').catch(() => null)
    if (marker === null) continue
    let ours = false
    let partial = false
    try {
      const parsed = JSON.parse(marker) as { format?: unknown; partial?: unknown } | null
      ours = parsed?.format === 'inkstone-auto-backup'
      partial = parsed?.partial === true
    } catch {
      ours = false
    }
    if (!ours) continue
    if (keepComplete && !partial) continue
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface UpdateAutoBackupOptions {
  confirmSkip?: (info: BackupTooLarge) => Promise<BackupPartId[] | null>
  limits?: BackupOptions['limits']
}

export async function createUpdateAutoBackup(input: { userData: string; sessions: string; yan: string }, options: UpdateAutoBackupOptions = {}): Promise<BackupSummary> {
  const root = autoBackupRoot(input.userData)
  await mkdir(root, { recursive: true, mode: 0o700 })
  let summary: BackupSummary
  if (options.confirmSkip) {
    try {
      summary = await createDataBackup(root, input.sessions, input.yan, { limits: options.limits })
    } catch (error) {
      if (!(error instanceof BackupTooLargeError)) throw error
      const skip = await options.confirmSkip(error.info)
      if (!skip) throw error
      summary = await createDataBackup(root, input.sessions, input.yan, { skipParts: skip, limits: options.limits })
    }
  } else {
    summary = await createDataBackup(root, input.sessions, input.yan, { autoSkipLarge: true, limits: options.limits })
  }
  const partial = Boolean(summary.skipped?.length)
  try {
    await writeFile(
      join(summary.path, AUTO_BACKUP_MARKER),
      JSON.stringify({ format: 'inkstone-auto-backup', version: 1, createdAt: summary.createdAt, ...(partial ? { partial: true } : {}) }),
      { flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    await rm(summary.path, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await pruneUpdateAutoBackups(root, summary.path, partial)
  return summary
}
