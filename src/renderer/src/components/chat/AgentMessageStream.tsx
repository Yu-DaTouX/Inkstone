import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SubagentRun } from '../../../../shared/ipc'
import { groupIntoTurns } from '../../../../shared/turns'
import { TurnView } from './TurnView'
import { Markdown } from './MessageParts'
import { Badge, Button } from '../ui'
import { Icon } from '../../icons/Icon'
import { subagentOutcome } from '../../../../shared/subagent-outcome'
import { briefPrompt } from '../../../../shared/subagent-brief'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { resolveSubagentModelDisplay } from './turn-model-display'

export function AgentMessageStream({ run }: { run: SubagentRun }) {
  const t = useT(), outcome = subagentOutcome(run)
  const stop = useStore(s => s.stopSubagent), merge = useStore(s => s.mergeSubagent), discard = useStore(s => s.discardSubagent)
  const models = useStore(s => s.models)
  const favorites = useStore(s => s.settings?.modelFavorites)
  const modelDisplay = run.model ? resolveSubagentModelDisplay(run.model, models, favorites ?? []) : null
  const root = useRef<HTMLDivElement>(null), follow = useRef(true)
  const turns = useMemo(() => {
    const prompt = run.brief ? briefPrompt(run.brief, run.task) : run.task
    return groupIntoTurns(run.transcript.filter(m => m.role !== 'user' || (m.text !== run.task && m.text !== prompt)).map(m => ({ ...m, sourceCwd: m.sourceCwd ?? run.cwd })))
  }, [run.transcript, run.task, run.brief, run.cwd])
  useLayoutEffect(() => { if (follow.current && root.current) root.current.scrollTop = root.current.scrollHeight }, [turns])
  return <>
    <div className="agent-message-caption"><Badge>{t(`sa.state.${outcome.key}` as MessageKey)}</Badge>
      {modelDisplay ? <span className="ui-row-desc" title={modelDisplay.identity} data-testid="subagent-stream-model">{modelDisplay.label}</span> : null}
      {outcome.live ? <Button size="sm" variant="danger" onClick={() => void stop(run.id)}>{t('sa.stop')}</Button> : null}
      {run.diff?.patchPath ? <Button size="sm" onClick={() => void window.yan.openPath(run.diff!.patchPath!)}>{t('sa.viewPatch')}</Button> : null}
      {run.review === 'pending' || run.review === 'conflict' ? <><Button size="sm" onClick={() => void merge(run.id)}>{t('sa.adopt')}</Button><Button size="sm" variant="danger" onClick={() => void discard(run.id)}>{t('sa.discardChanges')}</Button></> : null}
    </div>
    <div className="agent-message-stream" ref={root} onScroll={() => { const el = root.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      <div className="stream-inner">
        <SubagentPrompt run={run} />
        {turns.map(turn => <TurnView key={turn.id} turn={turn} streaming={outcome.live && turn === turns.at(-1) && turn.kind === 'assistant'} readOnly />)}
        {!turns.length ? <p>{outcome.live ? t('sa.waitingMessages') : t('sa.noMessages')}</p> : null}
      </div>
    </div>
  </>
}

function SubagentPrompt({ run }: { run: SubagentRun }) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const prompt = (run.brief ? briefPrompt(run.brief, run.task) : run.task) ?? ''
  if (!prompt.trim()) return null
  return (
    <details className="ui-disclosure agent-prompt" open={open} data-testid={`subagent-prompt-${run.id}`}>
      <summary onClick={(e) => { e.preventDefault(); setOpen(v => !v) }}>
        <Icon name="chevron-right" size={12} className="chev" />
        {t('sa.prompt')}
        <span>{t('sa.promptChars', { n: [...prompt].length })}</span>
      </summary>
      <div className="ui-disclosure-body"><Markdown text={prompt} sourceCwd={run.cwd} /></div>
    </details>
  )
}
