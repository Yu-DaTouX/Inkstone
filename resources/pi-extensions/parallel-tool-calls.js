export const PARALLEL_APIS = new Set(['openai-responses', 'azure-openai-responses', 'openai-completions'])
export const PARALLEL_REJECTED_RETRY_HINT = 'Inkstone: this endpoint rejected parallel_tool_calls; you can retry your request without it.'

const BAD_REQUEST = /\b(?:400|422)\b|invalid_request|bad request/i
const UNKNOWN_FIELD = /unknown|unrecognized|extra (?:inputs|fields)|not permitted|not allowed|unsupported|not supported|invalid (?:parameter|field|argument)/i

export const isParallelRejection = (message) => {
  if (message?.role !== 'assistant' || message.stopReason !== 'error') return false
  const text = String(message.errorMessage ?? '')
  return /parallel/i.test(text) || (BAD_REQUEST.test(text) && UNKNOWN_FIELD.test(text))
}

export default function parallelToolCalls(pi) {
  const disabled = new Set()
  let pending = null
  const endpointKey = (model) => `${model.provider ?? ''}|${model.baseUrl ?? ''}|${model.id}`

  pi.on('before_provider_request', (event, ctx) => {
    pending = null
    const model = ctx?.model
    const payload = event?.payload
    if (!model || !PARALLEL_APIS.has(model.api) || !payload || typeof payload !== 'object') return
    if (!Array.isArray(payload.tools) || payload.tools.length === 0 || 'parallel_tool_calls' in payload) return
    const key = endpointKey(model)
    if (disabled.has(key)) return
    pending = key
    return { ...payload, parallel_tool_calls: true }
  })

  pi.on('message_end', (event) => {
    const message = event?.message
    if (message?.role !== 'assistant' || !pending) return
    const key = pending
    pending = null
    if (!isParallelRejection(message)) return
    disabled.add(key)
    return { message: { ...message, errorMessage: `${message.errorMessage}\n${PARALLEL_REJECTED_RETRY_HINT}` } }
  })
}
