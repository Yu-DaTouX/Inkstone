import { readdir, readlink, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { isWithin, lexicalJoin, pathKey } from './file-path-gate'
import type {
  DirEntry,
  DirEntryLink,
  DirListing,
  FileListingStatus,
  FileRequestContext,
  FileSearchEntry,
  FileSearchRequest,
  FileSearchResult
} from '../shared/ipc'

const OPAQUE = new Set(['node_modules', '.git', '.svn', '.hg'])

function isDotName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

const MAX_ENTRIES = 500

const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DIRS = 2000

export { isWithin, pathKey }

function statusForError(error: unknown): FileListingStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  return 'error'
}

function nameSort(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

export function safeJoin(cwd: string, rel: string): string | null {
  return lexicalJoin(cwd, rel)
}

export function classifyLink(rootReal: string, containingReal: string, targetReal: string | null): DirEntryLink['state'] {
  if (!targetReal) return 'dangling'
  if (!isWithin(rootReal, targetReal)) return 'external'
  if (isWithin(targetReal, containingReal)) return 'cycle'
  return 'ok'
}

async function describeLink(rootReal: string, dirReal: string, name: string): Promise<{ link: DirEntryLink; dir: boolean }> {
  const abs = join(dirReal, name)
  const rawTarget = await readlink(abs).catch(() => '')
  const targetReal = await realpath(abs).catch(() => null)
  const state = classifyLink(rootReal, dirReal, targetReal)
  const targetIsDir = targetReal ? await stat(targetReal).then((s) => s.isDirectory(), () => false) : false
  const link: DirEntryLink = { state, ...(rawTarget ? { target: rawTarget } : {}), ...(targetReal ? { targetKind: targetIsDir ? 'dir' : 'file' } : {}) }
  return { link, dir: state === 'ok' && targetIsDir }
}

const HOME = homedir()

function displayPath(abs: string): string {
  if (abs.startsWith(HOME)) return '~' + abs.slice(HOME.length).replace(/\\/g, '/')
  return abs.replace(/\\/g, '/')
}

export async function listDir(
  cwd: string,
  rel = '',
  showHidden = false,
  request?: FileRequestContext
): Promise<DirListing> {
  const root = await realpath(cwd).catch(() => resolve(cwd))
  const abs = safeJoin(root, rel)
  const empty: DirListing = {
    path: rel ?? '',
    abs: '',
    entries: [],
    skipped: [],
    truncated: false,
    status: 'invalid',
    ...(request ? { request } : {})
  }
  if (!abs || !isWithin(root, abs)) return empty

  let realDir: string
  try {
    realDir = await realpath(abs)
  } catch (error) {
    const status = statusForError(error)
    return {
      ...empty,
      abs: displayPath(abs),
      status,
      error: status === 'permission' ? 'permission' : status === 'missing' ? 'missing' : 'error'
    }
  }
  if (!isWithin(root, realDir)) {
    return { ...empty, status: 'invalid', error: 'invalid' }
  }

  let dirents: Dirent[]
  try {
    dirents = await readdir(realDir, { withFileTypes: true })
  } catch (error) {
    const status = statusForError(error)
    return {
      ...empty,
      abs: displayPath(realDir),
      status,
      error: status === 'permission' ? 'permission' : status === 'missing' ? 'missing' : 'error'
    }
  }

  const skipped: string[] = []
  const dirs: { name: string; dir: true; link?: DirEntryLink }[] = []
  const files: { name: string; dir: false; link?: DirEntryLink }[] = []
  const linkNames = dirents.filter((d) => d.isSymbolicLink() && (showHidden || !isDotName(d.name))).map((d) => d.name)
  const links = new Map<string, { link: DirEntryLink; dir: boolean }>()
  for (let i = 0; i < linkNames.length; i += 32) {
    await Promise.all(linkNames.slice(i, i + 32).map(async (name) => links.set(name, await describeLink(root, realDir, name))))
  }
  for (const d of dirents) {
    if (d.isSymbolicLink()) {
      const described = links.get(d.name)
      if (!described || (!showHidden && described.dir && OPAQUE.has(d.name))) {
        skipped.push(d.name)
        continue
      }
      if (described.dir) dirs.push({ name: d.name, dir: true, link: described.link })
      else files.push({ name: d.name, dir: false, link: described.link })
      continue
    }
    const isDir = d.isDirectory()
    const opaque = isDir && OPAQUE.has(d.name)
    const dotted = isDotName(d.name)
    if (!showHidden && (opaque || dotted)) {
      skipped.push(d.name)
      continue
    }
    if (isDir) dirs.push({ name: d.name, dir: true })
    else files.push({ name: d.name, dir: false })
  }

  dirs.sort(nameSort)
  files.sort(nameSort)

  const all = [...dirs, ...files]
  const truncated = all.length > MAX_ENTRIES
  const kept = truncated ? all.slice(0, MAX_ENTRIES) : all

  const sizes = new Map<string, number>()
  const CHUNK = 64
  for (let i = 0; i < kept.length; i += CHUNK) {
    const slice = kept.slice(i, i + CHUNK).filter((e) => !e.dir && (!e.link || e.link.state === 'ok'))
    await Promise.all(
      slice.map(async (e) => {
        try {
          const st = await stat(join(realDir, e.name))
          sizes.set(e.name, st.size)
        } catch {
        }
      })
    )
  }

  const entries: DirEntry[] = kept.map((e) => {
    const size = e.dir ? undefined : sizes.get(e.name)
    return { name: e.name, dir: e.dir, ...(size !== undefined ? { size } : {}), ...(e.link ? { link: e.link } : {}) }
  })

  return {
    path: rel ?? '',
    abs: displayPath(realDir),
    entries,
    skipped: skipped.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })),
    truncated,
    status: entries.length ? 'ok' : 'empty',
    totalEntries: all.length,
    ...(request ? { request } : {}),
    ...(rel ? {} : { rootName: basename(realDir) || realDir })
  }
}

export async function searchFiles(request: FileSearchRequest, signal?: AbortSignal): Promise<FileSearchResult> {
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(request.limit ?? MAX_SEARCH_RESULTS)))
  const query = String(request.query ?? '').trim().toLocaleLowerCase()
  const baseResult = (status: FileSearchResult['status'], entries: FileSearchEntry[] = [], truncated = false, scannedDirs = 0, skippedDirs = 0): FileSearchResult => ({
    request,
    entries,
    status,
    truncated,
    scannedDirs,
    skippedDirs
  })

  if (!query) return baseResult('empty')

  let root: string
  try {
    root = await realpath(request.cwd)
    if (!(await stat(root)).isDirectory()) return baseResult('invalid')
  } catch (error) {
    return baseResult(statusForError(error))
  }

  const entries: FileSearchEntry[] = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  let scannedDirs = 0
  let skippedDirs = 0
  let hadReadError = false
  let truncated = false

  const matches = (name: string, rel: string): boolean =>
    name.toLocaleLowerCase().includes(query) || rel.toLocaleLowerCase().includes(query)

  while (queue.length) {
    if (signal?.aborted) return baseResult('cancelled', entries, truncated, scannedDirs, skippedDirs)
    if (scannedDirs >= MAX_SEARCH_DIRS) {
      truncated = true
      break
    }

    const current = queue.shift()!
    scannedDirs += 1
    let dirents: Dirent[]
    try {
      dirents = await readdir(current.abs, { withFileTypes: true })
    } catch (error) {
      hadReadError = true
      if (current.rel === '') return baseResult(statusForError(error), entries, truncated, scannedDirs, skippedDirs)
      continue
    }

    const dirs: Dirent[] = []
    const files: Dirent[] = []
    for (const entry of dirents) {
      if (signal?.aborted) return baseResult('cancelled', entries, truncated, scannedDirs, skippedDirs)
      if (entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (OPAQUE.has(entry.name)) {
          skippedDirs += 1
          continue
        }
        dirs.push(entry)
      } else {
        files.push(entry)
      }
    }
    dirs.sort(nameSort)
    files.sort(nameSort)

    for (const entry of [...dirs, ...files]) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      if (matches(entry.name, rel)) {
        entries.push({ path: rel, name: entry.name, dir: entry.isDirectory() })
        if (entries.length >= limit) {
          truncated = true
          break
        }
      }
      if (entry.isDirectory()) {
        if (scannedDirs + queue.length >= MAX_SEARCH_DIRS) {
          truncated = true
          break
        }
        queue.push({ abs: join(current.abs, entry.name), rel })
      }
    }
    if (truncated) break

    await new Promise<void>((resolveNext) => setImmediate(resolveNext))
  }

  const status: FileSearchResult['status'] =
    signal?.aborted ? 'cancelled' : hadReadError ? (entries.length ? 'partial' : 'permission') : truncated ? 'partial' : entries.length ? 'ok' : 'empty'
  return baseResult(status, entries, truncated, scannedDirs, skippedDirs)
}
