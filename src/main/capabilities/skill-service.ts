import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Capability } from '../../shared/capabilities'
import { skillCapabilityId } from '../../shared/capabilities'

export interface SkillRecord {
  capability: Capability
  location: string
  baseDir: string
}

export interface SkillReadResult {
  id: string
  name: string
  description: string
  location: string
  baseDir: string
  contentHash: string
  body: string
}

export interface RawSkillCommand {
  name?: unknown
  description?: unknown
  source?: unknown
  path?: unknown
  location?: unknown
  sourceInfo?: unknown
}

function skillLocationOf(raw: RawSkillCommand): string {
  const direct = typeof raw.location === 'string' ? raw.location.trim() : ''
  if (direct) return direct
  const info = raw.sourceInfo
  if (info && typeof info === 'object') {
    const p = (info as { path?: unknown }).path
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return ''
}

function looksLikeSkill(raw: RawSkillCommand): boolean {
  const source = typeof raw.source === 'string' ? raw.source.toLowerCase() : ''
  const name = typeof raw.name === 'string' ? raw.name.toLowerCase() : ''
  return source.includes('skill') || name.replace(/^\/+/, '').startsWith('skill:')
}

function skillNameOf(raw: RawSkillCommand): string | null {
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/^\/+/, '') : ''
  if (!name.toLowerCase().startsWith('skill:')) return null
  const bare = name.slice('skill:'.length).trim()
  return bare || null
}

export function skillsFromCommands(commands: readonly RawSkillCommand[]): SkillRecord[] {
  const records: SkillRecord[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    if (!looksLikeSkill(command)) continue
    const name = skillNameOf(command)
    if (!name) continue
    const id = skillCapabilityId(name)
    if (seen.has(id)) continue
    const location = skillLocationOf(command)
    if (!location || !isAbsolute(location)) continue
    if (basename(location).toLowerCase() !== 'skill.md') continue
    seen.add(id)
    const description = typeof command.description === 'string' ? command.description.trim() : ''
    records.push({
      capability: {
        id,
        kind: 'skill',
        title: name,
        description,
        source: { owner: 'user', location },
        availability: 'ready',
        effect: 'read'
      },
      location,
      baseDir: dirname(location)
    })
  }
  return records
}

export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return normalized.trim()
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return normalized.trim()
  const after = normalized.indexOf('\n', end + 1)
  return (after < 0 ? '' : normalized.slice(after + 1)).trim()
}

export function skillLocationAllowed(location: string, baseDir: string): boolean {
  const target = resolve(location)
  const root = resolve(baseDir)
  return target === resolve(root, basename(target)) && target.startsWith(root + sep)
}

export function findSkill(
  commands: readonly RawSkillCommand[],
  id: string
): SkillRecord | undefined {
  return skillsFromCommands(commands).find((record) => record.capability.id === id)
}

export async function readSkillById(
  commands: readonly RawSkillCommand[],
  id: string
): Promise<SkillReadResult> {
  const record = findSkill(commands, id)
  if (!record) throw new Error(`找不到这个技能：${id}`)
  if (!skillLocationAllowed(record.location, record.baseDir)) {
    throw new Error(`技能文件位置不合法（不在技能目录内）：${record.location}`)
  }
  const raw = await readFile(record.location, 'utf8')
  const body = stripSkillFrontmatter(raw)
  const contentHash = createHash('sha256').update(body, 'utf8').digest('hex')
  return {
    id: record.capability.id,
    name: record.capability.title,
    description: record.capability.description,
    location: record.location,
    baseDir: record.baseDir,
    contentHash,
    body
  }
}
