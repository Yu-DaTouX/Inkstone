export interface QuestionFrequencyRunnerView {
  id: string
  runId?: string
  sessionId?: string
  sessionFile?: string
}

export interface QuestionFrequencyTargetInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string } | null
  pendingActivation: { sessionId?: string; sessionFile?: string } | null
  activeRunnerId: string | null
  runners: readonly QuestionFrequencyRunnerView[]
}

export type QuestionFrequencyTargetReason = 'ok' | 'no-session' | 'pending-activation' | 'no-runner'

export interface QuestionFrequencyTarget {
  enabled: boolean
  reason: QuestionFrequencyTargetReason
  runnerId?: string
  sessionId?: string
  sessionFile?: string
}

const normalizePath = (value?: string): string => (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

interface DisplayedSession {
  sessionId?: string
  sessionFile?: string
}

function displayedSession(input: QuestionFrequencyTargetInput): DisplayedSession | null {
  if (input.peekedSessionId || input.peekedPath) {
    return { sessionId: input.peekedSessionId ?? undefined, sessionFile: input.peekedPath ?? undefined }
  }
  if (input.session?.sessionId || input.session?.sessionFile) {
    return {
      sessionId: input.session.sessionId || undefined,
      sessionFile: input.session.sessionFile || undefined
    }
  }
  return null
}

function runnerMatchesSession(runner: QuestionFrequencyRunnerView, displayed: DisplayedSession): boolean {
  if (displayed.sessionId && runner.sessionId && displayed.sessionId === runner.sessionId) return true
  if (displayed.sessionFile && runner.sessionFile) {
    return normalizePath(displayed.sessionFile) === normalizePath(runner.sessionFile)
  }
  return false
}

export function sessionQuestionFrequencyTarget(input: QuestionFrequencyTargetInput): QuestionFrequencyTarget {
  const displayed = displayedSession(input)
  if (!displayed?.sessionId && !displayed?.sessionFile) return { enabled: false, reason: 'no-session' }

  const matches = input.runners.filter((runner) => runnerMatchesSession(runner, displayed))

  if (!matches.length) {
    return { enabled: false, reason: input.pendingActivation ? 'pending-activation' : 'no-runner' }
  }

  const active = matches.find((runner) => (runner.runId ?? runner.id) === input.activeRunnerId)
  const chosen = active ?? matches[0]
  return {
    enabled: true,
    reason: 'ok',
    runnerId: chosen.id,
    sessionId: displayed.sessionId,
    sessionFile: displayed.sessionFile
  }
}
