import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import { readPersistedJson } from './persisted-document'

export const RESTORE_INCOMPLETE_MARKER = 'restore-incomplete.json'

export interface IncompleteRestore {
  path: string
  at: number
  error?: string
}

interface RegistryEntry {
  path: string
  at: number
}

function same(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

let tail: Promise<unknown> = Promise.resolve()

function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job)
  tail = run.catch(() => undefined)
  return run
}

function parseRegistry(value: unknown): RegistryEntry[] {
  const list = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined
  if (!Array.isArray(list)) return []
  return list.filter((item): item is RegistryEntry => !!item && typeof (item as RegistryEntry).path === 'string' && Number.isFinite((item as RegistryEntry).at))
}

function readRegistry(file: string): Promise<RegistryEntry[]> {
  return readPersistedJson(file, parseRegistry, () => [])
}

function writeRegistry(file: string, entries: RegistryEntry[]): Promise<void> {
  return atomicWriteFile(file, JSON.stringify({ version: 1, entries }, null, 2))
}

export async function writeIncompleteMarker(dir: string, info: { source: string; startedAt: string; error?: string }): Promise<void> {
  await writeFile(join(dir, RESTORE_INCOMPLETE_MARKER), JSON.stringify({ format: 'inkstone-restore-incomplete', version: 1, ...info }, null, 2), { mode: 0o600 })
}

export async function clearIncompleteMarker(dir: string): Promise<void> {
  await rm(join(dir, RESTORE_INCOMPLETE_MARKER), { force: true })
}

async function readMarker(dir: string): Promise<{ error?: string } | null> {
  try {
    const marker = JSON.parse(await readFile(join(dir, RESTORE_INCOMPLETE_MARKER), 'utf8')) as { format?: unknown; error?: unknown }
    if (marker?.format !== 'inkstone-restore-incomplete') return null
    return typeof marker.error === 'string' ? { error: marker.error } : {}
  } catch {
    return null
  }
}

export function registerIncompleteRestore(file: string, dir: string): Promise<void> {
  return serial(async () => {
    const entries = await readRegistry(file)
    if (entries.some((item) => same(item.path, dir))) return
    await writeRegistry(file, [...entries, { path: resolve(dir), at: Date.now() }])
  })
}

export function forgetIncompleteRestore(file: string, dir: string): Promise<void> {
  return serial(async () => {
    const entries = await readRegistry(file)
    const next = entries.filter((item) => !same(item.path, dir))
    if (next.length !== entries.length) await writeRegistry(file, next)
  })
}

export function listIncompleteRestores(file: string): Promise<IncompleteRestore[]> {
  return serial(async () => {
    const entries = await readRegistry(file)
    const live: IncompleteRestore[] = []
    for (const item of entries) {
      const marker = await readMarker(item.path)
      if (marker) live.push({ path: item.path, at: item.at, ...(marker.error ? { error: marker.error } : {}) })
    }
    if (live.length !== entries.length) await writeRegistry(file, live.map((item) => ({ path: item.path, at: item.at })))
    return live
  })
}

export function trashIncompleteRestore(file: string, dir: string, trash: (path: string) => Promise<void>): Promise<boolean> {
  return serial(async () => {
    const entries = await readRegistry(file)
    const entry = entries.find((item) => same(item.path, dir))
    if (!entry || !(await readMarker(entry.path))) return false
    await trash(entry.path)
    await writeRegistry(file, entries.filter((item) => item !== entry))
    return true
  })
}
