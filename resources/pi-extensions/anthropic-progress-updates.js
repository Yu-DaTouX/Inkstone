export const PROGRESS_UPDATES_BETA = 'thinking-display-updates-2026-08-18'
export const PROGRESS_UPDATE_MODEL = /claude-(?:(?:opus|sonnet)-5[-.]5|(?:fable|mythos)-5[-.]1|fable-5(?![-.][0-9]{1,2}(?![0-9])))/i
export const DISPLAY_REJECTED_RETRY_HINT = 'Inkstone: this endpoint rejected thinking display "updates"; you can retry your request with summarized thinking.'

const BAD_REQUEST = /\b(?:400|422)\b|invalid_request|bad request|unsupported|unknown|unrecognized|not permitted|extra inputs/i
const DISPLAY_FIELD = /display|updates|anthropic-beta|\bbetas?\b/i

export const isProgressUpdateModel = (model) =>
  model?.api === 'anthropic-messages' && typeof model.id === 'string' && PROGRESS_UPDATE_MODEL.test(model.id)

export const isDisplayRejection = (message) =>
  message?.role === 'assistant' && message.stopReason === 'error' &&
  BAD_REQUEST.test(String(message.errorMessage ?? '')) && DISPLAY_FIELD.test(String(message.errorMessage ?? ''))

export default function anthropicProgressUpdates(pi) {
  const rejections = new Map()
  const disabled = new Set()
  const summarizeNext = new Set()
  let pending = null
  const endpointKey = (model) => `${model.provider ?? ''}|${model.baseUrl ?? ''}|${model.id}`

  pi.on('before_provider_request', (event, ctx) => {
    pending = null
    const model = ctx?.model
    const payload = event?.payload
    if (!isProgressUpdateModel(model) || !payload || typeof payload !== 'object') return
    const thinking = payload.thinking
    if (!thinking || typeof thinking !== 'object' || !('display' in thinking)) return
    const key = endpointKey(model)
    if (disabled.has(key) || summarizeNext.delete(key)) return
    const betas = Array.isArray(payload.betas) ? payload.betas : []
    pending = key
    return {
      ...payload,
      thinking: { ...thinking, display: 'updates' },
      betas: betas.includes(PROGRESS_UPDATES_BETA) ? betas : [...betas, PROGRESS_UPDATES_BETA]
    }
  })

  pi.on('message_end', (event) => {
    const message = event?.message
    if (message?.role !== 'assistant' || !pending) return
    const key = pending
    pending = null
    if (message.stopReason !== 'error') {
      if (message.stopReason !== 'aborted') rejections.delete(key)
      return
    }
    if (!isDisplayRejection(message)) return
    const count = (rejections.get(key) ?? 0) + 1
    rejections.set(key, count)
    if (count >= 2) disabled.add(key)
    summarizeNext.add(key)
    return { message: { ...message, errorMessage: `${message.errorMessage}\n${DISPLAY_REJECTED_RETRY_HINT}` } }
  })
}
