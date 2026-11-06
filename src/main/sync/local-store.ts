import { pick } from '../../shared/ui-lang'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWriteFile } from './atomic'
import { canonicalJson, sha256Hex } from './canonical'
import { findForbiddenFields, pickSyncSettings } from './settings-whitelist'
import type { AppSettings } from '../../shared/ipc'
import type { SyncPaths, SyncRecord, SyncRecordKind } from './types'

export function defaultSyncPaths(dataDir: string, piAgentDir = dataDir): SyncPaths {
  return {
    settingsFile: join(dataDir, 'desktop.json'),
    promptsDir: join(piAgentDir, 'prompts'),
    skillsDir: join(dataDir, 'skills'),
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

async function writeSettings(paths: SyncPaths, incoming: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {}
  if (existsSync(paths.settingsFile)) {
    try {
      const raw = await readJson(paths.settingsFile)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw as Record<string, unknown>
    } catch {
      throw new Error(pick('本机 desktop.json 解析失败，拒绝覆盖', 'Failed to parse local desktop.json; overwrite refused'))
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
  if (!name) throw new Error(pick(`提示词模板 key 非法：${record.key}`, `Invalid prompt template key: ${record.key}`))
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
      await checkedSkillFile(paths, entry.name)
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
  if (!name || name === '.' || name === '..' || name !== basename(name) || !/^[\w.-]+$/.test(name)) return undefined
  return name
}

async function applySkill(paths: SyncPaths, record: SyncRecord): Promise<void> {
  const name = skillNameFromKey(record.key)
  if (!name) throw new Error(pick(`技能 key 非法：${record.key}`, `Invalid skill key: ${record.key}`))
  await mkdir(paths.skillsDir, { recursive: true })
  const file = await checkedSkillFile(paths, name)
  await mkdir(join(paths.skillsDir, name), { recursive: true })
  await checkedSkillFile(paths, name)
  await atomicWriteFile(file, record.payload)
}

async function checkedSkillFile(paths: SyncPaths, name: string): Promise<string> {
  const root = await realpath(paths.skillsDir)
  const directory = resolve(root, name)
  const file = join(directory, 'SKILL.md')
  const check = (target: string): void => {
    const tail = relative(root, target)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) {
      throw new Error(pick(`技能路径越界：${name}`, `Skill path escapes its folder: ${name}`))
    }
  }
  check(directory)
  for (const target of [directory, file]) {
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    check(await realpath(target))
  }
  return file
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
    throw new Error(pick(`书签记录形状无效：${record.key}`, `Invalid bookmark record shape: ${record.key}`))
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
        skipped.push(pick(`${file}：交互状态结构无效`, `${file}: invalid interaction state structure`))
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

async function applyBookmark(paths: SyncPaths, record: SyncRecord, exclusive = false): Promise<void> {
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
      throw new Error(pick(`本机交互状态无法解析，拒绝覆盖：${file}`, `Local interaction state could not be parsed; overwrite refused: ${file}`))
    }
  }
  if (exclusive && Object.hasOwn(values, key)) throw new Error(pick(`书签副本已存在：${key}`, `Bookmark copy already exists: ${key}`))
  values[key] = value
  await mkdir(paths.interactionStateDir, { recursive: true })
  await atomicWriteFile(file, JSON.stringify({ version: 1, session, values }))
}

export interface LocalStoreAppliers {
  applySettings?: (patch: Partial<AppSettings>) => Promise<void>
}

export class LocalStore {
  private copyChain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly paths: SyncPaths,
    private readonly appliers: LocalStoreAppliers = {}
  ) {}

  async readAll(): Promise<ReadResult> {
    const parts = await Promise.all([
      readSettings(this.paths),
      readPrompts(this.paths),
      readSkills(this.paths),
      readBookmarks(this.paths)
    ])
    return {
      records: parts.flatMap((part) => part.records),
      skipped: parts.flatMap((part) => part.skipped)
    }
  }

  applyCopy(record: SyncRecord): Promise<void> {
    const run = this.copyChain.then(() => this.createCopy(record))
    this.copyChain = run.catch(() => undefined)
    return run
  }

  private async createCopy(record: SyncRecord): Promise<void> {
    if (record.kind === 'prompt') {
      const name = promptNameFromKey(record.key)
      if (!name) throw new Error(pick(`提示词模板 key 非法：${record.key}`, `Invalid prompt template key: ${record.key}`))
      await mkdir(this.paths.promptsDir, { recursive: true })
      await writeFile(join(this.paths.promptsDir, `${name}${PROMPT_SUFFIX}`), record.payload, { flag: 'wx', mode: 0o600 })
      return
    }
    if (record.kind === 'skill') {
      const name = skillNameFromKey(record.key)
      if (!name) throw new Error(pick(`技能 key 非法：${record.key}`, `Invalid skill key: ${record.key}`))
      await mkdir(this.paths.skillsDir, { recursive: true })
      const file = await checkedSkillFile(this.paths, name)
      await mkdir(dirname(file))
      await writeFile(file, record.payload, { flag: 'wx', mode: 0o600 })
      return
    }
    if (record.kind !== 'bookmark') throw new Error(pick('不支持此类同步副本', 'This kind of sync copy is not supported'))
    await applyBookmark(this.paths, record, true)
  }

  async apply(record: SyncRecord): Promise<void> {
    switch (record.kind) {
      case 'settings': {
        const patch = pickSyncSettings(JSON.parse(record.payload))
        if (this.appliers.applySettings) return this.appliers.applySettings(patch as Partial<AppSettings>)
        return writeSettings(this.paths, patch)
      }
      case 'prompt':
        return applyPrompt(this.paths, record)
      case 'skill':
        return applySkill(this.paths, record)
      case 'bookmark':
        return applyBookmark(this.paths, record)
      default: {
        const never: never = record.kind
        throw new Error(pick(`未知的同步类别：${String(never)}`, `Unknown sync kind: ${String(never)}`))
      }
    }
  }
}

export function isRecordKind(value: unknown): value is SyncRecordKind {
  return value === 'settings' || value === 'prompt' || value === 'skill' || value === 'bookmark'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
