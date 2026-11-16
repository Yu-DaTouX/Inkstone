import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { modelErrorCause, modelErrorText } from '../shared/model-errors'
import { YAN_DIR } from './paths'

export function mainLogDir(): string {
  const dir = join(YAN_DIR, 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
  }
  return dir
}

export function logMainEvent(kind: string, text: string): void {
  try {
    const stamp = new Date().toISOString()
    appendFileSync(join(mainLogDir(), `main-${stamp.slice(0, 10)}.log`), `${stamp} [主进程/${kind}] ${text}\n`, 'utf8')
  } catch {
  }
}

export type ModelLogValue = string | number | boolean | null | undefined

function logValue(value: ModelLogValue): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  const text = modelErrorText(value).replace(/[\s=]+/g, '_').slice(0, 80)
  return text || null
}

export function accountLogId(key: string | undefined): string | undefined {
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : undefined
}

const STATUS_FIELDS = ['status', 'statusCode', 'status_code', 'code']

function httpStatus(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^[45]\d\d$/.test(value.trim()) ? Number(value) : NaN
  return Number.isInteger(num) && num >= 400 && num <= 599 ? num : undefined
}

function structuredStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 3) return undefined
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.startsWith('{')) {
      try {
        return structuredStatus(JSON.parse(raw), depth + 1)
      } catch {
      }
    }
    const lead = raw.match(/^(?:HTTP\s*)?([45]\d\d)(?![\w.])/i)?.[1]
    return lead ? Number(lead) : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const box = value as Record<string, unknown>
  for (const field of STATUS_FIELDS) {
    const status = httpStatus(box[field])
    if (status !== undefined) return status
  }
  return structuredStatus(box.error, depth + 1) ?? structuredStatus(box.cause, depth + 1)
}

export function modelErrorLogFields(errorText: unknown): { cause: string; status?: number } {
  const status = structuredStatus(errorText)
  return { cause: modelErrorCause(modelErrorText(errorText)), ...(status !== undefined ? { status } : {}) }
}

export function modelLogLine(event: string, fields: Record<string, ModelLogValue>): string {
  const parts = Object.entries(fields).flatMap(([key, value]) => {
    const text = logValue(value)
    return text === null ? [] : [`${key}=${text}`]
  })
  return [event, ...parts].join(' ')
}

export function logModelEvent(event: string, fields: Record<string, ModelLogValue>): void {
  logMainEvent('模型', modelLogLine(event, fields))
}
