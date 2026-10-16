/**
 * 回复末尾的「更改」卡：这一轮改了哪些文件、各自加减多少行。
 *
 * 数据只来自这一轮工具调用记录的执行前后快照，不读盘、不跑 git。「查看变更」打开右侧
 * 工作区的「改动」页签；「撤销」复用既有的回退对话框，只在这轮的用户消息能对上
 * 属于当前会话的检查点时出现，回退范围由对话框自己确认，这里不直接改文件。
 */
import { useState, type JSX } from 'react'
import { ChevronDown, ChevronUp, FilePen, Undo2 } from 'lucide-react'
import { Button } from '../../ui'
import { useI18n, type Lang } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import type { AssistantTurn } from '../../../../shared/turns'
import { collectTurnChanges, splitChangePath, type TurnFileStatus } from './turn-changes'
import './turn-changes.css'

/** 默认先露出几个文件，其余折叠在「再显示」后面 */
const VISIBLE_FILES = 3

interface ChangesText {
  /** 标题：按状态分别计数，只列出有的类别 */
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
  view: '查看变更',
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

/** 这一轮之前最近的一条用户消息（回退检查点按它的文本指纹认） */
function promptBefore(sourceIds: readonly string[]): { text: string; timestamp?: number } | null {
  const messages = useStore.getState().messages
  const first = messages.findIndex((m) => m.id === sourceIds[0])
  for (let i = (first < 0 ? messages.length : first) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && m.text) return { text: m.text, timestamp: m.timestamp }
  }
  return null
}

export function TurnChanges({ turn, readOnly, rewindOwner }: { turn: AssistantTurn; readOnly: boolean; rewindOwner: string | null }): JSX.Element | null {
  const { lang } = useI18n()
  const checkpoints = useStore((s) => s.checkpoints)
  const openRewind = useStore((s) => s.openRewind)
  const [expanded, setExpanded] = useState(false)
  const changes = collectTurnChanges(turn.tools)
  if (!changes) return null

  const text = changesText(lang)
  const cwd = turn.response?.sourceCwd
  const prompt = !readOnly && rewindOwner ? promptBefore(turn.sourceIds) : null
  const checkpoint = prompt ? matchCheckpoint(checkpoints.filter((r) => r.sessionKey === rewindOwner), prompt.text, prompt.timestamp) : null
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
