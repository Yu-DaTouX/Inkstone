import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { Button, IconButton, ShimmerText, Splitter } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { findSubagentSnapshot } from './turn-lines'
import { SubagentReview } from './SubagentReview'
import { discardSubagentResult, mergeSubagentResult } from './subagent-review'
import { openSubagentPane, useSubagentView } from './SubagentLine'
import { SUBAGENT_LANE_EDGE, SUBAGENT_PANEL_EDGE, SUBAGENT_PANEL_WIDTH, subagentPanelShownWidth, useSubagentPanel } from './subagent-panel-state'
import { sessionViewIdentity, viewMatchesProjectedSession } from './view-state'
import { useSessionText } from './text'
import { Icon } from './Icon'
import { SubagentBot } from './SubagentBot'
import { Markdown } from './Markdown'
import type { SubagentRun } from '../../../../shared/ipc'

const RETRYABLE = new Set(['failed', 'timeout', 'budget', 'stopped'])

export function SubagentPanel({ ownerKey, viewActive, edge = SUBAGENT_PANEL_EDGE }: { ownerKey: string; viewActive: boolean; edge?: number }): JSX.Element | null {
  const runId = useSubagentPanel((s) => (s.owner === ownerKey ? s.runId : null))
  const run = useStore((s) => (runId ? s.subagents.find((item) => item.id === runId) : undefined))

  const owner = useSubagentPanel((s) => s.owner)
  useEffect(() => {
    if (owner && owner !== ownerKey) useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
  }, [owner, ownerKey])
  useEffect(() => {
    if (runId && !run) useSubagentPanel.getState().close()
  }, [runId, run])

  if (!runId || !run) return null
  return <PanelBody key={run.id} run={run} viewActive={viewActive} edge={edge} />
}

export function ChatSubagentPanel(): JSX.Element | null {
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const view = useMemo(
    () => sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [peekedSessionId, peekedPath, session]
  )
  return <SubagentPanel ownerKey={view.key} viewActive={viewMatchesProjectedSession(view, session)} edge={SUBAGENT_LANE_EDGE} />
}

function PanelBody({ run, viewActive, edge }: { run: SubagentRun; viewActive: boolean; edge: number }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const tt = useSessionText()
  const runs = useRunsV3((s) => s.runs)
  const snapshot = findSubagentSnapshot(runs, run.id)
  const { model, status, dotClass } = useSubagentView(run, snapshot)
  const rootRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState<'stop' | 'retry' | null>(null)
  const width = useSubagentPanel((s) => s.width)
  const setWidth = useSubagentPanel((s) => s.setWidth)
  const [available, setAvailable] = useState(1000)
  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => setAvailable(parent.clientWidth))
    observer.observe(parent)
    setAvailable(parent.clientWidth)
    return () => observer.disconnect()
  }, [])
  const shownWidth = subagentPanelShownWidth(width, available, edge)
  useEffect(() => {
    const parent = rootRef.current?.parentElement
    parent?.style.setProperty('--subagent-width', `${shownWidth}px`)
    return () => { parent?.style.removeProperty('--subagent-width') }
  }, [shownWidth])

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
      <Splitter className="v3-sap-resizer" title={tt('subagentResize')} orientation="vertical" value={available - shownWidth} min={edge} max={Math.max(edge, available - 260)} step={16} aria-label={t('tile.resizeWidth')} onChange={(left) => setWidth(available - left)} onReset={() => setWidth(SUBAGENT_PANEL_WIDTH)} />
      <header className="v3-sap-head">
        <span className="v3-sap-glyph" data-tone={dotClass} aria-hidden>
          <SubagentBot run={run} snapshot={snapshot} model={model} />
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

        {model.error ? (
          <div className="v3-subagent-err v3-sap-block" role="alert" data-testid="v3-subagent-error">
            {model.recovery ? <span data-testid="v3-subagent-recovery">{`${tt(model.recovery.key, 'n' in model.recovery ? { n: model.recovery.n } : undefined)} · `}</span> : null}
            {model.error}
          </div>
        ) : null}

        <SubagentReview run={run} onMerge={mergeSubagentResult} onDiscard={discardSubagentResult} />

        {model.latest && (model.live || !model.summary) ? (
          <section className="v3-sap-card" data-live={model.live ? '1' : undefined}>
            <h4 className="v3-sap-label"><ShimmerText active={model.live}>{tt('subagentLatest')}</ShimmerText></h4>
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
