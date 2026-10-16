/**
 * MCP 服务归属双向切换（v3 设置 · 能力 · 连接）。
 *
 * ── 交互规则（需并入设计规范）──
 *   1. 必须两次用户动作：先点「预览切换」，读完确认框内容后再点「确认切换」。
 *      预览只读配置、不改真实 pi 配置，也绝不自动提交。
 *   2. 有已加载运行实例可能仍持有该服务、或缺少 appHost 回退记录时禁用按钮，
 *      并在行内解释原因（首版不自动重启会话）。
 *   3. 走受控 IPC（`yan:mcpApp:*`，主窗口校验）；组件只持有一次性 token 并原样
 *      回传，不接收完整配置 / 原始条目，也不把 token 或配置写进日志 / 模型上下文。
 *   4. 切换方向由主进程按当前归属判定，渲染端不能指定；托管与交回都不会「再开一条连接」。
 *   5. 结果按 steps + remediation 如实展示；部分失败不隐藏、不自动重试。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import type {
  McpAppBridge,
  McpAppOwnershipView,
  McpAppSwitchCommitResult
} from '../../../../../shared/mcp-app-switch'
import { Button } from '../../../ui'
import { useConfirm } from './confirm'
import {
  formatMcpAppSwitchPreview,
  formatMcpAppSwitchResult,
  mcpAppSwitchLabels,
  parseMcpAppOwnershipResponse
} from './mcp-app-ownership'
import { Empty, Group, Item, ItemHead, ListSkeleton, Meta, Note, StatusBadge, Warn } from './parts'

/**
 * 桥接取用：`shared/ipc.ts` 的正式接线由整合补丁加入。
 * 这里用结构化类型读取，未接线时给出明确错误而不是崩在 `undefined`。
 */
function bridge(): McpAppBridge | null {
  const yan = (window as unknown as { yan?: { mcpApp?: McpAppBridge } }).yan
  return yan?.mcpApp ?? null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
}

type Outcome =
  | { phase: 'cancelled' }
  | { phase: 'scope-changed' }
  | { phase: 'blocked'; reason: string }
  | { phase: 'failed'; code: string; error: string }
  | { phase: 'done'; result: McpAppSwitchCommitResult }
  | null

export function McpAppOwnership(): ReactElement {
  const { lang } = useI18n()
  const labels = mcpAppSwitchLabels(lang)
  const [views, setViews] = useState<McpAppOwnershipView[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (!api) {
      if (mounted.current) {
        setError(labels.loadFailed)
        setLoading(false)
      }
      return
    }
    try {
      /* 响应是 `{ servers, error? }` 对象：解包失败不得当成空列表。 */
      const parsed = parseMcpAppOwnershipResponse(await api.ownership())
      if (!mounted.current) return
      if (!parsed.ok) {
        setViews(null)
        setError(parsed.error)
        return
      }
      setViews(parsed.views)
      setError(null)
    } catch (cause) {
      if (mounted.current) {
        setViews(null)
        setError(errorText(cause))
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [labels.loadFailed])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  return (
    <Group title={labels.groupTitle} desc={labels.groupDesc}>
      <Note>{labels.note}</Note>
      {error ? <Warn>{`${labels.loadFailed}: ${error}`}</Warn> : null}
      {loading && !views && !error ? <ListSkeleton rows={2} /> : null}
      {!error && views && views.length === 0 ? <Empty>{labels.empty}</Empty> : null}
      {views && views.length > 0 ? (
        <div className="caps-list" data-testid="caps-mcp-app-ownership">
          {views.map((view) => (
            <OwnershipRow key={view.serverId} view={view} onChanged={refresh} />
          ))}
        </div>
      ) : null}
    </Group>
  )
}

function OwnershipRow({
  view,
  onChanged
}: {
  view: McpAppOwnershipView
  onChanged: () => Promise<void>
}): ReactElement {
  const { lang } = useI18n()
  const labels = mcpAppSwitchLabels(lang)
  const confirm = useConfirm()
  const busySession = useStore(
    (s) =>
      s.runners.some((runner) => runner.running) ||
      !!s.session?.isAgentRunning ||
      !!s.session?.isStreaming ||
      !!s.session?.isCompacting
  )
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
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

  const run = async (): Promise<void> => {
    if (busy || !view.canSwitch) return
    const api = bridge()
    if (!api) {
      setOutcome({ phase: 'failed', code: 'bridge_unavailable', error: labels.loadFailed })
      return
    }
    setBusy(true)
    setOutcome(null)
    const before = captureScope()
    try {
      const prepared = await api.prepareSwitch(view.serverId)
      if (!prepared.ok || !prepared.preview) {
        setOutcome({
          phase: 'failed',
          code: prepared.code ?? 'prepare_failed',
          error: prepared.error ?? labels.failed
        })
        return
      }
      const preview = prepared.preview
      if (preview.blocked) {
        if (mounted.current) setOutcome({ phase: 'blocked', reason: preview.blockedReason ?? labels.blocked })
        return
      }
      const accepted = await confirm({
        title: labels.switchConfirmTitle,
        body: `${labels.switchConfirmBody}\n${labels.note}`,
        detail: formatMcpAppSwitchPreview(preview, labels, view.title),
        confirmLabel: labels.switchConfirmLabel,
        tone: 'danger'
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
      const committed = await api.commitSwitch(preview.token)
      if (committed.ok && committed.result) {
        if (mounted.current) setOutcome({ phase: 'done', result: committed.result })
      } else {
        setOutcome({
          phase: 'failed',
          code: committed.code ?? 'commit_failed',
          error: committed.error ?? labels.failed
        })
      }
      try {
        await onChanged()
      } catch {
        /* 刷新失败不改写已发生的写盘事实 */
      }
    } catch (cause) {
      if (mounted.current) setOutcome({ phase: 'failed', code: 'exception', error: errorText(cause) })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const disabled = busy || !view.canSwitch || busySession
  const reason = view.unsupportedReason ?? view.blockedReason

  return (
    <Item testId="caps-mcp-app-owner">
      <ItemHead>
        <span className="caps-name" title={view.title}>
          {view.title}
        </span>
        <StatusBadge tone={view.managed ? 'accent' : 'neutral'}>
          {view.managed ? labels.managed : labels.piNative}
        </StatusBadge>
        <span className="caps-tag">
          {view.scope === 'project' ? labels.scopeProject : labels.scopeGlobal}
        </span>
        <span className="caps-tag">{`${labels.nativeName}: ${view.nativeName}`}</span>
        <span className="caps-spacer" />
        <Button
          size="sm"
          variant="secondary"
          isDisabled={disabled}
          isPending={busy}
          onPress={() => void run()}
          data-testid="caps-mcp-app-switch"
        >
          {busy ? labels.previewing : view.managed ? labels.switchToPi : labels.switchToInkstone}
        </Button>
      </ItemHead>
      {view.holders.length > 0 ? <Meta>{labels.holders(view.holders.length)}</Meta> : null}
      {reason ? <Warn>{reason}</Warn> : null}
      <OwnershipOutcome outcome={outcome} labels={labels} />
    </Item>
  )
}

function OwnershipOutcome({
  outcome,
  labels
}: {
  outcome: Outcome
  labels: ReturnType<typeof mcpAppSwitchLabels>
}): ReactElement | null {
  if (!outcome) return null
  if (outcome.phase === 'cancelled') {
    return <Meta>{labels.previewTitle} · cancelled</Meta>
  }
  if (outcome.phase === 'scope-changed') {
    return <Warn>{labels.scopeChanged}</Warn>
  }
  if (outcome.phase === 'blocked') {
    return <Warn>{outcome.reason}</Warn>
  }
  if (outcome.phase === 'failed') {
    return (
      <div className="caps-result" role="status" data-testid="caps-mcp-app-switch-failed">
        <Warn>{`${labels.failed} · ${outcome.code}`}</Warn>
        <Meta>{outcome.error}</Meta>
      </div>
    )
  }
  return (
    <div className="caps-result" role="status" data-testid="caps-mcp-app-switch-result">
      <Meta>{labels.resultTitle}</Meta>
      {formatMcpAppSwitchResult(outcome.result, labels).map((line) => (
        <Meta key={line}>{line}</Meta>
      ))}
      {outcome.result.warnings.map((warning) => (
        <Meta key={warning}>{warning}</Meta>
      ))}
      <Meta>{outcome.result.notice}</Meta>
    </div>
  )
}
