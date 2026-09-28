/**
 * 用户技能：用户自己的做法（例如以前的「办事模板」）保存成 `SKILL.md`。
 *
 * 宿主只负责三件事：校验名称与大小、生成标准的 frontmatter、把旧的
 * `playbooks.json` 条目转成技能正文。怎么把一次任务整理成技能、执行时
 * 怎么确认范围，写在随包的 `playbook` 技能里。
 *
 * 它不碰 electron / 文件系统，主进程与单测共用同一份规则。
 */

/** 技能名：小写字母、数字与连字符，与目录名一致（Agent Skills 通行写法）。 */
export const USER_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const USER_SKILL_LIMITS = {
  maxName: 64,
  maxDescription: 1024,
  /** 正文上限（按字符数）。技能正文会按需进入上下文，过长就该拆分。 */
  maxBody: 20_000
} as const

export interface UserSkillInput {
  name: string
  description: string
  body: string
}

export type UserSkillError = 'bad-name' | 'missing-description' | 'description-too-long' | 'missing-body' | 'body-too-long'

export function validateUserSkill(
  raw: Partial<UserSkillInput> | null | undefined
): { ok: true; value: UserSkillInput } | { ok: false; code: UserSkillError; message: string } {
  const name = String(raw?.name ?? '').trim()
  if (!name || name.length > USER_SKILL_LIMITS.maxName || !USER_SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: 'bad-name',
      message: `技能名只能用小写字母、数字和连字符，最长 ${USER_SKILL_LIMITS.maxName} 个字符（例如 weekly-report）`
    }
  }
  const description = String(raw?.description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!description) return { ok: false, code: 'missing-description', message: '缺少 description：写清什么时候该用这个技能' }
  if ([...description].length > USER_SKILL_LIMITS.maxDescription) {
    return { ok: false, code: 'description-too-long', message: `description 超过 ${USER_SKILL_LIMITS.maxDescription} 字` }
  }
  const body = String(raw?.body ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!body) return { ok: false, code: 'missing-body', message: '缺少技能正文' }
  if ([...body].length > USER_SKILL_LIMITS.maxBody) {
    return { ok: false, code: 'body-too-long', message: `正文超过 ${USER_SKILL_LIMITS.maxBody} 字，请拆成几个技能` }
  }
  return { ok: true, value: { name, description, body } }
}

/**
 * 生成 `SKILL.md` 全文。
 *
 * description 用 JSON 字符串写入：它同时是合法的 YAML 双引号字符串，
 * 冒号、引号之类的字符不会破坏 frontmatter。
 */
export function userSkillMarkdown(input: UserSkillInput): string {
  return ['---', `name: ${input.name}`, `description: ${JSON.stringify(input.description)}`, '---', '', input.body, ''].join('\n')
}

/* ------------------------------------------------------------------ *
 * 旧「办事模板」→ 技能
 * ------------------------------------------------------------------ */

const EFFECT_LABELS: Record<string, string> = {
  read: '只读',
  write: '会改东西',
  external: '会对外发出'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(textOf).filter(Boolean) : []
}

/** 旧模板 id → 技能名（`pb_1a2b` → `playbook-pb-1a2b`）。 */
export function legacyPlaybookSkillName(id: string): string {
  const slug = String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, USER_SKILL_LIMITS.maxName - 'playbook-'.length)
    .replace(/-+$/g, '')
  return `playbook-${slug || 'untitled'}`
}

/**
 * 把 `playbooks.json` 里的一条旧模板转成技能。
 *
 * 读法刻意宽松：旧数据里缺范围的写步骤也保留下来，并在正文里写明
 * 「执行前先问用户范围」—— 迁移的目标是不丢用户的东西，确认规则由正文约束。
 */
export function legacyPlaybookToSkill(raw: unknown): (UserSkillInput & { id: string; title: string }) | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const id = textOf(p.id)
  const title = textOf(p.title)
  if (!id || !title) return undefined
  const goal = textOf(p.goal)
  const io = p.io && typeof p.io === 'object' ? (p.io as Record<string, unknown>) : {}
  const inputs = listOf(io.inputs)
  const outputs = listOf(io.outputs)
  const steps = Array.isArray(p.steps) ? p.steps : []

  const lines: string[] = [`# ${title}`, '']
  lines.push('> 由砚的旧「办事模板」自动转换。可以直接编辑本文件；原数据仍保留在 `playbooks.json`。', '')
  if (goal) lines.push('## 目标', '', goal, '')
  if (inputs.length || outputs.length) {
    lines.push('## 输入与输出', '')
    if (inputs.length) lines.push(`- 输入：${inputs.join('；')}`)
    if (outputs.length) lines.push(`- 输出：${outputs.join('；')}`)
    lines.push('')
  }
  lines.push('## 步骤', '')
  let index = 0
  let needsConfirm = false
  for (const item of steps) {
    if (!item || typeof item !== 'object') continue
    const step = item as Record<string, unknown>
    const stepTitle = textOf(step.title)
    if (!stepTitle) continue
    index += 1
    const effect = textOf(step.effect)
    const label = EFFECT_LABELS[effect] ?? '只读'
    if (effect === 'write' || effect === 'external') needsConfirm = true
    const scope = listOf(step.scope)
    const detail = textOf(step.detail)
    let line = `${index}. ${stepTitle}（${label}`
    if (effect === 'write' || effect === 'external') {
      line += scope.length ? `；范围：${scope.join('、')}` : '；范围未写明，执行前先问用户'
    }
    line += '）'
    lines.push(line)
    if (detail) lines.push(`   ${detail}`)
  }
  if (index === 0) lines.push('（原模板没有可读的步骤，使用前先和用户确认要做什么。）')
  lines.push('')
  lines.push('## 执行约定', '')
  if (needsConfirm) {
    lines.push('- 标为「会改东西」或「会对外发出」的步骤，执行前把具体范围（哪些文件、哪份资料或成果、发给谁）告诉用户并得到确认。')
    lines.push('- 范围写成 `<…>` 的是占位，先请用户给出实际对象，不要猜。')
  } else {
    lines.push('- 各步骤都是只读，不改动任何文件或成果。')
  }
  lines.push('- 只做步骤里列出的事，不顺手做范围外的整理。')

  const description = `办事模板「${title}」。${goal ? `${goal}。` : ''}用户要求按这个模板办事，或要做同类任务时使用。`
  return {
    id,
    title,
    name: legacyPlaybookSkillName(id),
    description: [...description].slice(0, USER_SKILL_LIMITS.maxDescription).join(''),
    body: lines.join('\n').trim()
  }
}
