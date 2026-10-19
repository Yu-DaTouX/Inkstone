import { useMemo, useState, type JSX } from 'react'
import { ChevronDown, ChevronUp, FilePen, Undo2 } from 'lucide-react'
import { Button } from '../../ui'
import { useI18n, type Lang } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import type { UIMessage } from '../../../../shared/ipc'
import type { AssistantTurn } from '../../../../shared/turns'
import { collectTurnChanges, splitChangePath, type TurnFileStatus } from './turn-changes'
import './turn-changes.css'

const VISIBLE_FILES = 3

interface ChangesText {
  summary: (counts: Record<TurnFileStatus, number>) => string
  more: (n: number) => string
  less: string
  view: string
  undo: string
}

const ZH: ChangesText = {
  summary: (c) => [
    c.created ? `新建 ${c.created} 个文件` : '',
    c.modified ? `编辑 ${c.modified} 个文件` : '',
    c.deleted ? `删除 ${c.deleted} 个文件` : ''
  ].filter(Boolean).join(' · '),
  more: (n) => `再显示 ${n} 个文件`,
  less: '收起',
  view: '查看改动',
  undo: '撤销'
}
const EN: ChangesText = {
  summary: (c) => [
    c.created ? `Created ${c.created} ${c.created === 1 ? 'file' : 'files'}` : '',
    c.modified ? `Edited ${c.modified} ${c.modified === 1 ? 'file' : 'files'}` : '',
    c.deleted ? `Deleted ${c.deleted} ${c.deleted === 1 ? 'file' : 'files'}` : ''
  ].filter(Boolean).join(' · '),
  more: (n) => `Show ${n} more`,
  less: 'Show less',
  view: 'View changes',
  undo: 'Undo'
}

function changesText(lang: Lang): ChangesText {
  return lang === 'en-US' ? EN : ZH
}

function promptBefore(messages: readonly UIMessage[], sourceIds: readonly string[]): { text: string; timestamp?: number } | null {
  const first = messages.findIndex((m) => m.id === sourceIds[0])
  for (let i = (first < 0 ? messages.length : first) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && m.text) return { text: m.text, timestamp: m.timestamp }
  }
  return null
}

export function TurnChanges({ turn, readOnly, rewindOwner }: { turn: AssistantTurn; readOnly: boolean; rewindOwner: string | null }): JSX.Element | null {
  const { lang } = useI18n()
  const openRewind = useStore((s) => s.openRewind)
  const sessionCwd = useStore((s) => s.session?.cwd)
  const [expanded, setExpanded] = useState(false)
  const cwd = turn.response?.sourceCwd || sessionCwd || undefined
  const changes = useMemo(() => collectTurnChanges(turn.tools, cwd), [turn.tools, cwd])
  const wantsCheckpoint = !!changes && !readOnly && !!rewindOwner
  const checkpointId = useStore((s) => {
    if (!wantsCheckpoint) return null
    const owned = s.checkpoints.filter((r) => r.sessionKey === rewindOwner)
    if (!owned.length) return null
    const found = promptBefore(s.messages, turn.sourceIds)
    return found ? matchCheckpoint(owned, found.text, found.timestamp)?.id ?? null : null
  })
  if (!changes) return null

  const text = changesText(lang)
  const prompt = checkpointId ? promptBefore(useStore.getState().messages, turn.sourceIds) : null
  const checkpoint = checkpointId ? { id: checkpointId } : null
  const shown = expanded ? changes.files : changes.files.slice(0, VISIBLE_FILES)
  const hidden = changes.files.length - VISIBLE_FILES

  const viewChanges = (): void => {
    const ui = useUiV3.getState()
    ui.setWorkspaceTab('changes')
    ui.setWorkspaceOpen(true)
  }

  return (
    <section className="v3-chg" data-testid="v3-turn-changes" aria-label={text.summary(changes.counts)}>
      <header className="v3-chg-head">
        <span className="v3-chg-icon" aria-hidden><FilePen size={18} /></span>
        <div className="v3-chg-title">
          <strong>{text.summary(changes.counts)}</strong>
          {changes.added >= 0 ? (
            <span className="v3-chg-stats">
              <span className="v3-add">+{changes.added}</span> <span className="v3-del">-{changes.removed}</span>
            </span>
          ) : null}
        </div>
        <div className="v3-chg-actions">
          {checkpoint && prompt ? (
            <Button size="sm" variant="ghost" onPress={() => openRewind(checkpoint.id, prompt.text)} data-testid="v3-turn-changes-undo">
              {text.undo}
              <Undo2 size={13} aria-hidden />
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onPress={viewChanges} data-testid="v3-turn-changes-view">
            {text.view}
          </Button>
        </div>
      </header>
      <ul className="v3-chg-list">
        {shown.map((file) => {
          const { dir, base } = splitChangePath(file.path, cwd)
          return (
            <li key={file.path} className="v3-chg-row" data-testid="v3-turn-changes-row" title={file.path}>
              <span className="v3-chg-path"><span className="v3-chg-dir">{dir}</span>{base}</span>
              {file.added + file.removed > 0 ? (
                <span className="v3-chg-stats"><span className="v3-add">+{file.added}</span> <span className="v3-del">-{file.removed}</span></span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="v3-chg-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} data-testid="v3-turn-changes-more">
          {expanded ? text.less : text.more(hidden)}
          {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
      ) : null}
    </section>
  )
}
