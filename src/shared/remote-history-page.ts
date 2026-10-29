export const REMOTE_TOOL_OUTPUT_CHARS = 4000
export const REMOTE_TOOL_ARG_CHARS = 1000

function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function remoteToolArgs(args: unknown): unknown {
  if (typeof args === 'string') return args.length > REMOTE_TOOL_ARG_CHARS ? `${args.slice(0, REMOTE_TOOL_ARG_CHARS)}…` : args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, remoteToolArgs(value)]))
}

export function remoteToolCall<T extends { args?: unknown; argsRaw?: string; output?: string; details?: unknown; images?: unknown }>(tool: T): Omit<T, 'details' | 'images' | 'argsRaw'> {
  const { details: _details, images: _images, argsRaw: _argsRaw, ...rest } = tool
  return {
    ...rest,
    ...('args' in rest ? { args: remoteToolArgs(rest.args) } : {}),
    ...(typeof rest.output === 'string' ? { output: clipTail(rest.output, REMOTE_TOOL_OUTPUT_CHARS) } : {})
  }
}

export function remoteHistoryPage<T extends { id: string }>(messages: T[], limit: number, before?: string) {
  const end = before ? messages.findIndex((message) => message.id === before) : messages.length
  if (end < 0) return null
  const start = Math.max(0, end - limit)
  const page = messages.slice(start, end)
  return { messages: page, hasMore: start > 0, nextBefore: start > 0 ? page[0]?.id : undefined }
}
