import { isSubagentNotice } from './subagent-notice'
import { parseHostTextNotice, type HostTextNotice } from './host-notice-text'

export type HostNotice = HostTextNotice | { kind: 'subagent' }

export function parseHostNotice(text: string | undefined): HostNotice | null {
  const notice = parseHostTextNotice(text)
  if (notice) return notice
  const body = (text ?? '').trim()
  return body && isSubagentNotice(body) ? { kind: 'subagent' } : null
}
