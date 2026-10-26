import { viewIdentityOf } from '../state/view-identity'

export interface SubmitOwnershipState {
  peekedSessionId: string | null
  peekedPath?: string | null
  session: { sessionId?: string } | null
}

export function viewingSubmitSessionId(state: SubmitOwnershipState): string | null {
  return viewIdentityOf({
    peekedSessionId: state.peekedSessionId,
    peekedPath: state.peekedPath ?? null,
    session: state.session
  }).sessionId
}

export function attachmentsAfterSubmit<T extends { id: string }>(
  current: readonly T[],
  sentIds: readonly string[]
): T[] {
  if (sentIds.length === 0) return current as T[]
  const sent = new Set(sentIds)
  const next = current.filter((item) => !sent.has(item.id))
  return next.length === current.length ? (current as T[]) : next
}

const INSTANCE_COMMANDS = new Set(['model', 'thinking', 'compact', 'clone', 'export'])

export function localCommandNeedsActivatedTarget(raw: string): boolean {
  const text = raw.trimStart()
  if (text.startsWith('!')) return true
  const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase()
  return !!name && INSTANCE_COMMANDS.has(name)
}

export interface LocalCommandGuardPort {
  raw: string
  ensureActivated: () => Promise<boolean>
  run: () => Promise<void> | void
  notifyBlocked: () => void
}

export async function runLocalCommandGuarded(port: LocalCommandGuardPort): Promise<'ran' | 'blocked'> {
  if (localCommandNeedsActivatedTarget(port.raw)) {
    const activated = await port.ensureActivated()
    if (!activated) {
      port.notifyBlocked()
      return 'blocked'
    }
  }
  await port.run()
  return 'ran'
}
