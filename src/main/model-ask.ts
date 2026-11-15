import { pick } from '../shared/ui-lang'
import { THINKING_LEVELS } from '../shared/thinking-levels'
import { CapabilityCommandError, type CapabilityCommandResult } from './capability-server'
import { MODEL_CALL_DEFAULT_TIMEOUT_MS, type ModelCallRequest, type ModelCallResult } from './model-call'
import { createProjectFiles } from './workflows/project-files'
import { extractJson, schemaInstruction, schemaProblem, validateJson, type JsonSchema } from './workflows/schema'

export interface ModelAskContext {
  cwd: string
  model?: string
}

export interface ModelAskDeps {
  call(req: ModelCallRequest): Promise<ModelCallResult>
}

const ALIASES: Record<string, string> = {
  'prompt-file': 'promptFile',
  'out-file': 'outFile',
  'timeout-minutes': 'timeoutMinutes'
}
const KNOWN = new Set(['model', 'system', 'prompt', 'promptFile', 'thinking', 'schema', 'timeoutMinutes', 'outFile'])
const MAX_INLINE_PROMPT = 900_000
const PREVIEW_CHARS = 400

function invalid(message: string): CapabilityCommandError {
  return new CapabilityCommandError('model_param_invalid', message)
}

function str(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw invalid(pick(`${name} 必须是字符串`, `${name} must be a string`))
  return value.trim() || undefined
}

function normalize(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'toolCall') continue
    const name = ALIASES[key] ?? key
    if (!KNOWN.has(name)) throw invalid(pick(`yan model ask 不认识的参数：${key}（可用：${[...KNOWN].join(' / ')}）`, `Unknown yan model ask parameter: ${key} (available: ${[...KNOWN].join(' / ')})`))
    out[name] = value
  }
  return out
}

export async function runModelAsk(rawParams: Record<string, unknown>, context: ModelAskContext, deps: ModelAskDeps, signal?: AbortSignal): Promise<CapabilityCommandResult> {
  const params = normalize(rawParams)
  if (params.prompt !== undefined && params.prompt !== null && typeof params.prompt !== 'string') throw invalid(pick('prompt 必须是字符串', 'prompt must be a string'))
  const inline = typeof params.prompt === 'string' ? params.prompt : undefined
  const promptFile = str(params.promptFile, 'promptFile')
  if (inline !== undefined && inline.trim() && promptFile) throw invalid(pick('prompt 与 promptFile 只能给一个', 'Give either prompt or promptFile, not both'))
  if (!promptFile && !inline?.trim()) throw new CapabilityCommandError('model_prompt_required', pick('yan model ask 需要 prompt（短文本）或 promptFile（项目内的文本文件）', 'yan model ask needs prompt (short text) or promptFile (a text file in the project)'))
  if (inline && inline.length > MAX_INLINE_PROMPT) throw invalid(pick(`prompt 超过 ${MAX_INLINE_PROMPT} 字符；长材料写进项目内文件后用 promptFile`, `prompt is longer than ${MAX_INLINE_PROMPT} characters; write long material to a project file and use promptFile`))
  const system = str(params.system, 'system')
  const thinking = str(params.thinking, 'thinking')?.toLowerCase()
  if (thinking && !THINKING_LEVELS.includes(thinking)) throw invalid(pick(`thinking 只能是 ${THINKING_LEVELS.join(' / ')}`, `thinking must be one of ${THINKING_LEVELS.join(' / ')}`))
  let timeoutMs = MODEL_CALL_DEFAULT_TIMEOUT_MS
  if (params.timeoutMinutes !== undefined && params.timeoutMinutes !== null && params.timeoutMinutes !== '') {
    const minutes = typeof params.timeoutMinutes === 'number' ? params.timeoutMinutes : Number(params.timeoutMinutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw invalid(pick('timeoutMinutes 必须是 1–30 的整数', 'timeoutMinutes must be an integer from 1 to 30'))
    timeoutMs = minutes * 60_000
  }
  let schema: JsonSchema | undefined
  if (params.schema !== undefined && params.schema !== null && params.schema !== '') {
    let value = params.schema
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch (error) {
        throw invalid(pick(`schema 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, `schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    const problem = schemaProblem(value)
    if (problem) throw invalid(pick(`schema 有问题：${problem}`, `schema problem: ${problem}`))
    schema = value as JsonSchema
  }
  const outFile = str(params.outFile, 'outFile')
  const files = createProjectFiles(context.cwd)
  const pathError = (error: unknown): CapabilityCommandError => new CapabilityCommandError('model_path_invalid', error instanceof Error ? error.message : String(error))
  if (outFile) {
    try {
      files.relativeOf(outFile)
    } catch (error) {
      throw pathError(error)
    }
  }
  let prompt = inline?.trim() ?? ''
  if (promptFile) {
    try {
      prompt = files.readText(promptFile)
    } catch (error) {
      throw pathError(error)
    }
    if (!prompt.trim()) throw new CapabilityCommandError('model_prompt_required', pick(`promptFile 是空文件：${promptFile}`, `promptFile is empty: ${promptFile}`))
  }
  const model = str(params.model, 'model') ?? context.model
  if (!model) throw new CapabilityCommandError('model_required', pick('当前会话没有模型，请在请求里写 model（例如 provider/model-id）', 'The session has no model; set model in the request (for example provider/model-id)'))
  let result: ModelCallResult
  try {
    result = await deps.call({
      model,
      prompt: schema ? `${prompt}${schemaInstruction(schema)}` : prompt,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      timeoutMs,
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    const kind = (error as { kind?: unknown } | null)?.kind
    throw new CapabilityCommandError(kind === 'timeout' ? 'model_call_timeout' : kind === 'cancelled' ? 'model_call_cancelled' : 'model_call_failed', error instanceof Error ? error.message : String(error))
  }
  let json: unknown
  if (schema) {
    const extracted = extractJson(result.text)
    const errors = extracted.ok ? validateJson(extracted.value, schema) : [extracted.error]
    if (!extracted.ok || errors.length) throw new CapabilityCommandError('model_schema_failed', pick(`输出没有通过 JSON schema 校验：${errors.join('；')}`, `Output did not pass JSON schema validation: ${errors.join('; ')}`), { text: result.text, model: result.model })
    json = extracted.value
  }
  let written: { path: string; bytes: number } | undefined
  if (outFile) {
    try {
      written = files.writeText(outFile, schema ? JSON.stringify(json, null, 2) : result.text)
    } catch (error) {
      throw new CapabilityCommandError('model_out_file_failed', pick(`模型已返回，但写 outFile 失败：${error instanceof Error ? error.message : String(error)}`, `The model answered, but writing outFile failed: ${error instanceof Error ? error.message : String(error)}`), { text: result.text, model: result.model })
    }
  }
  const preview = result.text.length > PREVIEW_CHARS ? `${result.text.slice(0, PREVIEW_CHARS)}…` : result.text
  return {
    data: {
      text: result.text,
      ...(schema ? { json } : {}),
      model: result.model,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      durationMs: result.durationMs,
      ...(written ? { outFile: written.path, outBytes: written.bytes } : {})
    },
    summary: {
      kind: 'model',
      action: 'ask',
      model: result.model,
      chars: result.text.length,
      preview,
      ...(result.text.length > PREVIEW_CHARS ? { previewTruncated: true, full: pick('全文在 resultFile 的 text', 'Full text is in resultFile.text') } : {}),
      ...(result.usage ? { usage: { input: result.usage.input, output: result.usage.output, totalTokens: result.usage.totalTokens } } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      durationMs: result.durationMs,
      ...(written ? { outFile: written.path } : {})
    }
  }
}
