const SUBAGENT_ID = /^sub-[a-zA-Z0-9-]+$/

export function normalizeSubagentId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : ''
  return SUBAGENT_ID.test(id) ? id : null
}
