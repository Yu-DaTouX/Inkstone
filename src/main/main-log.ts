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

export function modelErrorLogFields(errorText: unknown): { cause: string; status?: number } {
  const text = modelErrorText(errorText)
  const status = text.match(/\b([45]\d\d)\b/)?.[1]
  return { cause: modelErrorCause(text), ...(status ? { status: Number(status) } : {}) }
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
