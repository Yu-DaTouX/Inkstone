import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { allUserSkillPaths, disabledUserSkillNames, setUserSkillDisabled } from './user-skills'
import { readJson, withPiSettingsLock, writeAtomic } from './native-compaction-line'

export type SkillManageScope = 'yan' | 'pi'

export interface ManagedSkillEntry {
  name: string
  description: string
  location: string
  scope: SkillManageScope
  enabled: boolean
}

export interface SkillManagerPaths {
  yanRoot: string
  agentDir: string
  home: string
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const defaultPaths = (): SkillManagerPaths => ({ yanRoot: YAN_DIR, agentDir: PI_AGENT_DIR, home: homedir() })

const toPosix = (path: string): string => path.replace(/\\/g, '/')

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

export function piSkillRoots(paths: SkillManagerPaths = defaultPaths()): string[] {
  return [join(paths.agentDir, 'skills'), join(paths.home, '.agents', 'skills')]
}

export function piSkillPattern(skillDir: string, agentDir: string): string {
  const rel = relative(agentDir, skillDir)
  return rel && !rel.startsWith('..') && !rel.includes(':') ? toPosix(rel) : toPosix(resolve(skillDir))
}

function frontmatterOf(content: string): { name?: string; description?: string } {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return {}
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of normalized.slice(3, end).split('\n')) {
    const match = /^(name|description):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value) out[match[1] as 'name' | 'description'] = value
  }
  return out
}

async function skillFilesIn(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(root, entry.name, 'SKILL.md'))
      .filter((file) => existsSync(file))
      .sort()
  } catch {
    return []
  }
}

async function entryOf(location: string, scope: SkillManageScope, enabled: boolean): Promise<ManagedSkillEntry> {
  const meta = await readFile(location, 'utf8').then(frontmatterOf, () => ({}) as { name?: string; description?: string })
  return { name: meta.name ?? basename(dirname(location)), description: meta.description ?? '', location, scope, enabled }
}

function piDisabledPatterns(settings: Record<string, unknown> | undefined): Set<string> {
  const skills = Array.isArray(settings?.skills) ? settings.skills : []
  return new Set(
    skills
      .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('-'))
      .map((entry) => toPosix(entry.slice(1).replace(/^\.[\\/]/, '')).toLowerCase())
  )
}

export async function listManagedSkills(paths: SkillManagerPaths = defaultPaths()): Promise<ManagedSkillEntry[]> {
  const disabledYan = await disabledUserSkillNames(paths.yanRoot)
  const yan = await Promise.all(
    (await allUserSkillPaths(paths.yanRoot)).map((file) => entryOf(file, 'yan', !disabledYan.has(basename(dirname(file)))))
  )
  const disabledPi = piDisabledPatterns(await readJson(join(paths.agentDir, 'settings.json')))
  const pi: ManagedSkillEntry[] = []
  for (const root of piSkillRoots(paths)) {
    for (const file of await skillFilesIn(root)) {
      if (pi.some((entry) => samePath(entry.location, file))) continue
      const pattern = piSkillPattern(dirname(file), paths.agentDir).toLowerCase()
      pi.push(await entryOf(file, 'pi', !disabledPi.has(pattern)))
    }
  }
  return [...yan, ...pi]
}

export function managedSkillDir(scope: SkillManageScope, dirName: string, paths: SkillManagerPaths = defaultPaths()): string | null {
  if (!SKILL_NAME.test(dirName)) return null
  const roots = scope === 'yan' ? [join(paths.yanRoot, 'skills')] : piSkillRoots(paths)
  for (const root of roots) {
    const dir = join(root, dirName)
    if (resolve(dir).startsWith(resolve(root) + sep) && existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return null
}

export function managedSkillOf(location: string, paths: SkillManagerPaths = defaultPaths()): { scope: SkillManageScope; dirName: string } | null {
  if (basename(location).toLowerCase() !== 'skill.md') return null
  const dir = dirname(location)
  const dirName = basename(dir)
  if (samePath(dirname(dir), join(paths.yanRoot, 'skills'))) return { scope: 'yan', dirName }
  if (piSkillRoots(paths).some((root) => samePath(dirname(dir), root))) return { scope: 'pi', dirName }
  return null
}

async function setPiSkillDisabled(skillDir: string, disabled: boolean, agentDir: string): Promise<{ ok: boolean; error?: string }> {
  const file = join(agentDir, 'settings.json')
  const pattern = piSkillPattern(skillDir, agentDir)
  return withPiSettingsLock(async () => {
    const settings = await readJson(file)
    if (!settings) return { ok: false, error: `${file} 不是有效的 JSON，没有改动` }
    const current = Array.isArray(settings.skills) ? settings.skills : []
    const kept = current.filter(
      (entry) =>
        typeof entry !== 'string' ||
        !entry.startsWith('-') ||
        toPosix(entry.slice(1).replace(/^\.[\\/]/, '')).toLowerCase() !== pattern.toLowerCase()
    )
    const next = disabled ? [...kept, `-${pattern}`] : kept
    if (next.length === current.length && next.every((entry, index) => entry === current[index])) return { ok: true }
    const updated: Record<string, unknown> = { ...settings }
    if (next.length > 0) updated.skills = next
    else delete updated.skills
    await writeAtomic(file, updated)
    return { ok: true }
  })
}

export async function setManagedSkillEnabled(
  scope: SkillManageScope,
  dirName: string,
  enabled: boolean,
  paths: SkillManagerPaths = defaultPaths()
): Promise<{ ok: boolean; error?: string }> {
  const dir = managedSkillDir(scope, dirName, paths)
  if (!dir) return { ok: false, error: `没有找到技能「${dirName}」` }
  if (scope === 'yan') {
    await setUserSkillDisabled(dirName, !enabled, paths.yanRoot)
    return { ok: true }
  }
  return setPiSkillDisabled(dir, !enabled, paths.agentDir)
}

export async function trashManagedSkill(
  scope: SkillManageScope,
  dirName: string,
  trash: (path: string) => Promise<void>,
  paths: SkillManagerPaths = defaultPaths()
): Promise<{ ok: boolean; error?: string }> {
  const dir = managedSkillDir(scope, dirName, paths)
  if (!dir) return { ok: false, error: `没有找到技能「${dirName}」` }
  await trash(dir)
  if (scope === 'yan') await setUserSkillDisabled(dirName, false, paths.yanRoot)
  else await setPiSkillDisabled(dir, false, paths.agentDir)
  return { ok: true }
}
