import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteFile } from './atomic'
import { canonicalJson, sha256Hex } from './canonical'
import { findForbiddenFields, pickSyncSettings } from './settings-whitelist'
import type { SyncPaths, SyncRecord, SyncRecordKind } from './types'

export function defaultSyncPaths(dataDir: string, piAgentDir = dataDir): SyncPaths {
  return {
    settingsFile: join(dataDir, 'desktop.json'),
    promptsDir: join(piAgentDir, 'prompts'),
    skillsDir: join(dataDir, 'skills'),
    schedulesFile: join(dataDir, 'schedules.json'),
    interactionStateDir: join(dataDir, 'interaction-state')
  }
}

interface ReadResult {
  records: SyncRecord[]
  skipped: string[]
}

export function forbiddenFieldsInRecord(record: SyncRecord): string[] {
  try {
    return findForbiddenFields(JSON.parse(record.payload))
  } catch {
    return []
  }
}

async function mtimeMs(file: string): Promise<number> {
  try {
    const info = await stat(file)
    return info.mtimeMs
  } catch {
    return 0
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

async function readSettings(paths: SyncPaths): Promise<ReadResult> {
  if (!existsSync(paths.settingsFile)) return { records: [], skipped: [] }
  try {
    const raw = await readJson(paths.settingsFile)
    const picked = pickSyncSettings(raw)
    return {
      records: [
        {
          key: 'settings',
          kind: 'settings',
          payload: canonicalJson(picked),
          modifiedAt: await mtimeMs(paths.settingsFile)
        }
      ],
      skipped: []
    }
  } catch (error) {
    return { records: [], skipped: [`${paths.settingsFile}：${describe(error)}`] }
  }
}

async function applySettings(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const incoming = pickSyncSettings(JSON.parse(record.payload))
  let current: Record<string, unknown> = {}
  if (existsSync(paths.settingsFile)) {
    try {
      const raw = await readJson(paths.settingsFile)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw as Record<string, unknown>
    } catch {
      throw new Error('本机 desktop.json 解析失败，拒绝覆盖')
    }
  }
  const merged = { ...current, ...incoming }
  await atomicWriteFile(paths.settingsFile, JSON.stringify(merged, null, 2))
}

const PROMPT_SUFFIX = '.md'

async function readPrompts(paths: SyncPaths): Promise<ReadResult> {
  const records: SyncRecord[] = []
  const skipped: string[] = []
  let entries
  try {
    entries = await readdir(paths.promptsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, skipped }
    return { records, skipped: [`${paths.promptsDir}：${describe(error)}`] }
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith(PROMPT_SUFFIX)) continue
    const name = entry.name.slice(0, -PROMPT_SUFFIX.length)
    if (!name || name !== basename(name)) continue
    const file = join(paths.promptsDir, entry.name)
    try {
      const payload = await readFile(file, 'utf8')
      records.push({ key: `prompt:${name}`, kind: 'prompt', payload, modifiedAt: await mtimeMs(file) })
    } catch (error) {
      skipped.push(`${file}：${describe(error)}`)
    }
  }
  return { records, skipped }
}

function promptNameFromKey(key: string): string | undefined {
  const name = key.startsWith('prompt:') ? key.slice('prompt:'.length) : ''
  if (!name || name !== basename(name) || name.includes('/') || name.includes('\\')) return undefined
  return name
}

async function applyPrompt(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const name = promptNameFromKey(record.key)
  if (!name) throw new Error(`提示词模板 key 非法：${record.key}`)
  await atomicWriteFile(join(paths.promptsDir, `${name}${PROMPT_SUFFIX}`), record.payload)
}

async function readSkills(paths: SyncPaths): Promise<ReadResult> {
  const records: SyncRecord[] = []
  const skipped: string[] = []
  let entries
  try {
    entries = await readdir(paths.skillsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, skipped }
    return { records, skipped: [`${paths.skillsDir}：${describe(error)}`] }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name !== basename(entry.name) || entry.name.includes('/') || entry.name.includes('\\')) continue
    if (!/^[\w.-]+$/.test(entry.name)) continue
    const file = join(paths.skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const payload = await readFile(file, 'utf8')
      records.push({ key: `skill:${entry.name}`, kind: 'skill', payload, modifiedAt: await mtimeMs(file) })
    } catch (error) {
      skipped.push(`${file}：${describe(error)}`)
    }
  }
  return { records, skipped }
}

function skillNameFromKey(key: string): string | undefined {
  const name = key.startsWith('skill:') ? key.slice('skill:'.length) : ''
  if (!name || name !== basename(name) || !/^[\w.-]+$/.test(name)) return undefined
  return name
}

async function applySkill(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const name = skillNameFromKey(record.key)
  if (!name) throw new Error(`技能 key 非法：${record.key}`)
  await mkdir(join(paths.skillsDir, name), { recursive: true })
  await atomicWriteFile(join(paths.skillsDir, name, 'SKILL.md'), record.payload)
}

interface BookmarkPayload {
  session: string
  key: string
  value: string
}

function bookmarkKey(session: string, valueKey: string): string {
  return `bookmark:${sha256Hex(`${session}\u0000${valueKey}`).slice(0, 32)}`
}

function interactionFile(paths: SyncPaths, session: string): string {
  return join(paths.interactionStateDir, `${sha256Hex(session)}.json`)
}

function parseBookmarkPayload(record: SyncRecord): BookmarkPayload {
  const parsed = JSON.parse(record.payload) as Partial<BookmarkPayload>
  const session = typeof parsed?.session === 'string' ? parsed.session : ''
  const key = typeof parsed?.key === 'string' ? parsed.key : ''
  const value = typeof parsed?.value === 'string' ? parsed.value : ''
  if (!session || !key.startsWith('bookmark:') || typeof parsed?.value !== 'string') {
    throw new Error(`书签记录形状无效：${record.key}`)
  }
  return { session, key, value }
}

async function readBookmarks(paths: SyncPaths): Promise<ReadResult> {
  const records: SyncRecord[] = []
  const skipped: string[] = []
  let entries
  try {
    entries = await readdir(paths.interactionStateDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, skipped }
    return { records, skipped: [`${paths.interactionStateDir}：${describe(error)}`] }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    const file = join(paths.interactionStateDir, entry.name)
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as {
        version?: unknown
        session?: unknown
        values?: unknown
      }
      const session = typeof raw?.session === 'string' ? raw.session : ''
      if (raw?.version !== 1 || !session || !raw.values || typeof raw.values !== 'object' || Array.isArray(raw.values)) {
        skipped.push(`${file}：交互状态结构无效`)
        continue
      }
      const modifiedAt = await mtimeMs(file)
      for (const [valueKey, value] of Object.entries(raw.values as Record<string, unknown>)) {
        if (!valueKey.startsWith('bookmark:') || typeof value !== 'string') continue
        records.push({
          key: bookmarkKey(session, valueKey),
          kind: 'bookmark',
          payload: canonicalJson({ session, key: valueKey, value }),
          modifiedAt
        })
      }
    } catch (error) {
      skipped.push(`${file}：${describe(error)}`)
    }
  }
  return { records, skipped }
}

async function applyBookmark(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const { session, key, value } = parseBookmarkPayload(record)
  const file = interactionFile(paths, session)
  let values: Record<string, string> = {}
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; session?: unknown; values?: unknown }
      if (raw?.version === 1 && raw.session === session && raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values)) {
        for (const [k, v] of Object.entries(raw.values as Record<string, unknown>)) {
          if (typeof v === 'string') values[k] = v
        }
      }
    } catch {
      throw new Error(`本机交互状态无法解析，拒绝覆盖：${file}`)
    }
  }
  values[key] = value
  await mkdir(paths.interactionStateDir, { recursive: true })
  await atomicWriteFile(file, JSON.stringify({ version: 1, session, values }))
}

export function pickScheduleDefinition(task: unknown): Record<string, unknown> | null {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null
  const source = task as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id : ''
  if (!id || !/^[\w.-]+$/.test(id)) return null
  const out: Record<string, unknown> = { id }
  for (const key of ['name', 'prompt', 'model', 'trigger', 'enabled', 'pendingApproval', 'createdBy', 'createdAt']) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

async function readSchedules(paths: SyncPaths): Promise<ReadResult> {
  if (!existsSync(paths.schedulesFile)) return { records: [], skipped: [] }
  try {
    const raw = JSON.parse(await readFile(paths.schedulesFile, 'utf8')) as { tasks?: unknown }
    if (!raw || !Array.isArray(raw.tasks)) return { records: [], skipped: [`${paths.schedulesFile}：tasks 不是数组`] }
    const modifiedAt = await mtimeMs(paths.schedulesFile)
    const records: SyncRecord[] = []
    for (const task of raw.tasks) {
      const definition = pickScheduleDefinition(task)
      if (!definition) continue
      records.push({
        key: `schedule:${definition.id as string}`,
        kind: 'schedule',
        payload: canonicalJson(definition),
        modifiedAt
      })
    }
    return { records, skipped: [] }
  } catch (error) {
    return { records: [], skipped: [`${paths.schedulesFile}：${describe(error)}`] }
  }
}

async function applySchedule(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const incoming = pickScheduleDefinition(JSON.parse(record.payload))
  if (!incoming) throw new Error(`定时任务记录形状无效：${record.key}`)
  let doc: { v?: unknown; tasks?: unknown } = { v: 1, tasks: [] }
  if (existsSync(paths.schedulesFile)) {
    try {
      const raw = JSON.parse(await readFile(paths.schedulesFile, 'utf8')) as { v?: unknown; tasks?: unknown }
      if (raw && typeof raw === 'object' && Array.isArray(raw.tasks)) doc = raw
    } catch {
      throw new Error('本机 schedules.json 解析失败，拒绝覆盖')
    }
  }
  const tasks = Array.isArray(doc.tasks) ? (doc.tasks as Record<string, unknown>[]) : []
  const index = tasks.findIndex((task) => task && typeof task === 'object' && (task as Record<string, unknown>).id === incoming.id)
  if (index >= 0) {
    tasks[index] = { ...tasks[index], ...incoming }
  } else {
    tasks.push(incoming)
  }
  await atomicWriteFile(paths.schedulesFile, JSON.stringify({ v: 1, tasks }, null, 2))
}

export class LocalStore {
  constructor(readonly paths: SyncPaths) {}

  async readAll(): Promise<ReadResult> {
    const parts = await Promise.all([
      readSettings(this.paths),
      readPrompts(this.paths),
      readSkills(this.paths),
      readBookmarks(this.paths),
      readSchedules(this.paths)
    ])
    return {
      records: parts.flatMap((part) => part.records),
      skipped: parts.flatMap((part) => part.skipped)
    }
  }

  async apply(record: SyncRecord): Promise<void> {
    switch (record.kind) {
      case 'settings':
        return applySettings(this.paths, record)
      case 'prompt':
        return applyPrompt(this.paths, record)
      case 'skill':
        return applySkill(this.paths, record)
      case 'bookmark':
        return applyBookmark(this.paths, record)
      case 'schedule':
        return applySchedule(this.paths, record)
      default: {
        const never: never = record.kind
        throw new Error(`未知的同步类别：${String(never)}`)
      }
    }
  }
}

export function isRecordKind(value: unknown): value is SyncRecordKind {
  return value === 'settings' || value === 'prompt' || value === 'skill' || value === 'bookmark' || value === 'schedule'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
