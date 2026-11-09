import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { YAN_DIR } from './paths'
import { getSessionLayout } from './session-layout'
import { normalizeLayoutPath } from '../shared/session-path'
import { selectCompressible, type CompressCandidate } from '../shared/session-compress'

export const COMPRESS_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
export const COMPRESS_STATE_FILE = join(YAN_DIR, 'session-compress.json')

export interface ArchiveCompressionStatus {
  supported: boolean
  files: number
  savedBytes: number
}

export interface FileCompressor {
  compress(paths: readonly string[]): Promise<Map<string, number>>
}

interface StateRecord {
  path: string
  size: number
  mtimeMs: number
  disk: number
}

type State = Record<string, StateRecord>

export function parseCompactOutput(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S.*?)\s+(\d+)\s*:\s*(\d+)\s*=/.exec(line)
    if (match) out.set(basename(match[1]).toLowerCase(), Number(match[3]))
  }
  return out
}

const CHUNK_FILES = 24
const SIZE_PAIR = /(\d+)\s*:\s*(\d+)\s*=/

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, encoding: 'latin1', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
}

const windowsCompressor: FileCompressor = {
  async compress(paths) {
    const done = new Map<string, number>()
    const result = parseCompactOutput(await run('compact.exe', ['/c', '/exe:lzx', ...paths]))
    for (const path of paths) {
      let disk = result.get(basename(path).toLowerCase())
      if (disk === undefined) {
        const pair = SIZE_PAIR.exec(await run('compact.exe', [path]))
        if (pair && Number(pair[2]) < Number(pair[1])) disk = Number(pair[2])
      }
      if (disk !== undefined) done.set(path, disk)
    }
    return done
  }
}

export function compressorFor(platform: NodeJS.Platform = process.platform): FileCompressor | null {
  return platform === 'win32' ? windowsCompressor : null
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(COMPRESS_STATE_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as State) : {}
  } catch {
    return {}
  }
}

async function candidates(): Promise<CompressCandidate[]> {
  const layout = await getSessionLayout()
  const out: CompressCandidate[] = []
  for (const entry of layout.entries) {
    if (!entry.sessionFile) continue
    try {
      const info = await stat(entry.sessionFile)
      if (info.isFile()) out.push({ path: entry.sessionFile, archived: !!entry.archivedAt, size: info.size, mtimeMs: info.mtimeMs, lastOpenedAt: entry.lastOpenedAt })
    } catch {
      continue
    }
  }
  return out
}

async function summarize(state: State, supported: boolean): Promise<ArchiveCompressionStatus> {
  let files = 0
  let savedBytes = 0
  for (const record of Object.values(state)) {
    let current
    try {
      current = await stat(record.path)
    } catch {
      continue
    }
    if (current.size !== record.size || current.mtimeMs !== record.mtimeMs) continue
    files += 1
    savedBytes += Math.max(0, record.size - record.disk)
  }
  return { supported, files, savedBytes }
}

export async function archivedCompressionStatus(compressor: FileCompressor | null = compressorFor()): Promise<ArchiveCompressionStatus> {
  return summarize(await readState(), compressor !== null)
}

let inflight: Promise<ArchiveCompressionStatus> | null = null

export function compressArchivedSessions(input: { busyFiles: readonly (string | undefined)[]; now?: number; compressor?: FileCompressor | null }): Promise<ArchiveCompressionStatus> {
  inflight ??= sweep(input).finally(() => { inflight = null })
  return inflight
}

async function sweep(input: { busyFiles: readonly (string | undefined)[]; now?: number; compressor?: FileCompressor | null }): Promise<ArchiveCompressionStatus> {
  const compressor = input.compressor === undefined ? compressorFor() : input.compressor
  const state = await readState()
  if (!compressor) return summarize(state, false)
  const all = await candidates()
  const done = new Map(Object.entries(state).map(([key, record]) => [key, { size: record.size, mtimeMs: record.mtimeMs }]))
  const testIdle = Number(process.env.YAN_TEST_COMPRESS_IDLE_DAYS)
  const picked = selectCompressible(all, { now: input.now ?? Date.now(), busyFiles: input.busyFiles, done, ...(Number.isFinite(testIdle) && testIdle >= 0 && process.env.YAN_TEST_COMPRESS_IDLE_DAYS ? { idleDays: testIdle } : {}) })
  const byPath = new Map(all.map((item) => [item.path, item]))
  for (let i = 0; i < picked.length; i += CHUNK_FILES) {
    const result = await compressor.compress(picked.slice(i, i + CHUNK_FILES))
    for (const [path, disk] of result) {
      const item = byPath.get(path)
      if (!item) continue
      let after
      try {
        after = await stat(path)
      } catch {
        continue
      }
      if (after.size === item.size && after.mtimeMs === item.mtimeMs) state[normalizeLayoutPath(path)] = { path, size: item.size, mtimeMs: item.mtimeMs, disk }
    }
    await writeFile(COMPRESS_STATE_FILE, JSON.stringify(state), 'utf8')
  }
  return summarize(state, true)
}
