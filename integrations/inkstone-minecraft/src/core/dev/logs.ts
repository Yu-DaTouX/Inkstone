import { existsSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CrashSummary } from '../../shared/dev-api.ts'

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

const LEVEL_PATTERN = /\/(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\]/
const VANILLA_FRAMES = /^(java\.|javax\.|jdk\.|sun\.|com\.sun\.|net\.minecraft\.|com\.mojang\.|net\.fabricmc\.|org\.spongepowered\.|org\.lwjgl\.|com\.google\.|org\.apache\.|io\.netty\.|it\.unimi\.|dev\.inkstone\.companion\.)/

export async function tailFile(file: string, maxBytes = 512 * 1024): Promise<string> {
  if (!existsSync(file)) return ''
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

export interface LogEntry {
  level: LogLevel | null
  lines: string[]
}

export function groupLogEntries(text: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(LEVEL_PATTERN)
    const startsEntry = /^\[\d{2}:\d{2}:\d{2}/.test(line) || match
    if (startsEntry || !entries.length) {
      const level = match ? (match[1] === 'FATAL' ? 'ERROR' : match[1] === 'TRACE' ? 'DEBUG' : (match[1] as LogLevel)) : null
      entries.push({ level, lines: [line] })
    } else {
      entries[entries.length - 1].lines.push(line)
    }
  }
  return entries
}

export function filterLog(text: string, options: { lines?: number; filter?: string; levels?: LogLevel[] }): string[] {
  let entries = groupLogEntries(text)
  if (options.levels?.length) entries = entries.filter((entry) => entry.level && options.levels!.includes(entry.level))
  if (options.filter) {
    let pattern: RegExp
    try {
      pattern = new RegExp(options.filter, 'i')
    } catch {
      pattern = new RegExp(options.filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    entries = entries.filter((entry) => entry.lines.some((line) => pattern.test(line)))
  }
  const flat = entries.flatMap((entry) => entry.lines)
  const limit = options.lines ?? 200
  return flat.slice(-limit)
}

export function summarizeCrash(text: string, file: string, at: number): CrashSummary {
  const lines = text.split(/\r?\n/)
  const description = lines.find((line) => line.startsWith('Description:'))?.slice('Description:'.length).trim() ?? null
  let exception: string | null = null
  const descIndex = lines.findIndex((line) => line.startsWith('Description:'))
  if (descIndex >= 0) exception = lines.slice(descIndex + 1).find((line) => line.trim() && !line.startsWith('\t'))?.trim() ?? null
  if (!exception) exception = lines.find((line) => /^(# )?(Exception|Error|java\.|EXCEPTION_)/.test(line.trim()))?.trim() ?? null
  const frames = new Set<string>()
  for (const line of lines) {
    const frame = line.match(/^\s+at (?:[\w.$-]+\/{1,2})?([\w$.]+)\.[\w$<>]+\(/)
    if (frame && !VANILLA_FRAMES.test(frame[1])) frames.add(frame[1])
    if (frames.size >= 8) break
  }
  return { file, at, description, exception, suspectFrames: [...frames], head: lines.slice(0, 60).join('\n') }
}

export async function listCrashes(workingDir: string, limit = 5): Promise<CrashSummary[]> {
  const candidates: Array<{ file: string; at: number }> = []
  const crashDir = join(workingDir, 'crash-reports')
  for (const [dir, pattern] of [[crashDir, /^crash-.*\.txt$/], [workingDir, /^hs_err_pid\d+\.log$/]] as const) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!pattern.test(name)) continue
      const file = join(dir, name)
      candidates.push({ file, at: (await stat(file)).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.at - a.at)
  const result: CrashSummary[] = []
  for (const candidate of candidates.slice(0, limit)) {
    result.push(summarizeCrash(await readFile(candidate.file, 'utf8'), candidate.file, candidate.at))
  }
  return result
}
