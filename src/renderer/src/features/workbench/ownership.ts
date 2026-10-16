import type { WorkspaceOwner } from './types'
import { workspaceKeyFor } from '../../state/workspace-key'
import { viewIdentityOf } from '../../state/view-identity'

export interface OwnerViewSession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
  cwd?: string
}

export interface OwnerViewRunner {
  id?: string
  runId: string
  sessionId?: string
  sessionFile?: string
  cwd: string
  generation: number
  isActive?: boolean
}

export interface OwnerViewPending {
  sessionId?: string
  sessionFile?: string
  cwd: string
}

export interface OwnerViewInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: OwnerViewSession | null
  pendingActivation: OwnerViewPending | null
  activeRunnerId: string | null
  runners: readonly OwnerViewRunner[]
  sessions: readonly { id: string; path: string; cwd: string }[]
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

function sameFile(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

export function viewIdentity(input: OwnerViewInput): { sessionId: string | null; sessionFile: string | null } {
  const id = viewIdentityOf(input)
  return { sessionId: id.sessionId, sessionFile: id.sessionFile }
}

function runnerMatchesView(runner: OwnerViewRunner, sessionId: string | null, sessionFile: string | null): boolean {
  if (sessionId && runner.sessionId && runner.sessionId === sessionId) return true
  if (sessionFile && sameFile(runner.sessionFile, sessionFile)) return true
  return false
}

function pendingMatchesView(pending: OwnerViewPending, sessionId: string | null, sessionFile: string | null): boolean {
  if (sessionId && pending.sessionId && pending.sessionId === sessionId) return true
  if (sessionFile && sameFile(pending.sessionFile, sessionFile)) return true
  return false
}

function sessionIsView(session: OwnerViewSession | null, sessionId: string | null, sessionFile: string | null): boolean {
  if (!session) return false
  if (sessionId) return session.sessionId === sessionId || session.conversationId === sessionId
  if (sessionFile) return sameFile(session.sessionFile, sessionFile) || sameFile(session.conversationFile, sessionFile)
  return true
}

export function deriveWorkspaceOwner(input: OwnerViewInput): WorkspaceOwner {
  const { sessionId, sessionFile } = viewIdentity(input)

  const viewRunner = input.runners.find((runner) => runnerMatchesView(runner, sessionId, sessionFile)) ?? null
  const activeRunner = input.activeRunnerId
    ? input.runners.find((runner) => (runner.runId ?? runner.id) === input.activeRunnerId) ?? null
    : null

  const pending = input.pendingActivation
  const pendingForView = !!pending && (!pending.sessionId && !pending.sessionFile ? false : pendingMatchesView(pending, sessionId, sessionFile))
  const summary = sessionId || sessionFile
    ? input.sessions.find((item) => (sessionId ? item.id === sessionId : sameFile(item.path, sessionFile))) ?? null
    : null

  const cwd =
    viewRunner?.cwd ||
    (pendingForView ? pending!.cwd : '') ||
    (sessionIsView(input.session, sessionId, sessionFile) ? input.session?.cwd ?? '' : '') ||
    summary?.cwd ||
    ''

  const activeRunnerMatchesView = !!activeRunner && runnerMatchesView(activeRunner, sessionId, sessionFile)
  const active =
    !pending &&
    !(
      activeRunner &&
      (sessionId || sessionFile) &&
      !activeRunnerMatchesView &&
      !sessionIsView(input.session, sessionId, sessionFile)
    )

  return {
    key: workspaceKeyFor({ sessionId: sessionId ?? undefined, path: sessionFile ?? undefined }),
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    ...(active && viewRunner ? { runId: viewRunner.runId, generation: viewRunner.generation } : {}),
    active
  }
}
