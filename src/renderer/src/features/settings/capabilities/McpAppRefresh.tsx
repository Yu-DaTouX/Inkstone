/**
 * MCP App 工具快照的缓存状态与**显式刷新**（A6-frame-ui）。
 *
 * 规则（并入 DESIGN_SYSTEM v3「v3 MCP App 视图」）：
 *   · 这里是唯一的手动刷新入口：显示宿主当前缓存的工具数、是否需要刷新；
 *   · 刷新只重读宿主工具快照，**不自动重启会话、不重连服务、不执行任何工具**；
 *   · 工具 schema 变化要新会话或重载运行实例才生效，界面必须如实说明；
 *   · 不与 MA3 归属组件合并：归属开关只负责托管权，刷新只负责快照。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { Button } from '../../../ui'
import type { McpAppViewApi } from '../../../../../shared/mcp-app-view'
import { Group, Meta, Warn } from './parts'

interface RefreshLabels {
  title: string
  desc: string
  toolCount: string
  needsRefresh: string
  upToDate: string
  refresh: string
  refreshing: string
  done: string
  failed: string
  schemaNote: string
  unavailable: string
}

const ZH: RefreshLabels = {
  title: 'App 工具快照',
  desc: '砚宿主缓存的 MCP 工具表；App 视图只读这份快照，不会因此启动服务或执行工具。',
  toolCount: '已缓存 {n} 个工具',
  needsRefresh: '需要刷新',
  upToDate: '已是最新',
  refresh: '刷新工具快照',
  refreshing: '刷新中…',
  done: '快照已刷新：{n} 个工具',
  failed: '刷新失败',
  schemaNote: '工具 schema 变化要在新会话或重载运行实例后生效；这里不会自动重启。',
  unavailable: 'MCP App 宿主尚未接线，暂不可用。'
}

const EN: RefreshLabels = {
  title: 'App tool snapshot',
  desc: 'The MCP tool table cached by the Inkstone host; app views only read this snapshot and never start servers or run tools.',
  toolCount: '{n} tools cached',
  needsRefresh: 'Needs refresh',
  upToDate: 'Up to date',
  refresh: 'Refresh tool snapshot',
  refreshing: 'Refreshing…',
  done: 'Snapshot refreshed: {n} tools',
  failed: 'Refresh failed',
  schemaNote: 'Tool schema changes take effect in a new session or after reloading the runtime; nothing restarts automatically.',
  unavailable: 'The MCP App host is not wired yet; not available.'
}

function withCount(template: string, n: number): string {
  return template.split('{n}').join(String(n))
}

function readApi(): McpAppViewApi | null {
  const yan = (window as unknown as { yan?: { mcpApps?: McpAppViewApi } }).yan
  return yan?.mcpApps ?? null
}

export function McpAppRefresh(): ReactElement {
  const { lang } = useI18n()
  const labels = lang === 'en-US' ? EN : ZH
  const api = useRef<McpAppViewApi | null>(null)
  const mounted = useRef(true)
  const [toolCount, setToolCount] = useState<number | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    api.current = readApi()
    mounted.current = true
    const bridge = api.current
    if (!bridge) return () => { mounted.current = false }
    void bridge.snapshot().then(
      (snapshot) => {
        if (!mounted.current) return
        setToolCount(snapshot.toolCount)
        setNeedsRefresh(snapshot.needsRefresh)
      },
      () => {
        if (mounted.current) setError(labels.unavailable)
      }
    )
    return () => {
      mounted.current = false
    }
  }, [labels.unavailable])

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = api.current
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const result = await bridge.refresh()
      if (!mounted.current) return
      if (result.ok) {
        setToolCount(result.toolCount)
        setNeedsRefresh(false)
        setDone(withCount(labels.done, result.toolCount))
      } else {
        setError(result.error || labels.failed)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : labels.failed)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [busy, labels.done, labels.failed])

  if (!api.current) {
    return (
      <Group title={labels.title} desc={labels.desc}>
        <Warn>{labels.unavailable}</Warn>
      </Group>
    )
  }

  return (
    <Group title={labels.title} desc={labels.desc}>
      <Meta>
        <span data-testid="v3-mcp-app-refresh-count">
          {toolCount === null ? labels.upToDate : withCount(labels.toolCount, toolCount)}
        </span>
        {needsRefresh ? <span data-testid="v3-mcp-app-refresh-needed">{` · ${labels.needsRefresh}`}</span> : null}
      </Meta>
      <div className="caps-actions caps-actions--start">
        <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void refresh()} data-testid="v3-mcp-app-refresh">
          {busy ? labels.refreshing : labels.refresh}
        </Button>
      </div>
      {done ? <p className="caps-result" role="status" data-testid="v3-mcp-app-refresh-done">{done}</p> : null}
      {error ? <Warn>{error}</Warn> : null}
      <Meta>{labels.schemaNote}</Meta>
    </Group>
  )
}
