/** Preserve safe provider failure identifiers without changing requests, retry policy or context. */
/*
 * `response` 保存的是**最近一次** HTTP 响应头信息（状态、request-id、cf-ray）。
 * 同一进程里请求是串行的，所以这份关联通常就是出错那一次；但如果将来出现并发
 * 请求，requestId 只能当作「附近的」线索 —— 真正的本次 id 取 provider_stream_event
 * 自带的 response.id（见下面的 responseId）。
 */
const identifier = value => typeof value === 'string' && value.length <= 160 &&
  /^[a-zA-Z0-9_.:/-]+$/.test(value) && !/^(sk-|bearer|eyJ)/i.test(value) ? value : undefined
const statusCode = value => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
const header = (headers, key) => {
  if (typeof headers?.get === 'function') return headers.get(key)
  if (!headers || typeof headers !== 'object') return undefined
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1]
}

export default function providerDiagnostics(pi) {
  let response = {}
  let last = ''
  const record = (event, ctx, fields) => {
    const detail = {
      provider: identifier(event?.provider ?? ctx?.model?.provider),
      api: identifier(event?.api ?? ctx?.model?.api),
      model: identifier(event?.model ?? ctx?.model?.id),
      ...fields
    }
    // Undefined fields are omitted; only explicitly selected identifiers reach disk or stderr.
    const json = JSON.stringify(detail)
    if (json === last) return
    last = json
    try { pi.appendEntry('inkstone-provider-error', JSON.parse(json)) } catch { /* diagnostics must not break the original request */ }
    try { console.error(`[Inkstone/provider-error] ${json}`) } catch { /* closed stderr */ }
  }
  pi.on('before_provider_request', () => { response = {}; last = '' })
  pi.on('after_provider_response', (event, ctx) => {
    try {
      response = {
        status: statusCode(event?.status),
        requestId: identifier(header(event?.headers, 'x-request-id') ?? header(event?.headers, 'request-id') ?? header(event?.headers, 'openai-request-id')),
        traceId: identifier(header(event?.headers, 'cf-ray'))
      }
      last = ''
      if (response.status >= 400) record(event, ctx, { event: 'http_error', ...response })
    } catch { /* unknown upstream shape */ }
  })
  pi.on('provider_stream_event', (event, ctx) => {
    try {
      const data = event?.data
      if (!data || typeof data !== 'object') return
      const responseId = identifier(data.response?.id ?? data.response_id)
      if (data.type === 'response.created') {
        response = { ...response, responseId }
        return
      }
      if (data.type !== 'error' && data.type !== 'response.failed') return
      const error = data.response?.error ?? data.error
      record(event, ctx, {
        ...response,
        event: data.type,
        code: identifier(data.code ?? error?.code),
        errorType: identifier(error?.type),
        ...(statusCode(data.status ?? error?.status) ? { status: statusCode(data.status ?? error?.status) } : {}),
        ...(responseId ? { responseId } : {})
      })
    } catch { /* never replace provider errors with a diagnostics error */ }
  })
}
