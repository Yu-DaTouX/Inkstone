import type { AntigravityElicitationField, AntigravityElicitationOption, AntigravityElicitationResult } from '../shared/antigravity'
import type { QuestionField } from '../shared/question-form'
import { pick } from '../shared/ui-lang'
import type { HostUiResponse } from './ui-requests'

function uniqueOptionMap(options: readonly AntigravityElicitationOption[]): Map<string, string> {
  const reserved = new Set(options.map(({ label }) => label))
  const map = new Map<string, string>()
  const suffixes = new Map<string, number>()
  for (const { value, label: base } of options) {
    let label = base
    let suffix = suffixes.get(base) ?? 2
    while (map.has(label) || (label !== base && reserved.has(label))) label = `${base} (${suffix++})`
    suffixes.set(base, suffix)
    map.set(label, value)
  }
  return map
}

function promptText(parts: Array<string | undefined>): string {
  const unique: string[] = []
  for (const part of parts) {
    const trimmed = part?.trim()
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed)
  }
  return unique.join('\n\n')
}

export function buildElicitationUi(message: string, fields: readonly AntigravityElicitationField[]): {
  request: { method: 'select' | 'input'; title: string; message: string; options?: string[]; form?: QuestionField[] }
  parse: (answer: HostUiResponse) => AntigravityElicitationResult
} {
  const title = pick('Antigravity 提问', 'Antigravity question')
  if (fields.length === 1 && fields[0].kind === 'select') {
    const field = fields[0]
    const map = uniqueOptionMap(field.options)
    const otherOpt = field.options.find((opt) => opt.value === 'other' || opt.value === '__other__')
    return {
      request: {
        method: 'select',
        title,
        message: promptText([message, field.title, field.description]),
        options: [...map.keys()]
      },
      parse(answer) {
        if (answer.cancelled || typeof answer.value !== 'string') return { action: 'cancel' }
        if (map.has(answer.value)) return { action: 'accept', content: { [field.key]: map.get(answer.value)! } }
        const custom = answer.value.trim()
        if (!custom) return { action: 'cancel' }
        if (field.otherKey) {
          return { action: 'accept', content: { ...(otherOpt ? { [field.key]: otherOpt.value } : {}), [field.otherKey]: custom } }
        }
        return { action: 'accept', content: { [field.key]: custom } }
      }
    }
  }
  if (fields.length === 1 && fields[0].kind === 'text') {
    const field = fields[0]
    return {
      request: {
        method: 'input',
        title,
        message: promptText([message, field.title, field.description])
      },
      parse(answer) {
        if (answer.cancelled || typeof answer.value !== 'string') return { action: 'cancel' }
        if (!answer.value.trim() && field.required) return { action: 'cancel' }
        return { action: 'accept', content: { [field.key]: answer.value } }
      }
    }
  }
  const yes = pick('是', 'Yes')
  const no = pick('否', 'No')
  const decoders = fields.map((field, index) => {
    const name = `q_${index}`
    const label = promptText([field.title, field.description])
    const optional = !field.required
    if (field.kind === 'select' || field.kind === 'multi') {
      const map = uniqueOptionMap(field.options)
      const otherOpt = field.options.find((opt) => opt.value === 'other' || opt.value === '__other__')
      const question: QuestionField = {
        name,
        label,
        kind: field.kind === 'select' ? 'choice' : 'multi',
        options: [...map.keys()].map((optionLabel) => ({ label: optionLabel })),
        optional
      }
      return {
        question,
        decode(raw: unknown, content: Record<string, string | string[] | number | boolean>) {
          if (field.kind === 'select') {
            if (typeof raw !== 'string') return
            if (map.has(raw)) { content[field.key] = map.get(raw)!; return }
            const custom = raw.trim()
            if (!custom) return
            if (field.otherKey) {
              if (otherOpt) content[field.key] = otherOpt.value
              content[field.otherKey] = custom
            } else {
              content[field.key] = custom
            }
            return
          }
          if (!Array.isArray(raw)) return
          const selected: string[] = []
          const custom: string[] = []
          for (const entry of raw) {
            if (typeof entry !== 'string') continue
            if (map.has(entry)) selected.push(map.get(entry)!)
            else if (entry.trim()) custom.push(entry.trim())
          }
          if (custom.length && field.otherKey) {
            if (otherOpt && !selected.includes(otherOpt.value)) selected.push(otherOpt.value)
            content[field.otherKey] = custom.join('\n')
          } else if (custom.length) {
            selected.push(...custom)
          }
          if (selected.length || !field.otherKey || !custom.length) content[field.key] = selected
        }
      }
    }
    if (field.kind === 'boolean') {
      const question: QuestionField = {
        name,
        label,
        kind: 'choice',
        options: [{ label: yes }, { label: no }],
        optional
      }
      return {
        question,
        decode(raw: unknown, content: Record<string, string | string[] | number | boolean>) {
          if (raw === yes || raw === 'true') content[field.key] = true
          else if (raw === no || raw === 'false') content[field.key] = false
        }
      }
    }
    if (field.kind === 'number') {
      const question: QuestionField = {
        name,
        label,
        kind: 'number',
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        optional
      }
      return {
        question,
        decode(raw: unknown, content: Record<string, string | string[] | number | boolean>) {
          if (typeof raw === 'number' && Number.isFinite(raw)) {
            content[field.key] = field.integer ? Math.trunc(raw) : raw
          }
        }
      }
    }
    const question: QuestionField = { name, label, kind: 'text', optional }
    return {
      question,
      decode(raw: unknown, content: Record<string, string | string[] | number | boolean>) {
        if (typeof raw === 'string' && (raw.trim() || field.required)) content[field.key] = raw
      }
    }
  })
  return {
    request: {
      method: 'input',
      title,
      message,
      form: decoders.map(({ question }) => question)
    },
    parse(answer) {
      if (answer.cancelled || typeof answer.value !== 'string') return { action: 'cancel' }
      let parsed: unknown
      try { parsed = JSON.parse(answer.value) } catch { return { action: 'cancel' } }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { action: 'cancel' }
      const record = parsed as Record<string, unknown>
      const content: Record<string, string | string[] | number | boolean> = {}
      for (const item of decoders) item.decode(record[item.question.name], content)
      return { action: 'accept', content }
    }
  }
}
