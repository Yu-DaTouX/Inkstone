import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { reviewSkillFiles, formatSkillSecurityReview } from '../shared/skill-security'
import { legacyPlaybookToSkill, userSkillMarkdown, validateUserSkill, type UserSkillInput } from '../shared/user-skill'

export const USER_SKILLS_DIRNAME = 'skills'
const LEGACY_PLAYBOOK_FILE = 'playbooks.json'
const MIGRATION_MARKER = '.playbooks-migrated.json'

export function userSkillsDir(root: string = YAN_DIR): string {
  return join(root, USER_SKILLS_DIRNAME)
}

export async function userSkillPaths(root: string = YAN_DIR): Promise<string[]> {
  const dir = userSkillsDir(root)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => join(dir, name, 'SKILL.md'))
      .filter((file) => existsSync(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export type SaveUserSkillResult =
  | { ok: true; name: string; path: string; replaced: boolean }
  | { ok: false; code: string; error: string }

export async function saveUserSkill(
  raw: Partial<UserSkillInput> & { replace?: boolean },
  opts: { root?: string; reservedNames?: readonly string[] } = {}
): Promise<SaveUserSkillResult> {
  const checked = validateUserSkill(raw)
  if (!checked.ok) return { ok: false, code: checked.code, error: checked.message }
  const { name } = checked.value
  if (opts.reservedNames?.includes(name)) {
    return { ok: false, code: 'reserved-name', error: `「${name}」是砚随包技能的名字，请换一个` }
  }
  const content = userSkillMarkdown(checked.value)
  const review = reviewSkillFiles([{ path: `skills/${name}/SKILL.md`, content }])
  if (!review.ok) return { ok: false, code: 'security-review', error: formatSkillSecurityReview(review) }

  const dir = join(userSkillsDir(opts.root), name)
  const file = join(dir, 'SKILL.md')
  const exists = existsSync(file)
  if (exists && raw.replace !== true) {
    return { ok: false, code: 'exists', error: `技能「${name}」已存在；确认要覆盖时传 replace: true` }
  }
  await mkdir(dir, { recursive: true })
  await writeAtomic(file, content)
  return { ok: true, name, path: file, replaced: exists }
}

export async function migrateLegacyPlaybooks(root: string = YAN_DIR): Promise<{ exported: string[]; skipped: number; diagnostics: string[] }> {
  const exported: string[] = []
  const diagnostics: string[] = []
  let skipped = 0
  let rawDoc: unknown
  try {
    rawDoc = JSON.parse(await readFile(join(root, LEGACY_PLAYBOOK_FILE), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`旧 playbooks.json 读取或解析失败，未执行迁移：${error instanceof Error ? error.message : String(error)}`)
      console.warn('[yan] ' + diagnostics.at(-1))
    }
    return { exported, skipped, diagnostics }
  }
  const list = (rawDoc as { playbooks?: unknown } | null)?.playbooks
  if (!Array.isArray(list)) {
    diagnostics.push('旧 playbooks.json 结构无效，未执行迁移')
    console.warn('[yan] ' + diagnostics.at(-1))
    return { exported, skipped, diagnostics }
  }
  if (list.length === 0) return { exported, skipped, diagnostics }

  const dir = userSkillsDir(root)
  const markerPath = join(dir, MIGRATION_MARKER)
  let done: string[] = []
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { ids?: unknown }
    if (!marker || !Array.isArray(marker.ids) || marker.ids.some((id) => typeof id !== 'string')) {
      throw new Error('标记格式无效')
    }
    done = marker.ids
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`迁移标记损坏，已停止以免重新导出已删除技能：${error instanceof Error ? error.message : String(error)}`)
      console.warn('[yan] ' + diagnostics.at(-1))
      return { exported, skipped, diagnostics }
    }
  }
  const doneSet = new Set(done)

  for (const item of list) {
    const skill = legacyPlaybookToSkill(item)
    if (!skill) {
      skipped += 1
      continue
    }
    if (doneSet.has(skill.id)) continue
    const target = join(dir, skill.name, 'SKILL.md')
    try {
      if (!existsSync(target)) {
        await mkdir(join(dir, skill.name), { recursive: true })
        await writeAtomic(target, userSkillMarkdown(skill))
        exported.push(skill.name)
      }
      doneSet.add(skill.id)
    } catch (error) {
      skipped += 1
      const diagnostic = `导出旧 playbook「${skill.name}」失败：${error instanceof Error ? error.message : String(error)}`
      diagnostics.push(diagnostic)
      console.warn('[yan] ' + diagnostic)
    }
  }
  if (doneSet.size !== done.length) {
    try {
      await mkdir(dir, { recursive: true })
      await writeAtomic(markerPath, JSON.stringify({ version: 1, ids: [...doneSet] }, null, 2))
    } catch {
    }
  }
  return { exported, skipped, diagnostics }
}
