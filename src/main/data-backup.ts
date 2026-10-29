import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BackupSummary } from '../shared/data-backup'

type Entry = { path: string; size: number; sha256: string }
export type BackupManifest = { format: 'inkstone-backup'; version: 1 | 2; createdAt: string; files: Entry[]; sources?: { sessions: string; yan: string } }
type Source = { path: string; source: string; size: number; mtime: number }
const MAX_FILES = 50000
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const MAX_BYTES = 10 * 1024 ** 3
const MANIFEST = 'manifest.json'

function allowed(path: string, version: 1 | 2): boolean {
  if (!path || path.includes('\\') || path.split('/').some((p) => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) return false
  if (path === 'yan/desktop.json' || /^sessions\/.+\.jsonl$/.test(path) || /^yan\/interaction-state\/[a-f0-9]{64}\.json$/.test(path)) return true
  return version === 2 && (['yan/session-chains.json', 'yan/session-layout.json', 'yan/manual-titles.json', 'yan/titles.json'].includes(path) || /^yan\/(attachments|artifacts|session-quotes)\/.+/.test(path) && !path.endsWith('.tmp'))
}

export async function hashBackupFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

function metadataFile(path: string): boolean {
  return /^yan\/(desktop\.json|(?:manual-)?titles\.json|session-(?:chains|layout)\.json|interaction-state\/[a-f0-9]{64}\.json|artifacts\/[^/]+\/manifest\.json)$/.test(path)
}

async function scan(sessions: string, yan: string): Promise<Source[]> {
  const files: Source[] = []
  let bytes = 0
  const visit = async (source: string, path: string, depth: number): Promise<void> => {
    if (depth > 20) throw new Error('Backup directory is too deep')
    let info
    try { info = await lstat(source) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    if (info.isSymbolicLink()) throw new Error(`Backup does not follow links: ${path}`)
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await visit(join(source, name), `${path}/${name}`, depth + 1)
    } else if (info.isFile() && allowed(path, 2)) {
      if (metadataFile(path) && info.size > MAX_METADATA_BYTES) throw new Error(`Backup metadata is too large: ${path}`)
      bytes += info.size
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error('Backup limit exceeded (50,000 files / 10 GiB)')
      files.push({ path, source, size: info.size, mtime: info.mtimeMs })
    }
  }
  await visit(sessions, 'sessions', 0)
  await visit(join(yan, 'desktop.json'), 'yan/desktop.json', 0)
  await visit(join(yan, 'interaction-state'), 'yan/interaction-state', 0)
  for (const name of ['session-chains.json', 'session-layout.json', 'manual-titles.json', 'titles.json', 'attachments', 'artifacts', 'session-quotes']) await visit(join(yan, name), `yan/${name}`, 0)
  return files
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

export async function createDataBackup(parent: string, sessions: string, yan: string): Promise<BackupSummary> {
  const target = await realpath(parent)
  for (const source of [sessions, yan]) {
    const actual = await realpath(source).catch(() => resolve(source))
    if (inside(actual, target)) throw new Error('Choose a folder outside the source data')
  }
  const before = await scan(sessions, yan)
  if (!before.length) throw new Error('No data to back up')
  const createdAt = new Date().toISOString()
  const path = join(target, `Inkstone-backup-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(path, { recursive: false, mode: 0o700 })
  const files: Entry[] = []
  try {
    for (const entry of before) {
      const dest = join(path, ...entry.path.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(entry.source, dest, 1)
      const sha256 = await hashBackupFile(dest)
      if (sha256 !== await hashBackupFile(entry.source)) throw new Error('Source changed during backup; retry when idle')
      files.push({ path: entry.path, size: entry.size, sha256 })
    }
    if (JSON.stringify(before) !== JSON.stringify(await scan(sessions, yan))) throw new Error('Source changed during backup; retry when idle')
    const manifest: BackupManifest = { format: 'inkstone-backup', version: 2, createdAt, files, sources: { sessions: resolve(sessions), yan: resolve(yan) } }
    await writeFile(join(path, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    return await verifyDataBackup(path)
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nIncomplete backup retained: ${path}`)
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
  return { summary: { path, createdAt: manifest.createdAt, files: manifest.files.length, bytes }, manifest }
}

export async function verifyDataBackup(root: string): Promise<BackupSummary> {
  return (await readDataBackup(root)).summary
}
