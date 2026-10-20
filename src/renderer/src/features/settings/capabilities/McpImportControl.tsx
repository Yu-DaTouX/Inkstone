import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { CapabilityMcpServerSettingView } from '../../../../../shared/ipc'
import type {
  NativeMcpImportCommitResult,
  NativeMcpImportPreview
} from '../../../../../shared/mcp-native-import'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { useConfirm } from './confirm'
import { formatImportPreviewDetail, type ImportPreviewLabels } from './native-preview'
import { ItemHead, Meta, Warn } from './parts'

const MANUAL_CODES = new Set([
  'needs_reauth',
  'needs_auth',
  'needs-auth',
  'unsupported',
  'not_trusted',
  'unavailable'
])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
}

export function McpImportControl({
  server,
  onChanged
}: {
  server: CapabilityMcpServerSettingView
  onChanged: () => Promise<void>
}): ReactElement {
  const t = useT()
  const text = useCapsText()
  const confirm = useConfirm()
  const running = useStore(
    (s) =>
      s.runners.some((runner) => runner.running) ||
      !!s.session?.isAgentRunning ||
      !!s.session?.isStreaming ||
      !!s.session?.isCompacting
  )
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<
    | { phase: 'cancelled' }
    | { phase: 'scope-changed' }
    | { phase: 'failed'; code: string; error?: string; manual: boolean }
    | { phase: 'done'; result: NativeMcpImportCommitResult }
    | null
  >(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const captureScope = (): { activeRunnerId: string | null; sessionId: string; projectKey: string } => {
    const state = useStore.getState()
    const runner = state.runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
    return {
      activeRunnerId: state.activeRunnerId,
      sessionId: state.session?.sessionId ?? '',
      projectKey: runner?.projectId ?? state.session?.cwd ?? state.settings?.cwd ?? ''
    }
  }

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    const before = captureScope()
    try {
      const prepared = await window.yan.capabilities.prepareNativeImport(server.id)
      if (!prepared.ok || !prepared.preview) {
        setOutcome({
          phase: 'failed',
          code: prepared.code ?? 'prepare_failed',
          error: prepared.error,
          manual: MANUAL_CODES.has(prepared.code ?? '')
        })
        return
      }
      const preview: NativeMcpImportPreview = prepared.preview
      const labels: ImportPreviewLabels = {
        sourceTitle: t('cap.importSourceTitle'),
        nativeName: t('cap.importNativeName'),
        scope: preview.scope === 'project' ? t('cap.importScope.project') : t('cap.importScope.global'),
        targetPath: t('cap.importTargetPath'),
        entry: t('cap.importEntry'),
        warnings: t('cap.importWarnings'),
        description: text('importFieldDescription'),
        transport: text('importFieldTransport'),
        command: text('importFieldCommand'),
        args: text('importFieldArgs'),
        envKeys: text('importFieldEnvKeys'),
        url: text('importFieldUrl')
      }
      const accepted = await confirm({
        title: t('cap.importConfirmTitle', { name: server.title }),
        body: `${t('cap.importConfirmBody')}\n${t('cap.importConfirmLocalWarning')}`,
        detail: formatImportPreviewDetail(preview, server.title, labels),
        confirmLabel: t('cap.importConfirmLabel')
      })
      if (!accepted) {
        if (mounted.current) setOutcome({ phase: 'cancelled' })
        return
      }
      const after = captureScope()
      if (
        after.activeRunnerId !== before.activeRunnerId ||
        after.sessionId !== before.sessionId ||
        after.projectKey !== before.projectKey
      ) {
        setOutcome({ phase: 'scope-changed' })
        return
      }
      const committed = await window.yan.capabilities.commitNativeImport(preview.token)
      if (committed.ok && committed.result) {
        if (mounted.current) setOutcome({ phase: 'done', result: committed.result })
      } else {
        setOutcome({
          phase: 'failed',
          code: committed.code ?? 'commit_failed',
          error: committed.error,
          manual: MANUAL_CODES.has(committed.code ?? '')
        })
      }
      try {
        await onChanged()
      } catch {
      }
    } catch (cause) {
      if (mounted.current) setOutcome({ phase: 'failed', code: 'exception', error: errorText(cause), manual: false })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const blocked = running

  return (
    <div className="caps-import" data-testid="caps-mcp-import">
      <ItemHead>
        <span className="caps-spacer" />
        <Button
          variant="secondary"
          isDisabled={busy || blocked}
          onPress={() => void start()}
          data-testid="caps-mcp-import-btn"
        >
          {busy ? t('cap.importing') : t('cap.importAction')}
        </Button>
      </ItemHead>
      {blocked ? <Meta>{text('mcpRunningBlock')}</Meta> : null}
      <McpImportOutcome outcome={outcome} />
    </div>
  )
}

function McpImportOutcome({
  outcome
}: {
  outcome:
    | { phase: 'cancelled' }
    | { phase: 'scope-changed' }
    | { phase: 'failed'; code: string; error?: string; manual: boolean }
    | { phase: 'done'; result: NativeMcpImportCommitResult }
    | null
}): ReactElement | null {
  const t = useT()
  if (!outcome) return null
  if (outcome.phase === 'cancelled') {
    return (
      <Meta>
        <span role="status">{t('cap.importCancelled')}</span>
      </Meta>
    )
  }
  if (outcome.phase === 'scope-changed') {
    return <Warn>{t('cap.importScopeChanged')}</Warn>
  }
  if (outcome.phase === 'failed') {
    return (
      <div className="caps-result" role="status" data-testid="caps-mcp-import-failed">
        <Warn>
          {t('cap.importFailed')} · {t('cap.importCode', { code: outcome.code })}
        </Warn>
        {outcome.error ? <Meta>{outcome.error}</Meta> : null}
        {outcome.manual ? <Meta>{t('cap.importManualHint')}</Meta> : null}
        <Meta>{t('cap.importPreservedNotice')}</Meta>
      </div>
    )
  }
  const { result } = outcome
  return (
    <div className="caps-result" role="status" data-testid="caps-mcp-import-result">
      <Meta>{t('cap.importResultTitle')}</Meta>
      <Meta>
        {t('cap.importStep.nativeWrite')}: {t(`cap.importState.${result.steps.nativeWrite}` as 'cap.importState.written')}
      </Meta>
      <Meta>
        {t('cap.importStep.verify')}: {t(`cap.importState.${result.steps.verify}` as 'cap.importState.passed')}
      </Meta>
      <Meta>
        {t('cap.importStep.hostDisable')}: {t(`cap.importState.${result.steps.hostDisable}` as 'cap.importState.disabled')}
      </Meta>
      {result.ok ? <Meta>{t('cap.importSuccess')}</Meta> : null}
      {!result.deactivated ? <Meta>{t('cap.importPreservedNotice')}</Meta> : null}
      {result.notice ? <Meta>{result.notice}</Meta> : null}
      {result.warnings.map((warning) => (
        <Meta key={warning}>{warning}</Meta>
      ))}
      <Meta>{t('cap.importRunnerNotice')}</Meta>
    </div>
  )
}
