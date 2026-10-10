/**
 * `yan question ask` 的表单形态：一次问清几项信息（单选卡片、多选、文字、日期、数字、滑块）。
 *
 * 宿主校验后交给问题面板；用户提交的答案以 JSON 字符串回到同一个请求 id，
 * 再由宿主解析成 `answers` 对象和一行可读摘要交还模型。单选沿用「最多 3 个选项」的口径
 * （2026-09-27 用户决定），多选最多 6 个；每个选择题都可以另写一句。
 */

export type QuestionFieldKind = 'choice' | 'multi' | 'text' | 'date' | 'number' | 'range'

export interface QuestionFieldOption {
  label: string
  description?: string
  icon?: string
}

export interface QuestionField {
  name: string
  label: string
  kind: QuestionFieldKind
  options?: QuestionFieldOption[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  optional?: boolean
}

export type QuestionAnswers = Record<string, string | string[] | number | null>

export const QUESTION_FORM_MAX_FIELDS = 5
const KINDS: readonly QuestionFieldKind[] = ['choice', 'multi', 'text', 'date', 'number', 'range']

export class QuestionFormError extends Error {}

function text(value: unknown, where: string, max: number, optional = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined
    throw new QuestionFormError(`${where} 不能为空`)
  }
  if (typeof value !== 'string') throw new QuestionFormError(`${where} 应为文字`)
  const trimmed = value.trim()
  if (!trimmed && !optional) throw new QuestionFormError(`${where} 不能为空`)
  if (trimmed.length > max) throw new QuestionFormError(`${where} 不能超过 ${max} 个字符`)
  return trimmed || undefined
}

function finite(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new QuestionFormError(`${where} 应为数字`)
  return value
}

/** 校验并规范化模型给的 fields；不合格就整体拒绝，模型改完再问。 */
export function parseQuestionFields(raw: unknown): QuestionField[] {
  if (!Array.isArray(raw)) throw new QuestionFormError('fields 应为数组')
  if (raw.length < 1 || raw.length > QUESTION_FORM_MAX_FIELDS) throw new QuestionFormError(`fields 应有 1–${QUESTION_FORM_MAX_FIELDS} 项`)
  const names = new Set<string>()
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new QuestionFormError(`fields[${i}] 应为对象`)
    const field = item as Record<string, unknown>
    const name = text(field.name, `fields[${i}].name`, 40)!
    if (!/^[A-Za-z][\w-]*$/.test(name)) throw new QuestionFormError(`fields[${i}].name 只能用字母、数字、下划线`)
    if (names.has(name)) throw new QuestionFormError(`fields[${i}].name 重复`)
    names.add(name)
    const kind = (field.kind ?? 'text') as QuestionFieldKind
    if (!KINDS.includes(kind)) throw new QuestionFormError(`fields[${i}].kind 只能是 ${KINDS.join(' / ')}`)
    const out: QuestionField = { name, kind, label: text(field.label, `fields[${i}].label`, 200)! }
    if (kind === 'choice' || kind === 'multi') {
      const limit = kind === 'choice' ? 3 : 6
      if (!Array.isArray(field.options) || field.options.length < 2 || field.options.length > limit) {
        throw new QuestionFormError(`fields[${i}].options 应有 2–${limit} 项`)
      }
      out.options = field.options.map((option, j) => {
        if (typeof option === 'string') return { label: text(option, `fields[${i}].options[${j}]`, 80)! }
        if (!option || typeof option !== 'object') throw new QuestionFormError(`fields[${i}].options[${j}] 应为文字或对象`)
        const o = option as Record<string, unknown>
        return {
          label: text(o.label, `fields[${i}].options[${j}].label`, 80)!,
          description: text(o.description, `fields[${i}].options[${j}].description`, 160, true),
          icon: text(o.icon, `fields[${i}].options[${j}].icon`, 32, true)
        }
      })
    }
    if (kind === 'number' || kind === 'range') {
      out.min = finite(field.min, `fields[${i}].min`)
      out.max = finite(field.max, `fields[${i}].max`)
      out.step = finite(field.step, `fields[${i}].step`)
      if (kind === 'range' && (out.min === undefined || out.max === undefined)) throw new QuestionFormError(`fields[${i}] 滑块需要 min 与 max`)
      if (out.min !== undefined && out.max !== undefined && out.min >= out.max) throw new QuestionFormError(`fields[${i}].min 应小于 max`)
    }
    out.placeholder = text(field.placeholder, `fields[${i}].placeholder`, 120, true)
    if (field.optional === true) out.optional = true
    return out
  })
}

/**
 * 解析面板交回的 JSON 答案：只保留声明过的字段，按类型夹取，丢掉多余键。
 * 返回 null 表示答案无法解析（当作没回答）。
 */
export function parseQuestionAnswers(fields: QuestionField[], raw: string): QuestionAnswers | null {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const input = data as Record<string, unknown>
  const out: QuestionAnswers = {}
  for (const field of fields) {
    const value = input[field.name]
    if (field.kind === 'multi') {
      out[field.name] = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 500)).slice(0, 12) : []
    } else if (field.kind === 'number' || field.kind === 'range') {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
      out[field.name] = Number.isFinite(n) ? Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n)) : null
    } else if (field.kind === 'date') {
      out[field.name] = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
    } else {
      out[field.name] = typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null
    }
  }
  return out
}

/** 一行可读摘要（写进问答记录、给模型扫一眼）：「标签：值 · 标签：值」 */
export function summarizeAnswers(fields: QuestionField[], answers: QuestionAnswers): string {
  return fields
    .map((field) => {
      const value = answers[field.name]
      const shown = Array.isArray(value) ? value.join('、') : value === null || value === undefined || value === '' ? '（未填）' : String(value)
      return `${field.label}：${shown}`
    })
    .join(' · ')
}
