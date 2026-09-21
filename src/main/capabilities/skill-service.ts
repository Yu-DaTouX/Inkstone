/**
 * Skill 能力服务（实施-04 §6）。
 *
 * 三条硬规则：
 *   ① **发现规则不另造一份**：技能的「有哪些」只以 pi 的 `get_commands`
 *      结果为准（[证据-04-S1](../docs/plan/证据-04-S1-技术预检.md) §4 已实测
 *      它带绝对 `location`）。自己扫全盘 `SKILL.md` 会造出「pi 不认识的技能」，
 *      也会把不受项目信任的目录放进来 —— 那是安全边界，不是便利问题。
 *   ② **Skill 不是可调用 API**：读到的是一份流程说明，模型用现有工具照着做。
 *      所以 `effect` 一律 `read`，不假装能「执行技能」。
 *   ③ **正文按需加载并记录内容 hash**：正文变了，之前的读取就不再作数
 *      （§6「正文变化后当前任务再使用须重新读取」）。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Capability } from '../../shared/capabilities'
import { skillCapabilityId } from '../../shared/capabilities'

export interface SkillRecord {
  capability: Capability
  /** SKILL.md 的绝对路径（pi 报告的值，未做二次拼接）。 */
  location: string
  /** 相对引用的解析基准目录。 */
  baseDir: string
}

export interface SkillReadResult {
  id: string
  name: string
  description: string
  location: string
  baseDir: string
  /** 正文（已去 frontmatter）的 sha256。 */
  contentHash: string
  body: string
}

/**
 * pi `get_commands` 的原始条目（只声明我们会读的字段）。
 *
 * 为什么不用 `CommandDescriptor`：那是在 `command-registry.ts` 里为**渲染端
 * 斜杠命令**归一化过的形状，它只读顶层 `location`；而 pi 真实的技能条目把
 * SKILL.md 路径放在 **`sourceInfo.path`** 里（[证据-04-S1] §4.1 实测）。
 * 早期版本因此把全部技能当成「没有路径」丢掉，目录里只剩内置能力。
 */
export interface RawSkillCommand {
  name?: unknown
  description?: unknown
  source?: unknown
  path?: unknown
  location?: unknown
  sourceInfo?: unknown
}

/** 取技能的 SKILL.md 路径：顶层 `location` 优先，回退 `sourceInfo.path`。 */
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

/** 与 `command-registry.classifySource` 同一口径：技能源或 `skill:` 前缀。 */
function looksLikeSkill(raw: RawSkillCommand): boolean {
  const source = typeof raw.source === 'string' ? raw.source.toLowerCase() : ''
  const name = typeof raw.name === 'string' ? raw.name.toLowerCase() : ''
  return source.includes('skill') || name.replace(/^\/+/, '').startsWith('skill:')
}

/** pi 的技能命令名固定带 `skill:` 前缀；真名是前缀之后的部分。 */
function skillNameOf(raw: RawSkillCommand): string | null {
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/^\/+/, '') : ''
  if (!name.toLowerCase().startsWith('skill:')) return null
  const bare = name.slice('skill:'.length).trim()
  return bare || null
}

/**
 * 从 pi 的命令列表里挑出技能，投影成能力目录项。
 *
 * 标 `ready` 而不是「已加载」：能出现在 `get_commands` 里就说明 pi 已经
 * 把它的 `name` + `description` 编进了 system prompt，正文随时可读。
 * 真正的执行依赖（脚本、外部工具）由技能自己声明，这里**不猜**。
 */
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
    /* 没有绝对路径就无法按需读正文，也无法校验边界 —— 宁可不进目录。 */
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

/**
 * 去掉 YAML frontmatter。
 *
 * 与 pi 自己的 `stripFrontmatter` 同语义：只有 **首行就是 `---`** 才算
 * frontmatter —— 正文里出现的 `---`（分隔线、代码块）不能吃掉。
 */
export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return normalized.trim()
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return normalized.trim()
  const after = normalized.indexOf('\n', end + 1)
  return (after < 0 ? '' : normalized.slice(after + 1)).trim()
}

/** 技能文件的路径必须在它自己的目录里 —— 防 `..` 逃逸（location 已可信，这里是纵深防御）。 */
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

/**
 * 按需读取技能正文。
 *
 * 调用方拿到的是**材料**，不是指令：模型可以照它做，但不能因为它而
 * 突破系统规则或授权范围（实施-04 §6 的不可信材料口径）。
 */
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
