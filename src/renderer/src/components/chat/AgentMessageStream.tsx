import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SubagentRun } from '../../../../shared/ipc'
import { groupIntoTurns } from '../../../../shared/turns'
import { TurnView } from './TurnView'
import { Badge, Button } from '../ui'
import { subagentOutcome } from '../../../../shared/subagent-outcome'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'

/** A bounded child transcript uses the same turns as chat, without main-session actions. */
export function AgentMessageStream({ run }: { run: SubagentRun }) {
  const t = useT(), outcome = subagentOutcome(run)
  const stop = useStore(s => s.stopSubagent), merge = useStore(s => s.mergeSubagent), discard = useStore(s => s.discardSubagent)
  const [promptOpen, setPromptOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), follow = useRef(true)
  const turns = useMemo(() => groupIntoTurns(run.transcript.filter(m => m.role !== 'user' || m.text !== run.task).map(m => ({ ...m, sourceCwd: m.sourceCwd ?? run.cwd }))), [run.transcript, run.task, run.cwd])
  useLayoutEffect(() => { if (follow.current && root.current) root.current.scrollTop = root.current.scrollHeight }, [turns])
  return <>
    <div className="agent-message-caption"><Badge>{t(`sa.state.${outcome.key}` as MessageKey)}</Badge><Button size="sm" variant="ghost" onClick={() => setPromptOpen(v => !v)} aria-expanded={promptOpen}>任务原文</Button>
      {outcome.live ? <Button size="sm" variant="danger" onClick={() => void stop(run.id)}>停止</Button> : null}
      {run.diff?.patchPath ? <Button size="sm" onClick={() => void window.yan.openPath(run.diff!.patchPath!)}>查看补丁</Button> : null}
      {run.review === 'pending' || run.review === 'conflict' ? <><Button size="sm" onClick={() => void merge(run.id)}>采用改动</Button><Button size="sm" variant="danger" onClick={() => void discard(run.id)}>放弃改动</Button></> : null}
    </div>
    <div className="agent-message-stream" ref={root} onScroll={() => { const el = root.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      <div className="stream-inner">
        {promptOpen ? <div className="bubble"><span className="bubble-text">{run.task}</span></div> : null}
        {turns.map(turn => <TurnView key={turn.id} turn={turn} streaming={outcome.live && turn === turns.at(-1) && turn.kind === 'assistant'} readOnly />)}
        {!turns.length ? <p>{outcome.live ? '等待 Agent 消息…' : '没有可显示的消息。'}</p> : null}
      </div>
    </div>
  </>
}
