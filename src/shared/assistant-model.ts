/** pi reports provider and model ID separately; IDs may themselves contain slashes. */
export function assistantModelIdentity(message: { provider?: unknown; model?: unknown }): string | undefined {
  if (typeof message.model !== 'string' || !message.model) return undefined
  return typeof message.provider === 'string' && message.provider
    ? `${message.provider}/${message.model}`
    : message.model
}
