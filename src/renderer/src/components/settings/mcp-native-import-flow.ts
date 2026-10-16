import type {
  NativeMcpImportCommitResponse,
  NativeMcpImportCommitResult,
  NativeMcpImportPrepareResponse,
  NativeMcpImportPreview,
  NativeMcpImportVerification
} from '../../../../shared/mcp-native-import'

export interface McpImportScope {
  mounted: boolean
  activeRunnerId: string | null
  sessionId: string
  projectKey: string
}

export function sameMcpImportScope(a: McpImportScope, b: McpImportScope): boolean {
  return (
    a.activeRunnerId === b.activeRunnerId &&
    a.sessionId === b.sessionId &&
    a.projectKey === b.projectKey
  )
}

export interface McpImportCommitProjection {
  accepted: true
  ok: boolean
  serverId: string
  nativeName: string
  targetPath: string
  nativeWritten: boolean
  deactivated: boolean
  verified: boolean
  verification: NativeMcpImportVerification | 'skipped'
  steps: NativeMcpImportCommitResult['steps']
  notice: string
  warnings: string[]
}

export function projectMcpImportCommit(result: NativeMcpImportCommitResult): McpImportCommitProjection {
  const steps = result.steps ?? { nativeWrite: 'skipped' as const, verify: 'skipped' as const, hostDisable: 'skipped' as const }
  return {
    accepted: true,
    ok: result.ok === true,
    serverId: result.serverId,
    nativeName: result.nativeName,
    targetPath: result.targetPath,
    nativeWritten: result.nativeWritten === true,
    deactivated: result.deactivated === true,
    verified: result.verified === true,
    verification: result.verification ?? 'unavailable',
    steps: {
      nativeWrite: steps.nativeWrite ?? 'skipped',
      verify: steps.verify ?? 'skipped',
      hostDisable: steps.hostDisable ?? 'skipped'
    },
    notice: typeof result.notice === 'string' ? result.notice : '',
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : []
  }
}

export type McpImportFlowOutcome =
  | { phase: 'busy' }
  | { phase: 'scope-changed' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; code: string; error: string }
  | { phase: 'committed'; projection: McpImportCommitProjection }

export interface McpImportFlowDeps {
  prepare: (serverId: string) => Promise<NativeMcpImportPrepareResponse>
  commit: (token: string) => Promise<NativeMcpImportCommitResponse>
  currentScope: () => McpImportScope
  requestConfirm: (preview: NativeMcpImportPreview) => Promise<boolean>
  isRunning?: () => boolean
}

export interface McpImportFlow {
  readonly busy: boolean
  run(serverId: string): Promise<McpImportFlowOutcome>
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

export function createMcpImportFlow(deps: McpImportFlowDeps): McpImportFlow {
  let busy = false
  const stillCurrent = (snapshot: McpImportScope): boolean => {
    const now = deps.currentScope()
    return now.mounted && snapshot.mounted && sameMcpImportScope(now, snapshot)
  }

  return {
    get busy() {
      return busy
    },
    async run(serverId: string): Promise<McpImportFlowOutcome> {
      if (busy) return { phase: 'busy' }
      busy = true
      try {
        const snapshot = deps.currentScope()
        if (!snapshot.mounted) return { phase: 'scope-changed' }
        if (deps.isRunning?.()) return { phase: 'busy' }

        let prepared: NativeMcpImportPrepareResponse
        try {
          prepared = await deps.prepare(serverId)
        } catch (error) {
          return { phase: 'failed', code: 'ipc_error', error: errorText(error) }
        }
        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (!prepared.ok || !prepared.preview) {
          return { phase: 'failed', code: prepared.code ?? 'prepare_failed', error: prepared.error ?? '' }
        }

        let approved: boolean
        try {
          approved = await deps.requestConfirm(prepared.preview)
        } catch (error) {
          return { phase: 'failed', code: 'confirmation_error', error: errorText(error) }
        }
        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (!approved) return { phase: 'cancelled' }

        if (!stillCurrent(snapshot)) return { phase: 'scope-changed' }
        if (deps.isRunning?.()) return { phase: 'busy' }

        let committed: NativeMcpImportCommitResponse
        try {
          committed = await deps.commit(prepared.preview.token)
        } catch (error) {
          return { phase: 'failed', code: 'ipc_error', error: errorText(error) }
        }
        if (!committed.ok || !committed.result) {
          return { phase: 'failed', code: committed.code ?? 'commit_rejected', error: committed.error ?? '' }
        }
        return { phase: 'committed', projection: projectMcpImportCommit(committed.result) }
      } finally {
        busy = false
      }
    }
  }
}

export function migratedTargetScope(targetPath: string): 'global' | 'project' | null {
  const normalized = targetPath.replace(/\\/g, '/')
  if (!normalized) return null
  if (/\/\.pi\/mcp\.json$/i.test(normalized)) return 'project'
  if (/\/mcp\.json$/i.test(normalized)) return 'global'
  return null
}
