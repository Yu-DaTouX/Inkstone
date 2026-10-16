/**
 * 子 Agent 侧边详情：从对话里点一条子 Agent 行打开，贴在会话区右侧。
 *
 * 第一层只给「它在做什么、现在怎样、结论是什么」；错误与需要处理的审阅放在
 * 结论之前，不能为了整洁藏起来。模型、范围等次要信息放在底部。
 * 动作：在跑时停止；失败 / 超时 / 停止后用同一任务、模型与范围重派一条（砚不自动
 * 重来，由用户决定）；分屏看完整转录是进一步动作。
 *
 * 归属：只在 `owner === 当前视图 key` 时渲染，切会话即不再显示；重派与停止只在
 * 视图就是活动会话时可用，避免把新的子 Agent 挂到别的会话下。
 * 宽会话区与正文并列（对话列让位），窄时作为覆盖抽屉；Esc 关闭并把焦点还给那一行。
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { Button, IconButton, Splitter } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { findSubagentSnapshot } from './turn-lines'
import { SubagentReview } from './SubagentReview'
import { discardSubagentResult, mergeSubagentResult } from './subagent-review'
import { openSubagentPane, useSubagentView } from './SubagentLine'
import { useSubagentPanel } from './subagent-panel-state'
import { useSessionText } from './text'
import { Icon } from './Icon'
import { Busy } from './Busy'
import { Markdown } from './Markdown'
import type { SubagentRun } from '../../../../shared/ipc'

const RETRYABLE = new Set(['failed', 'timeout', 'budget', 'stopped'])

export function SubagentPanel({ ownerKey, viewActive }: { ownerKey: string; viewActive: boolean }): JSX.Element | null {
  const runId = useSubagentPanel((s) => (s.owner === ownerKey ? s.runId : null))
  const run = useStore((s) => (runId ? s.subagents.find((item) => item.id === runId) : undefined))

  /* 换了视图，或这条运行已不在列表（被清理 / 合并后移除）：收起，不留空壳 */
  const owner = useSubagentPanel((s) => s.owner)
  useEffect(() => {
    if (owner && owner !== ownerKey) useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
  }, [owner, ownerKey])
  useEffect(() => {
    if (runId && !run) useSubagentPanel.getState().close()
  }, [runId, run])

  if (!runId || !run) return null
  return <PanelBody key={run.id} run={run} viewActive={viewActive} />
}

function PanelBody({ run, viewActive }: { run: SubagentRun; viewActive: boolean }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const tt = useSessionText()
  const runs = useRunsV3((s) => s.runs)
  const { model, status, dotClass } = useSubagentView(run, findSubagentSnapshot(runs, run.id))
  const rootRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState<'stop' | 'retry' | null>(null)
  const [width, setWidth] = useState(360)
  const [available, setAvailable] = useState(1000)
  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => setAvailable(parent.clientWidth))
    observer.observe(parent)
    setAvailable(parent.clientWidth)
    return () => observer.disconnect()
  }, [])
  const shownWidth = Math.min(width, Math.max(240, available - 48))
  useEffect(() => {
    const parent = rootRef.current?.parentElement
    parent?.style.setProperty('--subagent-width', `${shownWidth}px`)
    return () => { parent?.style.removeProperty('--subagent-width') }
  }, [shownWidth])

  /* 打开时把焦点放进面板（标题），键盘用户能直接读与 Tab 到动作 */
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('.v3-sap-title')?.focus({ preventScroll: true })
  }, [])

  const close = (): void => useSubagentPanel.getState().close()

  const stop = async (): Promise<void> => {
    setBusy('stop')
    try {
      await useStore.getState().stopSubagent(run.id)
    } finally {
      setBusy(null)
    }
  }

  /* 同一任务、模型与范围再派一条；新的那条在对话里出现后从它自己的行打开 */
  const retry = async (): Promise<void> => {
    setBusy('retry')
    try {
      await useStore.getState().startSubagent(run.task, run.model, run.isolation)
      await useStore.getState().loadSubagents()
    } finally {
      setBusy(null)
    }
  }

  const scope = model.isolation === 'controlled-cwd'
    ? tt('subagentScopeReadOnly')
    : model.isolation === 'shared-cwd'
      ? tt('subagentScopeShared')
      : tt('subagentScopeWorktree')
  const canRetry = viewActive && model.terminal && RETRYABLE.has(model.outcomeKey)

  return (
    <aside
      ref={rootRef}
      className="v3-sap"
      role="dialog"
      aria-modal="false"
      aria-label={tt('subagentPanel')}
      data-state={model.outcomeKey}
      data-testid="v3-subagent-panel"
      style={{ width: shownWidth }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        close()
      }}
    >
      <Splitter className="v3-sap-resizer" orientation="vertical" value={available - shownWidth} min={48} max={Math.max(48, available - 260)} step={16} aria-label={t('tile.resizeWidth')} onChange={(left) => setWidth(available - left)} onReset={() => setWidth(360)} />
      <header className="v3-sap-head">
        <span className="v3-sap-glyph" data-tone={dotClass} aria-hidden>
          {model.live ? <Busy /> : <Icon name="layers" size={16} />}
        </span>
        <div className="v3-sap-headtext">
          <span className="v3-sap-pill" data-tone={dotClass}>
            <span className={`v3-dot ${dotClass}`} aria-hidden />
            <span className="v3-sap-status" data-testid="v3-subagent-panel-status">{status}</span>
          </span>
          <span className="v3-sap-sub">
            {tt('subagentKind')}
            {model.code ? <span className="v3-subagent-code">{model.code}</span> : null}
            <span className="v3-sap-time">{formatDuration(model.elapsedMs, { minSeconds: 1 })}</span>
          </span>
        </div>
        <IconButton size="sm" variant="ghost" className="v3-sap-close" aria-label={tt('subagentClose')} onPress={close} data-testid="v3-subagent-panel-close">
          <Icon name="close" size={14} />
        </IconButton>
      </header>

      <div className="v3-sap-scroll">
        <section className="v3-sap-card v3-sap-task">
          <h4 className="v3-sap-label">{lang === 'en-US' ? 'Task' : '任务'}</h4>
          <h3 className="v3-sap-title" tabIndex={-1}>{model.task}</h3>
        </section>

        {model.error ? <div className="v3-subagent-err v3-sap-block" role="alert" data-testid="v3-subagent-error">{model.error}</div> : null}

        <SubagentReview run={run} onMerge={mergeSubagentResult} onDiscard={discardSubagentResult} />

        {model.latest && (model.live || !model.summary) ? (
          <section className="v3-sap-card" data-live={model.live ? '1' : undefined}>
            <h4 className="v3-sap-label">{model.live ? <Busy /> : null}{tt('subagentLatest')}</h4>
            <p className="v3-subagent-latest">{model.latest}</p>
          </section>
        ) : null}

        <section className="v3-sap-card" data-testid="v3-subagent-summary">
          <h4 className="v3-sap-label">{tt('subagentConclusion')}</h4>
          {model.summary
            ? <div className="v3-sap-md" data-testid="v3-subagent-conclusion"><Markdown text={model.summaryTruncated ? `${model.summary}…` : model.summary} /></div>
            : <p className="v3-subagent-text dim">{tt('subagentNoSummary')}</p>}
          {model.summaryTruncated ? <p className="v3-subagent-text dim">{tt('subagentPartial')}</p> : null}
          {model.diff ? (
            <div className="v3-subagent-stat" data-testid="v3-subagent-diff">
              {t('sa.diffStats', { files: model.diff.files, additions: model.diff.additions, deletions: model.diff.deletions })}
            </div>
          ) : null}
        </section>

        {model.sources.length || model.artifacts.length ? (
          <section className="v3-sap-card" data-testid="v3-subagent-result-meta">
            <h4 className="v3-sap-label">{t('sa.resultMeta', { sources: model.sources.length, artifacts: model.artifacts.length })}</h4>
            <PathList label={tt('subagentSources')} items={model.sources} />
            <PathList label={tt('subagentArtifacts')} items={model.artifacts} />
          </section>
        ) : null}

        <dl className="v3-sap-meta">
          {model.model ? (
            <div className="v3-sap-chip">
              <dt>{tt('subagentModel')}</dt>
              <dd title={model.model}>{model.model}</dd>
            </div>
          ) : null}
          <div className="v3-sap-chip">
            <dt>{tt('subagentScope')}</dt>
            <dd>{scope}</dd>
          </div>
        </dl>
      </div>

      <footer className="v3-sap-actions">
        {model.live && viewActive ? (
          <Button size="sm" variant="secondary" isPending={busy === 'stop'} onPress={() => void stop()} data-testid="v3-subagent-stop">
            {t('sa.stop')}
          </Button>
        ) : null}
        {canRetry ? (
          <Button size="sm" variant="secondary" isPending={busy === 'retry'} onPress={() => void retry()} data-testid="v3-subagent-retry">
            {t('sa.retry')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onPress={() => openSubagentPane(run.id)} data-testid="v3-subagent-open">
          {tt('subagentTranscript')}
        </Button>
      </footer>
    </aside>
  )
}

function PathList({ label, items }: { label: string; items: readonly string[] }): JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="v3-sap-paths">
      <span className="v3-sap-paths-label">{label}</span>
      <ul className="v3-sap-paths-list">
        {items.slice(0, 20).map((item) => (
          <li key={item} title={item}>{item}</li>
        ))}
        {items.length > 20 ? <li className="dim">+{items.length - 20}</li> : null}
      </ul>
    </div>
  )
}
