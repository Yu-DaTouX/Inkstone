import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '../../i18n'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { CapabilityMcpServerSettingView } from '../../../../shared/ipc'
import type { NativeMcpImportPreview } from '../../../../shared/mcp-native-import'
import { WINDOWS_MCP_SERVER_ID } from '../../../../shared/mcp-native-import'
import { Button } from '../ui'
import { useConfirm } from '../ui/confirm'
import {
  createMcpImportFlow,
  migratedTargetScope,
  type McpImportCommitProjection,
  type McpImportFlowOutcome,
  type McpImportScope
} from './mcp-native-import-flow'

type T = (key: MessageKey, vars?: Record<string, string | number>) => string

interface McpNativeImportProps {
  server: CapabilityMcpServerSettingView
  onChanged: () => Promise<void> | void
}

const STEP_STATE_KEY: Record<string, MessageKey> = {
  written: 'cap.importState.written',
  failed: 'cap.importState.failed',
  skipped: 'cap.importState.skipped',
  passed: 'cap.importState.passed',
  unavailable: 'cap.importState.unavailable',
  disabled: 'cap.importState.disabled',
  'skipped-external-change': 'cap.importState.skippedExternalChange'
}

const MANUAL_CODES = new Set(['needs_reauth', 'needs_auth', 'needs-auth', 'unsupported', 'not_trusted', 'unavailable'])

function entryJson(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, null, 2)
  } catch {
    return String(entry)
  }
}

function scopeLabel(t: T, scope: 'global' | 'project'): string {
  return scope === 'project' ? t('cap.importScope.project') : t('cap.importScope.global')
}

function buildImportDetail(t: T, preview: NativeMcpImportPreview, sourceTitle: string): string {
  const lines = [
    `${t('cap.importSourceTitle')}: ${sourceTitle}`,
    `${t('cap.importNativeName')}: ${preview.nativeName}`,
    scopeLabel(t, preview.scope),
    `${t('cap.importTargetPath')}: ${preview.targetPath}`,
    '',
    `${t('cap.importEntry')}:`,
    entryJson(preview.serverEntry)
  ]
  const notes = [...preview.warnings]
  if (preview.reauthNotice) notes.push(preview.reauthNotice)
  if (notes.length > 0) {
    lines.push('', `${t('cap.importWarnings')}:`, ...notes.map((note) => `- ${note}`))
  }
  return lines.join('\n')
}

export function McpNativeImport({ server, onChanged }: McpNativeImportProps): React.JSX.Element | null {
  const t = useT()
  const confirm = useConfirm()
  const running = useStore((s) => s.runners.some(runner => runner.running) || !!s.session?.isAgentRunning || !!s.session?.isStreaming || !!s.session?.isCompacting)
  const mountedRef = useRef(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<McpImportFlowOutcome | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const currentScope = useCallback((): McpImportScope => {
    const state = useStore.getState()
    const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
    return {
      mounted: mountedRef.current,
      activeRunnerId: state.activeRunnerId,
      sessionId: state.session?.sessionId ?? '',
      projectKey: runner?.projectId ?? state.session?.cwd ?? state.settings?.cwd ?? ''
    }
  }, [])

  const requestConfirm = useCallback(
    (preview: NativeMcpImportPreview): Promise<boolean> =>
      confirm({
        title: t('cap.importConfirmTitle', { name: server.title }),
        body: `${t('cap.importConfirmBody')}\n${t('cap.importConfirmLocalWarning')}`,
        detail: buildImportDetail(t, preview, server.title),
        confirmLabel: t('cap.importConfirmLabel')
      }),
    [confirm, server.title, t]
  )

  const flow = useMemo(
    () =>
      createMcpImportFlow({
        prepare: (serverId) => window.yan.capabilities.prepareNativeImport(serverId),
        commit: (token) => window.yan.capabilities.commitNativeImport(token),
        currentScope,
        requestConfirm,
        isRunning: () => {
          const state = useStore.getState()
          return state.runners.some(runner => runner.running) || !!state.session?.isAgentRunning || !!state.session?.isStreaming || !!state.session?.isCompacting
        }
      }),
    [currentScope, requestConfirm]
  )

  const start = useCallback(async (): Promise<void> => {
    if (pending || flow.busy) return
    setPending(true)
    setOutcome(null)
    const result = await flow.run(server.id)
    if (!mountedRef.current) return
    setOutcome(result)
    setPending(false)
    if (result.phase === 'committed') {
      try {
        await onChanged()
      } catch {
      }
    }
  }, [flow, onChanged, pending, server.id])

  if (server.migratedToNative) {
    const mark = server.migratedToNative
    const scope = migratedTargetScope(mark.targetPath)
    return (
      <div className="mcp-import-block" data-testid="cap-mcp-migrated">
        <div className="pkg-item-main">
          <span className="pkg-scope user">{t('cap.importMigratedBadge')}</span>
          <span className="pkg-spacer" />
        </div>
        <div className="pkg-detail-line">{t('cap.importMigratedName', { name: mark.nativeName ?? server.id })}</div>
        {scope ? <div className="pkg-detail-line pkg-dim">{scopeLabel(t, scope)}</div> : null}
        <div className="pkg-detail-line pkg-dim">{t('cap.importMigratedPath', { path: mark.targetPath })}</div>
        <div className="pkg-detail-line pkg-dim">{t('cap.importMigratedAt', { at: mark.at })}</div>
        <div className="pkg-detail-warn">{t('cap.importMigratedNotice')}</div>
        <McpImportOutcome outcome={outcome} />
      </div>
    )
  }

  if (server.id === WINDOWS_MCP_SERVER_ID || !server.enabled) return null

  const busy = pending || flow.busy
  return (
    <div className="mcp-import-block" data-testid="cap-mcp-import">
      <div className="pkg-item-main">
        <span className="pkg-spacer" />
        <Button
          size="sm"
          disabled={busy || running}
          data-testid="cap-mcp-import-btn"
          onClick={() => void start()}
        >
          {busy ? t('cap.importing') : t('cap.importAction')}
        </Button>
      </div>
      {running ? <div className="pkg-detail-warn">{t('cap.importBusy')}</div> : null}
      <McpImportOutcome outcome={outcome} />
    </div>
  )
}

function McpImportOutcome({ outcome }: { outcome: McpImportFlowOutcome | null }): React.JSX.Element | null {
  const t = useT()
  if (!outcome) return null
  if (outcome.phase === 'busy') return <div className="pkg-detail-warn" role="status">{t('cap.importBusy')}</div>
  if (outcome.phase === 'cancelled') {
    return <div className="pkg-detail-line pkg-dim" role="status">{t('cap.importCancelled')}</div>
  }
  if (outcome.phase === 'scope-changed') {
    return <div className="pkg-detail-warn" role="status">{t('cap.importScopeChanged')}</div>
  }
  if (outcome.phase === 'failed') {
    const manual = MANUAL_CODES.has(outcome.code)
    return (
      <div className="mcp-import-outcome" role="status" data-testid="cap-mcp-import-failed">
        <div className="pkg-detail-warn">{t('cap.importFailed')} · {t('cap.importCode', { code: outcome.code })}</div>
        {outcome.error ? <div className="pkg-detail-warn">{outcome.error}</div> : null}
        {manual ? <div className="pkg-detail-warn">{t('cap.importManualHint')}</div> : null}
        <div className="pkg-detail-line pkg-dim">{t('cap.importPreservedNotice')}</div>
      </div>
    )
  }
  return <McpImportSteps projection={outcome.projection} />
}

function McpImportSteps({ projection }: { projection: McpImportCommitProjection }): React.JSX.Element {
  const t = useT()
  const stateText = (state: string): string => t(STEP_STATE_KEY[state] ?? 'cap.importState.skipped')
  return (
    <div className="mcp-import-outcome" role="status" data-testid="cap-mcp-import-result">
      <div className="pkg-detail-line">{t('cap.importResultTitle')}</div>
      <div className="pkg-detail-line">
        {t('cap.importStep.nativeWrite')}: {stateText(projection.steps.nativeWrite)}
      </div>
      <div className="pkg-detail-line">
        {t('cap.importStep.verify')}: {stateText(projection.steps.verify)}
      </div>
      <div className="pkg-detail-line">
        {t('cap.importStep.hostDisable')}: {stateText(projection.steps.hostDisable)}
      </div>
      {projection.ok ? <div className="pkg-detail-line">{t('cap.importSuccess')}</div> : null}
      {!projection.deactivated ? (
        <div className="pkg-detail-line pkg-dim">{t('cap.importPreservedNotice')}</div>
      ) : null}
      {projection.notice ? <div className="pkg-detail-warn">{projection.notice}</div> : null}
      {projection.warnings.map((warning) => (
        <div className="pkg-detail-warn" key={warning}>{warning}</div>
      ))}
      <div className="pkg-detail-warn">{t('cap.importRunnerNotice')}</div>
    </div>
  )
}
