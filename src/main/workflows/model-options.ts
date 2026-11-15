import { pick } from '../../shared/ui-lang'
import { createHash } from 'node:crypto'
import { THINKING_LEVELS } from '../../shared/thinking-levels'
import { WORKFLOW_LIMITS } from '../../shared/workflows'
import { schemaProblem, type JsonSchema } from './schema'

export interface WorkflowModelOptions {
  label?: string
  model?: string
  system?: string
  thinking?: string
  schema?: JsonSchema
  timeoutMinutes?: number
  retries?: number
}

const KNOWN = new Set(['label', 'model', 'system', 'thinking', 'schema', 'timeoutMinutes', 'retries'])

function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(pick(`model() 选项 ${name} 必须是字符串`, `model() option ${name} must be a string`))
  const trimmed = value.trim()
  if (trimmed.length > max) throw new RangeError(pick(`model() 选项 ${name} 超过 ${max} 字符`, `model() option ${name} is longer than ${max} characters`))
  return trimmed || undefined
}

function int(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RangeError(pick(`model() 选项 ${name} 必须是 ${min}–${max} 的整数`, `model() option ${name} must be an integer from ${min} to ${max}`))
  return value
}

export function normalizeModelCall(prompt: unknown, raw: unknown): { prompt: string; options: WorkflowModelOptions } {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError(pick('model(prompt, options) 的 prompt 必须是非空字符串', 'The prompt of model(prompt, options) must be a non-empty string'))
  if (prompt.length > WORKFLOW_LIMITS.maxModelPromptChars) throw new RangeError(pick(`model() 的 prompt 超过 ${WORKFLOW_LIMITS.maxModelPromptChars} 字符`, `The model() prompt is longer than ${WORKFLOW_LIMITS.maxModelPromptChars} characters`))
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError(pick('model() 的第二个参数必须是选项对象', 'The second argument of model() must be an options object'))
  const box = (raw ?? {}) as Record<string, unknown>
  const unknown = Object.keys(box).find((key) => !KNOWN.has(key))
  if (unknown) throw new TypeError(pick(`model() 不认识的选项：${unknown}（可用：${[...KNOWN].join(' / ')}）`, `Unknown model() option: ${unknown} (available: ${[...KNOWN].join(' / ')})`))
  const options: WorkflowModelOptions = {}
  const label = text(box.label, 'label', 200)
  if (label) options.label = label
  const model = text(box.model, 'model', 200)
  if (model) options.model = model
  const system = text(box.system, 'system', 200_000)
  if (system) options.system = system
  const thinking = text(box.thinking, 'thinking', 20)?.toLowerCase()
  if (thinking) {
    if (!THINKING_LEVELS.includes(thinking)) throw new RangeError(pick(`model() 选项 thinking 只能是 ${THINKING_LEVELS.join(' / ')}`, `model() option thinking must be one of ${THINKING_LEVELS.join(' / ')}`))
    options.thinking = thinking
  }
  const minutes = int(box.timeoutMinutes, 'timeoutMinutes', 1, 30)
  if (minutes !== undefined) options.timeoutMinutes = minutes
  const retries = int(box.retries, 'retries', 0, 5)
  if (retries !== undefined) options.retries = retries
  if (box.schema !== undefined && box.schema !== null) {
    const problem = schemaProblem(box.schema)
    if (problem) throw new TypeError(pick(`model() 的 schema 有问题：${problem}`, `model() schema problem: ${problem}`))
    options.schema = JSON.parse(JSON.stringify(box.schema)) as JsonSchema
  }
  return { prompt: prompt.trim(), options }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function modelPromptHash(prompt: string, options: WorkflowModelOptions): string {
  const keyed: Record<string, unknown> = { ...options }
  delete keyed.label
  delete keyed.timeoutMinutes
  delete keyed.retries
  return createHash('sha256').update(JSON.stringify(canonical({ kind: 'model', prompt, ...keyed }))).digest('hex').slice(0, 16)
}
