export const USER_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const USER_SKILL_LIMITS = {
  maxName: 64,
  maxDescription: 1024,
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

export function userSkillMarkdown(input: UserSkillInput): string {
  return ['---', `name: ${input.name}`, `description: ${JSON.stringify(input.description)}`, '---', '', input.body, ''].join('\n')
}

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

export function legacyPlaybookSkillName(id: string): string {
  const slug = String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, USER_SKILL_LIMITS.maxName - 'playbook-'.length)
    .replace(/-+$/g, '')
  return `playbook-${slug || 'untitled'}`
}

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
    const label = Object.hasOwn(EFFECT_LABELS, effect) ? EFFECT_LABELS[effect] : '只读'
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
