import { createHash } from 'node:crypto'
import { THINKING_LEVELS } from '../../shared/thinking-levels'
import { schemaInstruction, schemaProblem, type JsonSchema } from './schema'

export interface WorkflowAgentOptions {
  label?: string
  model?: string
  thinking?: string
  readOnly?: boolean
  isolation?: 'worktree'
  timeoutMinutes?: number
  goal?: string
  deliverables?: string[]
  sources?: string[]
  boundary?: string
  schema?: JsonSchema
}

const KNOWN = new Set(['label', 'model', 'thinking', 'readOnly', 'isolation', 'timeoutMinutes', 'goal', 'deliverables', 'sources', 'boundary', 'schema'])
export const MAX_PROMPT_CHARS = 12_000

function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`agent() 选项 ${name} 必须是字符串`)
  const trimmed = value.trim()
  if ([...trimmed].length > max) throw new RangeError(`agent() 选项 ${name} 超过 ${max} 字符`)
  return trimmed || undefined
}

function list(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`agent() 选项 ${name} 必须是字符串数组`)
  const items = value.map((item: string) => item.trim()).filter(Boolean)
  return items.length ? items : undefined
}

export function normalizeAgentCall(prompt: unknown, raw: unknown): { prompt: string; options: WorkflowAgentOptions } {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('agent(prompt, options) 的 prompt 必须是非空字符串')
  if (prompt.length > MAX_PROMPT_CHARS) throw new RangeError(`agent() 的 prompt 超过 ${MAX_PROMPT_CHARS} 字符`)
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError('agent() 的第二个参数必须是选项对象')
  const box = (raw ?? {}) as Record<string, unknown>
  const unknown = Object.keys(box).find((key) => !KNOWN.has(key))
  if (unknown) throw new TypeError(`agent() 不认识的选项：${unknown}（可用：${[...KNOWN].join(' / ')}）`)
  const options: WorkflowAgentOptions = {}
  const label = text(box.label, 'label', 80)
  if (label) options.label = label
  const model = text(box.model, 'model', 200)
  if (model) options.model = model
  const thinking = text(box.thinking, 'thinking', 20)?.toLowerCase()
  if (thinking) {
    if (!THINKING_LEVELS.includes(thinking)) throw new RangeError(`agent() 选项 thinking 只能是 ${THINKING_LEVELS.join(' / ')}`)
    options.thinking = thinking
  }
  if (box.readOnly !== undefined && typeof box.readOnly !== 'boolean') throw new TypeError('agent() 选项 readOnly 必须是 true 或 false')
  if (box.readOnly === true) options.readOnly = true
  if (box.isolation !== undefined && box.isolation !== null && box.isolation !== 'none') {
    if (box.isolation !== 'worktree') throw new RangeError("agent() 选项 isolation 只能是 'worktree'")
    if (options.readOnly) throw new RangeError('agent() 的 readOnly 和 isolation: \'worktree\' 不能同时用：只读代理不改文件，不需要隔离')
    options.isolation = 'worktree'
  }
  if (box.timeoutMinutes !== undefined && box.timeoutMinutes !== null) {
    const minutes = box.timeoutMinutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RangeError('agent() 选项 timeoutMinutes 必须是 1–60 的整数')
    options.timeoutMinutes = minutes
  }
  const goal = text(box.goal, 'goal', 4000)
  if (goal) options.goal = goal
  const deliverables = list(box.deliverables, 'deliverables')
  if (deliverables) options.deliverables = deliverables
  const sources = list(box.sources, 'sources')
  if (sources) options.sources = sources
  const boundary = text(box.boundary, 'boundary', 2000)
  if (boundary) options.boundary = boundary
  if (box.schema !== undefined && box.schema !== null) {
    const problem = schemaProblem(box.schema)
    if (problem) throw new TypeError(`agent() 的 schema 有问题：${problem}`)
    options.schema = JSON.parse(JSON.stringify(box.schema)) as JsonSchema
    const total = prompt.trim().length + schemaInstruction(options.schema).length
    if (total > MAX_PROMPT_CHARS) throw new RangeError(`agent() 的 prompt 加上 schema 说明共 ${total} 字符，超过子代理任务上限 ${MAX_PROMPT_CHARS}；缩短 prompt 或 schema`)
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

export function promptHash(prompt: string, options: WorkflowAgentOptions): string {
  const keyed: Record<string, unknown> = { ...options }
  delete keyed.label
  delete keyed.timeoutMinutes
  return createHash('sha256').update(JSON.stringify(canonical({ prompt, ...keyed }))).digest('hex').slice(0, 16)
}

export function subagentStartParams(prompt: string, options: WorkflowAgentOptions): Record<string, unknown> {
  const brief: Record<string, unknown> = {}
  if (options.goal) brief.goal = options.goal
  if (options.deliverables) brief.deliverables = options.deliverables
  if (options.sources) brief.sources = options.sources
  if (options.boundary) brief.boundary = options.boundary
  if (options.timeoutMinutes) brief.timeoutMinutes = options.timeoutMinutes
  return {
    task: options.schema ? `${prompt}${schemaInstruction(options.schema)}` : prompt,
    ...(options.label ? { title: options.label } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(Object.keys(brief).length ? { brief } : {})
  }
}
