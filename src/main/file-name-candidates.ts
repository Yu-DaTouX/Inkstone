import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileNameSearchSource } from '../shared/file-name-search'
import { sanitizedGitEnv } from './git-run-policy'

export const MAX_CANDIDATE_FILES = 10_000
export const MAX_WALK_ENTRIES = 25_000
export const MAX_WALK_DIRS = 2_000
export const MAX_WALK_DEPTH = 24
const MAX_GIT_OUTPUT = 16 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg'])

export interface NameCandidate {
  path: string
  directory: boolean
}

export interface CandidateSet {
  source: FileNameSearchSource
  candidates: NameCandidate[]
  truncated: boolean
}

export function withParentDirs(files: readonly string[]): NameCandidate[] {
  const dirs = new Set<string>()
  const out: NameCandidate[] = []
  for (const file of files) {
    out.push({ path: file, directory: false })
    let cut = file.lastIndexOf('/')
    while (cut > 0) {
      const dir = file.slice(0, cut)
      if (dirs.has(dir)) break
      dirs.add(dir)
      cut = dir.lastIndexOf('/')
    }
  }
  for (const dir of dirs) out.push({ path: dir, directory: true })
  return out
}

export function parseLsFiles(stdout: string, limit = MAX_CANDIDATE_FILES): { files: string[]; truncated: boolean } {
  const seen = new Set<string>()
  const files: string[] = []
  let truncated = false
  for (const raw of stdout.split('\0')) {
    if (!raw || seen.has(raw)) continue
    if (files.length >= limit) {
      truncated = true
      break
    }
    seen.add(raw)
    files.push(raw)
  }
  return { files, truncated }
}

function gitLsFiles(root: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, windowsHide: true, env: sanitizedGitEnv(process.env, { GIT_OPTIONAL_LOCKS: '0' }) }
    )
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => {
      child.kill()
      finish(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_GIT_OUTPUT) {
        child.kill()
        finish(Buffer.concat(chunks).toString('utf8'))
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null))
  })
}

export async function walkFiles(root: string, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }]
  let entries = 0
  let dirs = 0
  let truncated = false
  while (queue.length && !signal?.aborted) {
    const current = queue.shift()!
    if (dirs >= MAX_WALK_DIRS) {
      truncated = true
      break
    }
    dirs += 1
    const dirents = await readdir(current.abs, { withFileTypes: true }).catch(() => [])
    for (const entry of dirents) {
      entries += 1
      if (entries > MAX_WALK_ENTRIES || files.length >= MAX_CANDIDATE_FILES) {
        truncated = true
        return { files, truncated }
      }
      if (entry.isSymbolicLink()) continue
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (current.depth + 1 > MAX_WALK_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ abs: join(current.abs, entry.name), rel, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  return { files, truncated }
}

export async function collectCandidates(root: string, signal?: AbortSignal): Promise<CandidateSet> {
  const listed = await gitLsFiles(root, signal)
  if (listed !== null) {
    const parsed = parseLsFiles(listed)
    return { source: 'git', candidates: withParentDirs(parsed.files), truncated: parsed.truncated }
  }
  if (signal?.aborted) return { source: 'none', candidates: [], truncated: false }
  const walked = await walkFiles(root, signal)
  return { source: 'walk', candidates: withParentDirs(walked.files), truncated: walked.truncated }
}
