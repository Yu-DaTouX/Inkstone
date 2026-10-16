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

/** A bounded child transcript uses the same turns as chat, without main-session actions. */
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

/**
 * 发给子代理的原文（brief + 任务）。
 *
 * 为什么放在过程窗口顶部：回看一次运行时，只看到模型的回复无法判断它被交代了什么；
 * 「跑偏了没有」这事必须对着任务原文看。运行中会持续重渲染，所以展开状态用本地
 * state 控制，不交给 `<details>` 的默认值（否则用户收起后会被下一次推送重新展开）。
 */
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
