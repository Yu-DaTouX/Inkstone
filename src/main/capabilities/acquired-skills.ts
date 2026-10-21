import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { reviewSkillFiles, type SkillSecurityFinding, type SkillSecurityReview } from '../../shared/skill-security'
import { USER_SKILL_NAME_PATTERN } from '../../shared/user-skill'
import { userSkillsDir } from '../user-skills'

export type AcquiredSkillScope = 'session' | 'user'
export type SkillFileInput = { path: string; content: string | Uint8Array }
export type AcquiredSkillFile = { path: string; content: Uint8Array }
export type AcquiredSkillSource = { candidateId: string; url?: string; repository?: string; commit?: string }

export type SessionSkillEntry = {
  name: string
  description: string
  candidateId: string
  sourceUrl?: string
  commit?: string
  installedAt: string
  skillFile: string
  fileCount: number
}

type SessionSkillIndex = { version: 1; sessionId: string; skills: SessionSkillEntry[] }

export const SOURCE_META_FILE = '.inkstone-skill.json'
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

export class AcquiredSkillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AcquiredSkillError'
  }
}

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!field) continue
    let value = field[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim())
      value = block.join(' ').trim()
    } else if (/^["']/.test(value)) {
      const quote = value[0]
      value = value.endsWith(quote) && value.length > 1 ? value.slice(1, -1) : value.slice(1)
      if (quote === '"') value = value.replace(/\\"/g, '"')
    }
    value = value.replace(/\s+/g, ' ').trim()
    if (value) out[field[1] as 'name' | 'description'] = value
  }
  return out
}

export function acquiredSkillName(...choices: Array<string | undefined>): string {
  for (const choice of choices) {
    const name = String(choice ?? '').trim().toLowerCase()
    if (name && name.length <= 64 && USER_SKILL_NAME_PATTERN.test(name)) return name
  }
  throw new AcquiredSkillError('bad-name', '技能名只能用小写字母、数字和连字符')
}

export function safeSkillRelativePath(path: string): string {
  const value = String(path).replaceAll('\\', '/')
  const parts = value.split('/')
  if (
    !value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))
  ) {
    throw new AcquiredSkillError('file-path', `技能文件路径不安全：${path}`)
  }
  return parts.join('/')
}

export function reviewAcquiredSkill(files: readonly AcquiredSkillFile[]): {
  review: SkillSecurityReview
  blocked: SkillSecurityFinding[]
  warnings: SkillSecurityFinding[]
} {
  const texts = files
    .filter((file) => /\.(?:md|markdown|txt)$/i.test(file.path))
    .map((file) => ({ path: file.path, content: file.content }))
  const review = reviewSkillFiles(texts)
  const blocked = review.findings.filter((finding) => finding.code === 'prompt-injection')
  const warnings = review.findings.filter((finding) => finding.severity === 'high' && finding.code !== 'prompt-injection')
  return { review, blocked, warnings }
}

export function normalizeSkillFilePath(path: string): string {
  const raw = String(path)
  if (!raw || raw.includes('\0') || isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]/.test(raw)) {
    throw new AcquiredSkillError('file-path', `Skill 文件路径不安全：${path}`)
  }
  const value = raw.replaceAll('\\', '/')
  if (value.split('/').some((part) => part === '..' || part === '.')) {
    throw new AcquiredSkillError('file-path', `Skill 文件路径不安全：${path}`)
  }
  return value
}

export function declaredSkillFile(root: string, path: string): { path: string; absolute: string } {
  const value = normalizeSkillFilePath(path)
  if (!/^skills\/[^/]+\/SKILL\.md$/i.test(value)) {
    throw new AcquiredSkillError('file-path', `Skill 文件必须是 skills/<name>/SKILL.md：${value}`)
  }
  const base = resolve(root)
  const absolute = resolve(base, value)
  const escaped = relative(base, absolute)
  if (/^\.\.(?:[\\/]|$)/.test(escaped) || isAbsolute(escaped)) {
    throw new AcquiredSkillError('file-path', `Skill 文件路径越界：${path}`)
  }
  return { path: value, absolute }
}

export function skillFilesLayout(
  listed: readonly SkillFileInput[]
): { files: AcquiredSkillFile[]; dirName?: string } {
  const skillMd = listed.find((file) => /(^|\/)SKILL\.md$/i.test(file.path))
  if (!skillMd) throw new AcquiredSkillError('no-skill', '候选里没有 SKILL.md，拒绝接入')
  const prefix = skillMd.path.slice(0, skillMd.path.length - 'SKILL.md'.length)
  const stray = listed.find((file) => prefix && !file.path.startsWith(prefix))
  if (stray) throw new AcquiredSkillError('multiple-skills', `一个候选只能接入一个技能；这个候选还声明了 ${stray.path}`)
  const files = listed.map((file) => ({
    path: file.path.slice(prefix.length),
    content: typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
  }))
  return { files, dirName: prefix.split('/').filter(Boolean).at(-1) }
}

export function sessionSkillsDir(root: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new AcquiredSkillError('session-id', '会话 id 不安全')
  }
  return join(root, 'capabilities', 'session-skills', sessionId)
}

function within(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path))
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:/.test(rel)
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

async function readIndex(root: string, sessionId: string): Promise<SessionSkillIndex> {
  try {
    const parsed = JSON.parse(await readFile(join(sessionSkillsDir(root, sessionId), 'index.json'), 'utf8')) as SessionSkillIndex
    if (parsed?.version === 1 && parsed.sessionId === sessionId && Array.isArray(parsed.skills)) return parsed
  } catch {
  }
  return { version: 1, sessionId, skills: [] }
}

async function writeSkillDir(target: string, files: readonly AcquiredSkillFile[], meta: Record<string, unknown>): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
  await mkdir(tmp, { recursive: true })
  try {
    for (const file of files) {
      const rel = safeSkillRelativePath(file.path)
      const out = join(tmp, ...rel.split('/'))
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, file.content)
    }
    await writeFile(join(tmp, SOURCE_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    await rm(target, { recursive: true, force: true })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function readMeta(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, SOURCE_META_FILE), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function installAcquiredSkill(input: {
  root: string
  scope: AcquiredSkillScope
  sessionId?: string
  name: string
  description: string
  files: readonly AcquiredSkillFile[]
  source: AcquiredSkillSource
  reservedNames?: readonly string[]
}): Promise<{ scope: AcquiredSkillScope; dir: string; skillFile: string; replaced: boolean }> {
  const name = acquiredSkillName(input.name)
  const paths = input.files.map((file) => safeSkillRelativePath(file.path))
  if (!paths.includes('SKILL.md')) throw new AcquiredSkillError('no-skill', '技能缺少 SKILL.md')
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) throw new AcquiredSkillError('file-path', '技能文件路径重复')
  if (paths.includes(SOURCE_META_FILE)) throw new AcquiredSkillError('file-path', `技能不能自带 ${SOURCE_META_FILE}`)
  const installedAt = new Date().toISOString()
  const meta = { version: 1, name, scope: input.scope, ...input.source, installedAt }

  if (input.scope === 'user') {
    if (input.reservedNames?.includes(name)) throw new AcquiredSkillError('name-taken', `「${name}」是砚随包技能的名字`)
    const dir = join(userSkillsDir(input.root), name)
    const existing = existsSync(dir) ? await readMeta(dir) : null
    if (existsSync(dir) && existing?.candidateId === undefined) {
      throw new AcquiredSkillError('name-taken', `我的技能里已有「${name}」，不会覆盖`)
    }
    await mkdir(userSkillsDir(input.root), { recursive: true })
    await writeSkillDir(dir, input.files, meta)
    return { scope: 'user', dir, skillFile: join(dir, 'SKILL.md'), replaced: existing !== null }
  }

  if (!input.sessionId) throw new AcquiredSkillError('session-id', '没有当前会话，无法接入本次会话技能')
  const base = sessionSkillsDir(input.root, input.sessionId)
  const dir = join(base, name)
  await mkdir(base, { recursive: true })
  const index = await readIndex(input.root, input.sessionId)
  const replaced = index.skills.some((skill) => skill.name === name)
  await writeSkillDir(dir, input.files, meta)
  const entry: SessionSkillEntry = {
    name,
    description: input.description.slice(0, 1024),
    candidateId: input.source.candidateId,
    ...(input.source.url ? { sourceUrl: input.source.url } : {}),
    ...(input.source.commit ? { commit: input.source.commit } : {}),
    installedAt,
    skillFile: join(dir, 'SKILL.md'),
    fileCount: input.files.length
  }
  index.skills = [...index.skills.filter((skill) => skill.name !== name), entry]
  await writeJsonAtomic(join(base, 'index.json'), index)
  return { scope: 'session', dir, skillFile: entry.skillFile, replaced }
}

export async function listSessionSkills(root: string, sessionId: string): Promise<SessionSkillEntry[]> {
  let base: string
  try {
    base = sessionSkillsDir(root, sessionId)
  } catch {
    return []
  }
  const index = await readIndex(root, sessionId)
  return index.skills.filter((skill) =>
    typeof skill?.name === 'string' &&
    typeof skill.skillFile === 'string' &&
    within(base, skill.skillFile) &&
    resolve(skill.skillFile) === resolve(base, skill.name, 'SKILL.md') &&
    existsSync(skill.skillFile)
  )
}

export async function removeSessionSkill(root: string, sessionId: string, name: string): Promise<boolean> {
  const base = sessionSkillsDir(root, sessionId)
  const index = await readIndex(root, sessionId)
  const found = index.skills.find((skill) => skill.name === name)
  if (!found) return false
  const dir = join(base, acquiredSkillName(name))
  if (existsSync(dir) && (await lstat(dir)).isDirectory()) await rm(dir, { recursive: true, force: true })
  index.skills = index.skills.filter((skill) => skill.name !== name)
  await writeJsonAtomic(join(base, 'index.json'), index)
  return true
}

export async function promoteSessionSkill(
  root: string,
  sessionId: string,
  name: string,
  reservedNames: readonly string[] = []
): Promise<{ dir: string }> {
  const skill = (await listSessionSkills(root, sessionId)).find((entry) => entry.name === name)
  if (!skill) throw new AcquiredSkillError('not-found', `本次会话没有技能「${name}」`)
  const safe = acquiredSkillName(name)
  if (reservedNames.includes(safe)) throw new AcquiredSkillError('name-taken', `「${safe}」是砚随包技能的名字`)
  const target = join(userSkillsDir(root), safe)
  if (existsSync(target)) throw new AcquiredSkillError('name-taken', `我的技能里已有「${safe}」，不会覆盖`)
  const source = join(sessionSkillsDir(root, sessionId), safe)
  await mkdir(userSkillsDir(root), { recursive: true })
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
  try {
    await cp(source, tmp, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
    const meta = (await readMeta(tmp)) ?? {}
    await writeFile(join(tmp, SOURCE_META_FILE), JSON.stringify({ ...meta, scope: 'user', promotedAt: new Date().toISOString() }, null, 2), 'utf8')
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await removeSessionSkill(root, sessionId, safe)
  return { dir: target }
}

export async function acquiredUserSkillNames(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    for (const entry of await readdir(userSkillsDir(root), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(userSkillsDir(root), entry.name, SOURCE_META_FILE))) names.add(entry.name)
    }
  } catch {
  }
  return names
}
