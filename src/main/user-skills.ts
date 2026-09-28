/**
 * 用户技能目录：`YAN_DIR/skills/<名称>/SKILL.md`。
 *
 * 与随包技能一样按 `--skill` 显式传给 pi（pi 仍以 `--no-skills` 启动，
 * 不扫描其它目录）。新保存的技能在下一次启动会话时生效。
 *
 * 这里还负责把旧的 `playbooks.json` 一次性导出成技能：导出过的 id 记在
 * `skills/.playbooks-migrated.json`，用户删掉导出的技能后不会被再次生成；
 * 原文件只读，不删除。
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
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

/** 已存在的用户技能文件（目录名排序，保证每次启动参数顺序一致）。 */
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
  } catch {
    return []
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

export type SaveUserSkillResult =
  | { ok: true; name: string; path: string; replaced: boolean }
  | { ok: false; code: string; error: string }

/**
 * 保存一个用户技能。
 *
 * - 名称与随包技能重名时拒绝，免得覆盖砚自己的做法；
 * - 已存在时需要 `replace: true`；
 * - 正文先过一遍技能安全检查，有高风险写法（例如要求读取凭证）就拒绝。
 */
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

/**
 * 把旧的办事模板导出成用户技能（启动时调用，可重复调用）。
 *
 * 只导出落过盘的模板（内置起步模板从未落盘，其做法已并入随包 playbook 技能）。
 * 任何一条失败都只跳过这一条，不影响启动。
 */
export async function migrateLegacyPlaybooks(root: string = YAN_DIR): Promise<{ exported: string[]; skipped: number }> {
  const exported: string[] = []
  let skipped = 0
  let rawDoc: unknown
  try {
    rawDoc = JSON.parse(await readFile(join(root, LEGACY_PLAYBOOK_FILE), 'utf8'))
  } catch {
    return { exported, skipped }
  }
  const list = (rawDoc as { playbooks?: unknown } | null)?.playbooks
  if (!Array.isArray(list) || list.length === 0) return { exported, skipped }

  const dir = userSkillsDir(root)
  const markerPath = join(dir, MIGRATION_MARKER)
  let done: string[] = []
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { ids?: unknown }
    if (Array.isArray(marker.ids)) done = marker.ids.filter((id): id is string => typeof id === 'string')
  } catch {
    /* 没有标记：第一次迁移 */
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
    } catch {
      skipped += 1
    }
  }
  if (doneSet.size !== done.length) {
    try {
      await mkdir(dir, { recursive: true })
      await writeAtomic(markerPath, JSON.stringify({ version: 1, ids: [...doneSet] }, null, 2))
    } catch {
      /* 标记写不进去：下次启动会再检查一遍，已存在的文件不会被覆盖 */
    }
  }
  return { exported, skipped }
}
