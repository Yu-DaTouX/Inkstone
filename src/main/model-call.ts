import { pick } from '../shared/ui-lang'
import { THINKING_LEVELS } from '../shared/thinking-levels'
import { modelErrorText } from '../shared/model-errors'
import { PiRpc } from './protocol'

export const MODEL_CALL_DEFAULT_TIMEOUT_MS = 5 * 60_000
export const MODEL_CALL_MAX_TIMEOUT_MS = 30 * 60_000
const MODEL_CALL_MIN_TIMEOUT_MS = 1000
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000
const READY_ATTEMPTS = 40
const STDERR_TAIL = 6

export type ModelCallErrorKind = 'invalid' | 'cancelled' | 'timeout' | 'startup' | 'model' | 'empty' | 'too-long'

export class ModelCallError extends Error {
  constructor(readonly kind: ModelCallErrorKind, message: string) {
    super(message)
    this.name = 'ModelCallError'
  }
}

export interface ModelCallUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost?: number
}

export interface ModelCallRequest {
  model: string
  system?: string
  prompt: string
  thinking?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputChars?: number
}

export interface ModelCallResult {
  text: string
  model: string
  usage?: ModelCallUsage
  stopReason?: string
  durationMs: number
}

export interface ModelCallRpc {
  on(event: 'event', listener: (event: Record<string, unknown>) => void): unknown
  on(event: 'exit', listener: () => void): unknown
  on(event: 'spawn-error', listener: (error: Error) => void): unknown
  on(event: 'stderr', listener: (line: string) => void): unknown
  spawn(): void
  command(type: string, payload?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>
  close(): Promise<void>
}

export interface ModelCallRuntime {
  cwd: string
  env: Record<string, string>
  piBin?: string
  extensions?: string[]
  readyPollMs?: number
  createRpc?(opts: { cwd: string; piBin?: string; args: string[]; env: Record<string, string> }): ModelCallRpc
}

export function modelCallTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return MODEL_CALL_DEFAULT_TIMEOUT_MS
  return Math.min(MODEL_CALL_MAX_TIMEOUT_MS, Math.max(MODEL_CALL_MIN_TIMEOUT_MS, Math.round(ms)))
}

export function modelCallArgs(req: Pick<ModelCallRequest, 'model' | 'system'>, extensions: string[] = []): string[] {
  return [
    '--no-session', '--no-extensions', ...extensions.flatMap((path) => ['--extension', path]), '--no-context-files', '--no-skills',
    '--no-prompt-templates', '--no-tools', '--model', req.model,
    ...(req.system ? ['--system-prompt', req.system] : [])
  ]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageOf(raw: unknown): ModelCallUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const box = raw as Record<string, unknown>
  const cost = box.cost && typeof box.cost === 'object' ? (box.cost as Record<string, unknown>).total : box.cost
  const usage: ModelCallUsage = {
    input: num(box.input),
    output: num(box.output),
    cacheRead: num(box.cacheRead),
    cacheWrite: num(box.cacheWrite),
    totalTokens: num(box.totalTokens) || num(box.input) + num(box.output) + num(box.cacheRead) + num(box.cacheWrite)
  }
  if (typeof cost === 'number' && Number.isFinite(cost)) usage.cost = cost
  return usage
}

const cancelled = (): ModelCallError => new ModelCallError('cancelled', pick('已取消', 'Cancelled'))

export async function callModel(req: ModelCallRequest, runtime: ModelCallRuntime): Promise<ModelCallResult> {
  const model = typeof req.model === 'string' ? req.model.trim() : ''
  if (!model) throw new ModelCallError('invalid', pick('直接模型调用需要指定模型', 'A direct model call needs a model'))
  if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new ModelCallError('invalid', pick('直接模型调用需要非空提示词', 'A direct model call needs a non-empty prompt'))
  const thinking = req.thinking?.trim().toLowerCase() || 'off'
  if (!THINKING_LEVELS.includes(thinking)) throw new ModelCallError('invalid', pick(`thinking 只能是 ${THINKING_LEVELS.join(' / ')}`, `thinking must be one of ${THINKING_LEVELS.join(' / ')}`))
  const signal = req.signal
  if (signal?.aborted) throw cancelled()
  const timeoutMs = modelCallTimeout(req.timeoutMs)
  const maxOutput = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const started = Date.now()
  const args = modelCallArgs({ model, system: req.system }, runtime.extensions)
  const rpc: ModelCallRpc = runtime.createRpc
    ? runtime.createRpc({ cwd: runtime.cwd, piBin: runtime.piBin, args, env: runtime.env })
    : new PiRpc({ cwd: runtime.cwd, piBin: runtime.piBin, args, env: runtime.env })
  let cancel = (): void => {}
  try {
    return await new Promise<ModelCallResult>((resolve, reject) => {
      let text = ''
      let failure = ''
      let settled = false
      let usage: ModelCallUsage | undefined
      let stopReason: string | undefined
      let actualModel = ''
      const stderr: string[] = []
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else if (failure) reject(new ModelCallError('model', failure))
        else if (text.trim()) resolve({ text: text.trim(), model: actualModel || model, ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}), durationMs: Date.now() - started })
        else {
          const tail = stderr.length ? pick(`；pi 输出：${stderr.join(' | ')}`, `; pi said: ${stderr.join(' | ')}`) : ''
          reject(new ModelCallError('empty', `${pick('模型未返回文本', 'The model returned no text')}${stopReason ? ` (stopReason=${stopReason})` : ''}${tail}`))
        }
      }
      const timer = setTimeout(() => finish(new ModelCallError('timeout', pick(`模型调用超时（${Math.round(timeoutMs / 1000)} 秒）`, `Model call timed out (${Math.round(timeoutMs / 1000)}s)`))), timeoutMs)
      cancel = () => finish(cancelled())
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) {
        cancel()
        return
      }
      rpc.on('event', (event: Record<string, unknown>) => {
        if (settled) return
        if (event.type === 'message_start') {
          const message = event.message as Record<string, unknown> | undefined
          if (message?.role !== 'assistant') return
          text = ''
          failure = ''
        } else if (event.type === 'message_update') {
          const update = event.assistantMessageEvent as Record<string, unknown> | undefined
          if (update?.type === 'text_delta') {
            text += String(update.delta ?? '')
            if (text.length > maxOutput) finish(new ModelCallError('too-long', pick(`模型输出超过 ${maxOutput} 字符上限`, `Model output exceeded ${maxOutput} characters`)))
          }
        } else if (event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined
          if (message && message.role !== undefined && message.role !== 'assistant') return
          const errorMessage = typeof message?.errorMessage === 'string' ? message.errorMessage.trim() : ''
          failure = errorMessage ? modelErrorText(errorMessage) || errorMessage : ''
          if (failure) text = ''
          if (typeof message?.stopReason === 'string') stopReason = message.stopReason
          usage = usageOf(message?.usage) ?? usage
          if (typeof message?.provider === 'string' && typeof message.model === 'string') actualModel = `${message.provider}/${message.model}`
        } else if (event.type === 'agent_settled') finish()
      })
      rpc.on('stderr', (line: string) => {
        stderr.push(String(line).slice(0, 300))
        if (stderr.length > STDERR_TAIL) stderr.shift()
      })
      rpc.on('exit', () => finish())
      rpc.on('spawn-error', (error: Error) => finish(new ModelCallError('startup', error.message)))
      rpc.spawn()
      void (async () => {
        try {
          let ready = false
          for (let attempt = 0; attempt < READY_ATTEMPTS && !settled; attempt++) {
            await new Promise((wait) => setTimeout(wait, runtime.readyPollMs ?? 250))
            if (settled) return
            try {
              if ((await rpc.command('get_state')).success) {
                ready = true
                break
              }
            } catch {
            }
          }
          if (settled) return
          if (!ready) throw new ModelCallError('startup', `${pick('模型进程未就绪', 'The model process is not ready')}${stderr.length ? `：${stderr.join(' | ')}` : ''}`)
          await rpc.command('set_thinking_level', { level: thinking }).catch(() => undefined)
          if (settled) return
          const sent = await rpc.command('prompt', { message: req.prompt })
          if (!sent.success) throw new ModelCallError('model', modelErrorText(sent.error ?? '') || pick('pi 拒绝了这次请求', 'pi rejected the request'))
        } catch (error) {
          finish(error instanceof ModelCallError ? error : new ModelCallError('startup', error instanceof Error ? error.message : String(error)))
        }
      })()
    })
  } finally {
    signal?.removeEventListener('abort', cancel)
    await rpc.close()
  }
}
