/** GPT Image provider adapters used by the `yan image generate` host command. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssistantArtifact, ImageGenerationStage } from '../shared/ipc'
import { ArtifactStore } from './artifacts'

export type ImageProvider = 'auto' | 'codex' | 'openai' | 'compatible' | 'mock'
type ResolvedImageProvider = Exclude<ImageProvider, 'auto'> | 'unavailable'

export interface ImageGenerationRequest {
  prompt: string
  provider?: ImageProvider
  model?: string
  size?: string
  quality?: string
  background?: string
  format?: 'png' | 'jpeg' | 'webp'
  mode?: 'generate' | 'edit'
  sourcePaths?: string[]
  description?: string
}

export interface ImageGenerationResult {
  provider: Exclude<ImageProvider, 'auto'>
  model: string
  artifact: AssistantArtifact
  revisedPrompt?: string
}

export type ImageProgressReporter = (stage: ImageGenerationStage, detail?: string) => void

export function resolveImageProvider(requested: ImageProvider | undefined, hasCodexAuth: boolean, hasOpenAiKey: boolean): ResolvedImageProvider {
  const configured = process.env.YAN_IMAGE_PROVIDER?.trim() as ImageProvider | undefined
  const value = (requested ?? configured) || 'auto'
  if (value !== 'auto') return value
  return hasCodexAuth
    ? 'codex'
    : process.env.YAN_IMAGE_API_BASE && (process.env.YAN_IMAGE_API_KEY?.trim() || hasOpenAiKey)
      ? 'compatible'
      : hasOpenAiKey
        ? 'openai'
        : process.env.YAN_IMAGE_PROVIDER === 'mock' ? 'mock' : 'unavailable'
}

type AuthFile = { access_token?: string; account_id?: string }

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function formatOf(value: unknown): 'png' | 'jpeg' | 'webp' {
  const v = String(value ?? 'png').toLowerCase()
  return v === 'jpeg' || v === 'jpg' ? 'jpeg' : v === 'webp' ? 'webp' : 'png'
}

function jsonHeaders(token: string, accountId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    originator: 'codex_desktop',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
}

async function readCodexAuth(): Promise<AuthFile | null> {
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  try {
    const auth = JSON.parse(await readFile(join(root, 'auth.json'), 'utf8')) as { tokens?: AuthFile }
    return auth.tokens?.access_token ? auth.tokens : null
  } catch {
    return null
  }
}

export async function codexAuthAvailable(): Promise<boolean> {
  return !!(await readCodexAuth())?.access_token
}

async function codexImage(req: ImageGenerationRequest, report?: ImageProgressReporter): Promise<{ bytes: Buffer; model: string; revisedPrompt?: string }> {
  const auth = await readCodexAuth()
  if (!auth?.access_token) throw new Error('codex_auth_missing')
  if (req.mode === 'edit' && req.sourcePaths?.length) {
    throw new Error('codex_edit_sources_require_image_adapter')
  }
  const model = stringParam(req.model, 'gpt-5.5')
  const imageModel = 'gpt-image-2'
  const payload = {
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: req.prompt }] }],
    tools: [{
      type: 'image_generation',
      size: stringParam(req.size, '1024x1024'),
      quality: stringParam(req.quality, 'auto'),
      output_format: formatOf(req.format),
      background: stringParam(req.background, 'auto')
    }],
    stream: true,
    // Codex 的 ChatGPT 后端要求图像请求显式不存储；也符合本地文件产物的隐私边界。
    store: false
  }
  report?.('requesting')
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: jsonHeaders(auth.access_token, auth.account_id),
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw new Error(`codex_http_${response.status}`)
  if (!response.body) throw new Error('codex_empty_stream')
  report?.('generating')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalB64 = ''
  let revisedPrompt: string | undefined
  const consume = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const text = line.slice(5).trim()
      if (!text || text === '[DONE]') continue
      try {
        const event = JSON.parse(text) as { type?: string; item?: { type?: string; result?: string; revised_prompt?: string } }
        const item = event.item
        if (item?.type === 'image_generation_call' && item.result) {
          finalB64 = item.result
          revisedPrompt = item.revised_prompt
        }
      } catch {
        /* SSE can split a JSON event; the next read preserves the remainder. */
      }
    }
  }
  while (true) {
    const next = await reader.read()
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    events.forEach(consume)
    if (next.done) break
  }
  consume(buffer)
  if (!finalB64) throw new Error('codex_image_result_missing')
  const bytes = Buffer.from(finalB64, 'base64')
  if (bytes.length === 0) throw new Error('image_result_empty')
  return { bytes, model: imageModel, revisedPrompt }
}

async function openAiImage(req: ImageGenerationRequest, baseUrl: string, token: string, report?: ImageProgressReporter): Promise<{ bytes: Buffer; model: string }> {
  if (req.mode === 'edit' && req.sourcePaths?.length) throw new Error('openai_edit_not_yet_wired')
  const model = stringParam(req.model, 'gpt-image-2')
  report?.('requesting')
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      size: stringParam(req.size, '1024x1024'),
      quality: stringParam(req.quality, 'auto'),
      background: stringParam(req.background, 'auto'),
      output_format: formatOf(req.format),
      n: 1
    })
  })
  if (!response.ok) throw new Error(`image_api_http_${response.status}`)
  const json = await response.json() as { data?: Array<{ b64_json?: string }> }
  const b64 = json.data?.[0]?.b64_json
  if (!b64) throw new Error('image_api_result_missing')
  report?.('generating')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0) throw new Error('image_result_empty')
  return { bytes, model }
}

function mockSvg(prompt: string): Buffer {
  const safe = prompt.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c))
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="180" fill="#101318"/><circle cx="512" cy="450" r="240" fill="#303A47"/><path d="M350 450h324v170H350z" fill="#F3F4F6"/><text x="512" y="820" fill="#98A2B3" font-size="34" text-anchor="middle" font-family="sans-serif">${safe.slice(0, 60)}</text></svg>`, 'utf8')
}

export async function generateImage(
  request: ImageGenerationRequest,
  context: { sessionFile: string; messageId: string; artifactDir: string; onProgress?: ImageProgressReporter }
): Promise<ImageGenerationResult> {
  const prompt = stringParam(request.prompt, '')
  if (!prompt) throw new Error('image_prompt_missing')
  const requested = request.provider ?? (process.env.YAN_IMAGE_PROVIDER as ImageProvider | undefined) ?? 'auto'
  const auth = await readCodexAuth()
  const openAiKey = process.env.OPENAI_API_KEY?.trim()
  const compatibleKey = process.env.YAN_IMAGE_API_KEY?.trim() || openAiKey
  const provider = resolveImageProvider(requested, !!auth?.access_token, !!openAiKey)
  if (provider === 'unavailable') throw new Error('image_provider_unavailable')
  const report = context.onProgress
  report?.('preparing', provider === 'mock' ? '正在准备本地预览' : `已选择 ${provider} 图像服务`)

  let generated: { bytes: Buffer; model: string; revisedPrompt?: string }
  if (provider === 'mock') {
    report?.('generating', '正在生成本地预览')
    generated = { bytes: mockSvg(prompt), model: 'yan-mock-svg' }
  } else if (provider === 'codex') {
    generated = await codexImage(request, report)
  } else {
    const key = provider === 'compatible' ? compatibleKey : openAiKey
    if (!key) throw new Error(provider === 'compatible' ? 'compatible_api_key_missing' : 'openai_api_key_missing')
    generated = await openAiImage(request, provider === 'compatible' ? stringParam(process.env.YAN_IMAGE_API_BASE, '') : 'https://api.openai.com/v1', key, report)
  }

  const format = provider === 'mock' ? 'svg' : formatOf(request.format)
  if (generated.bytes.length === 0) throw new Error('image_result_empty')
  report?.('saving', '正在保存受控文件')
  const artifact = await new ArtifactStore(context.artifactDir).save({
    sessionFile: context.sessionFile,
    messageId: context.messageId,
    filename: `yan-image-${randomUUID().slice(0, 8)}.${format}`,
    bytes: generated.bytes,
    provider,
    model: generated.model,
    description: request.description ?? prompt
  })
  if (artifact.bytes <= 0) throw new Error('artifact_empty')
  report?.('done', `${artifact.filename} · ${artifact.bytes} bytes`)
  return { provider, model: generated.model, artifact, revisedPrompt: generated.revisedPrompt }
}
