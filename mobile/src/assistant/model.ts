/**
 * 模型调用：只走 OpenAI 兼容的 `/chat/completions`。
 *
 * React Native 的 fetch 拿不到分块响应，所以这里一次性取回整段回答，
 * 由界面按字渐显——观感接近流式，但它确实不是流式；真正的流式留给后续原生模块。
 * 错误一律翻成用户看得懂的一句话（密钥、额度、模型名、网络）。
 */

export type ChatRole = 'system' | 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

export type ChatRequest = {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type ChatResult = {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

/** 把 HTTP 状态与响应体翻成一句中文，不把原始 JSON 丢给用户。 */
function readableError(status: number, body: string): string {
  if (status === 401 || status === 403) return '密钥无效或没有权限（401/403）'
  if (status === 402) return '额度不足（402）'
  if (status === 404) return '接口或模型名不对（404）：检查地址是否以 /v1 结尾、模型名是否正确'
  if (status === 429) return '请求太频繁（429），稍后再试'
  if (status >= 500) return `服务商出错（${status}），稍后再试`
  const detail = body.replace(/\s+/g, ' ').slice(0, 200)
  return detail ? `请求失败（${status}）：${detail}` : `请求失败（${status}）`
}

type CompletionPayload = {
  choices?: { message?: { content?: unknown } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function chat(request: ChatRequest): Promise<ChatResult> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = request.timeoutMs ?? 120_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  if (request.signal?.aborted) controller.abort()
  request.signal?.addEventListener('abort', abort)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.apiKey}` },
      body: JSON.stringify({ model: request.model, messages: request.messages, temperature: request.temperature ?? 0.7 }),
      signal: controller.signal
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(readableError(response.status, body))
    }
    const data = (await response.json()) as CompletionPayload
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回内容')
    return { text, usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时或已取消')
    if (error instanceof TypeError) throw new Error('连不上服务商：检查网络、地址与证书')
    throw error
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
  }
}

/** 「测试连接」：拉一次模型列表，比发一条对话便宜，也不会消耗额度。 */
export async function listModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(readableError(response.status, body))
    }
    const data = (await response.json()) as { data?: { id?: unknown }[] }
    return (data.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => id.length > 0)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('连接超时')
    if (error instanceof TypeError) throw new Error('连不上服务商：检查网络、地址与证书')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
