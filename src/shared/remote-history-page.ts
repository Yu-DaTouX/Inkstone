/** Page by a stable message ID, so newly appended messages do not shift older pages. */
export function remoteHistoryPage<T extends { id: string }>(messages: T[], limit: number, before?: string) {
  const end = before ? messages.findIndex((message) => message.id === before) : messages.length
  if (end < 0) return null
  const start = Math.max(0, end - limit)
  const page = messages.slice(start, end)
  return { messages: page, hasMore: start > 0, nextBefore: start > 0 ? page[0]?.id : undefined }
}
