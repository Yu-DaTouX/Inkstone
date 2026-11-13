import { pick } from '../shared/ui-lang'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { atomicWriteFile } from './atomic-write'
import { reviewSkillFiles, formatSkillSecurityReview } from '../shared/skill-security'
import { legacyPlaybookToSkill, userSkillMarkdown, validateUserSkill, type UserSkillInput } from '../shared/user-skill'
import { isWindowsDeviceName } from './win-file-names'

export const USER_SKILLS_DIRNAME = 'skills'
const LEGACY_PLAYBOOK_FILE = 'playbooks.json'
const MIGRATION_MARKER = '.playbooks-migrated.json'
const DISABLED_SKILLS_FILE = '.disabled.json'

export function userSkillsDir(root: string = YAN_DIR): string {
  return join(root, USER_SKILLS_DIRNAME)
}

export async function allUserSkillPaths(root: string = YAN_DIR): Promise<string[]> {
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

export async function userSkillPaths(root: string = YAN_DIR): Promise<string[]> {
  const disabled = await disabledUserSkillNames(root)
  return (await allUserSkillPaths(root)).filter((file) => !disabled.has(basename(dirname(file))))
}

const disabledUserSkillsFile = (root: string): string => join(userSkillsDir(root), DISABLED_SKILLS_FILE)

export async function disabledUserSkillNames(root: string = YAN_DIR): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(disabledUserSkillsFile(root), 'utf8')) as unknown
    return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

export async function setUserSkillDisabled(name: string, disabled: boolean, root: string = YAN_DIR): Promise<void> {
  const names = await disabledUserSkillNames(root)
  if (disabled === names.has(name)) return
  if (disabled) names.add(name)
  else names.delete(name)
  await mkdir(userSkillsDir(root), { recursive: true })
  await atomicWriteFile(disabledUserSkillsFile(root), `${JSON.stringify([...names].sort(), null, 2)}\n`)
}

export type SaveUserSkillResult =
  | { ok: true; name: string; path: string; replaced: boolean }
  | { ok: false; code: string; error: string }

export type SaveUserSkillConfirm = (request: UserSkillInput & { replaced: boolean }) => Promise<{ ok: true } | { ok: false; reply?: string; timedOut?: boolean }>

export async function saveUserSkill(
  raw: Partial<UserSkillInput> & { replace?: boolean },
  opts: { root?: string; reservedNames?: readonly string[]; confirm?: SaveUserSkillConfirm } = {}
): Promise<SaveUserSkillResult> {
  const checked = validateUserSkill(raw)
  if (!checked.ok) return { ok: false, code: checked.code, error: checked.message }
  const { name } = checked.value
  if (isWindowsDeviceName(name)) {
    return { ok: false, code: 'bad-name', error: pick(`「${name}」是 Windows 设备名，不能用作技能名，请换一个`, `"${name}" is a reserved Windows device name; choose another skill name`) }
  }
  if (opts.reservedNames?.includes(name)) {
    return { ok: false, code: 'reserved-name', error: pick(`「${name}」是砚随包技能的名字，请换一个`, `"${name}" is the name of a bundled Inkstone skill. Choose another`) }
  }
  const content = userSkillMarkdown(checked.value)
  const review = reviewSkillFiles([{ path: `skills/${name}/SKILL.md`, content }])
  if (!review.ok) return { ok: false, code: 'security-review', error: formatSkillSecurityReview(review) }

  const dir = join(userSkillsDir(opts.root), name)
  const file = join(dir, 'SKILL.md')
  const exists = existsSync(file)
  if (exists && raw.replace !== true) {
    return { ok: false, code: 'exists', error: pick(`技能「${name}」已存在；确认要覆盖时传 replace: true`, `Skill "${name}" already exists. Pass replace: true to overwrite`) }
  }
  if (opts.confirm) {
    const decision = await opts.confirm({ ...checked.value, replaced: exists })
    if (!decision.ok) {
      const error = decision.reply
        ? pick(`用户没有同意保存，并回复：${decision.reply}。按用户的话调整，不要再次请求保存这个技能。`, `The user did not approve saving and replied: ${decision.reply}. Follow the reply; do not ask to save this skill again.`)
        : decision.timedOut
          ? pick('用户没有在时限内确认，技能未保存。不要再次请求保存；在回复里说明这一点。', 'The user did not confirm in time; the skill was not saved. Do not ask again; say so in your reply.')
          : pick('用户没有同意保存这个技能。不要再次请求保存。', 'The user did not approve saving this skill. Do not ask again.')
      return { ok: false, code: 'declined', error }
    }
  }
  await mkdir(dir, { recursive: true })
  await atomicWriteFile(file, content)
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
    if (!skill || isWindowsDeviceName(skill.name)) {
      skipped += 1
      continue
    }
    if (doneSet.has(skill.id)) continue
    const target = join(dir, skill.name, 'SKILL.md')
    try {
      if (!existsSync(target)) {
        await mkdir(join(dir, skill.name), { recursive: true })
        await atomicWriteFile(target, userSkillMarkdown(skill))
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
      await atomicWriteFile(markerPath, JSON.stringify({ version: 1, ids: [...doneSet] }, null, 2))
    } catch {
    }
  }
  return { exported, skipped, diagnostics }
}
