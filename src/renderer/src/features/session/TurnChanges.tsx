import { useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Undo2 } from '../../ui/icons'
import { Button, DiffStat } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n, type Lang } from '../../i18n'
import { useStore } from '../../state/store'
import { openPanelTool } from '../workbench/panel-actions'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import type { UIMessage } from '../../../../shared/ipc'
import type { AssistantTurn } from '../../../../shared/turns'
import { changeRows, type TurnChangeRow, type TurnChanges as TurnChangeSet, type TurnFileStatus } from './turn-changes'
import type { ReplyFileLink } from './turn-outcome'
import './turn-changes.css'

const ROW_LIMIT = 6

interface ChangesText {
  title: string
  summary: (counts: Record<TurnFileStatus, number>) => string
  deliverables: (n: number) => string
  more: (n: number) => string
  view: string
  undo: string
  ignoredAll: string
  ignoredAllHint: string
  ignoredSome: (n: number) => string
}

const ZH: ChangesText = {
  title: '本轮改动',
  summary: (c) => [
    c.created ? `新建 ${c.created} 个文件` : '',
    c.modified ? `编辑 ${c.modified} 个文件` : '',
    c.deleted ? `删除 ${c.deleted} 个文件` : ''
  ].filter(Boolean).join(' · '),
  deliverables: (n) => `${n} 个交付文件`,
  more: (n) => `还有 ${n} 个文件`,
  view: '查看更改',
  undo: '撤销',
  ignoredAll: 'Git 已忽略',
  ignoredAllHint: '这些文件被 Git 忽略，改动面板不列出；点文件名可预览',
  ignoredSome: (n) => `${n} 个文件被 Git 忽略，改动面板不列出`
}
const EN: ChangesText = {
  title: 'Changes this turn',
  summary: (c) => [
    c.created ? `Created ${c.created} ${c.created === 1 ? 'file' : 'files'}` : '',
    c.modified ? `Edited ${c.modified} ${c.modified === 1 ? 'file' : 'files'}` : '',
    c.deleted ? `Deleted ${c.deleted} ${c.deleted === 1 ? 'file' : 'files'}` : ''
  ].filter(Boolean).join(' · '),
  deliverables: (n) => `${n} ${n === 1 ? 'deliverable' : 'deliverables'}`,
  more: (n) => `${n} more ${n === 1 ? 'file' : 'files'}`,
  view: 'View changes',
  undo: 'Undo',
  ignoredAll: 'Ignored by Git',
  ignoredAllHint: 'Git ignores these files, so the Changes panel does not list them. Click a file name to preview it.',
  ignoredSome: (n) => `${n} ${n === 1 ? 'file is' : 'files are'} ignored by Git and not listed in the Changes panel`
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

const NO_DELIVERABLES: readonly ReplyFileLink[] = []

function useIgnoredCount(cwd: string | undefined, paths: readonly string[]): number {
  const key = cwd && paths.length ? `${cwd}\n${paths.join('\n')}` : ''
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!key || !cwd) {
      setCount(0)
      return undefined
    }
    const git = typeof window === 'undefined' ? undefined : window.yan?.git
    if (typeof git?.screenPaths !== 'function') return undefined
    let alive = true
    git
      .screenPaths(cwd, key.split('\n').slice(1))
      .then((result) => {
        if (alive) setCount(result?.ignored?.length ?? 0)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [key, cwd])
  return count
}

export function TurnChanges({ turn, changes, deliverables = NO_DELIVERABLES, cwd, previewCwd, readOnly, rewindOwner }: {
  turn: AssistantTurn
  changes: TurnChangeSet | null
  deliverables?: readonly ReplyFileLink[]
  cwd?: string
  previewCwd?: string
  readOnly: boolean
  rewindOwner: string | null
}): JSX.Element | null {
  const { lang } = useI18n()
  const openRewind = useStore((s) => s.openRewind)
  const previewFile = useStore((s) => s.previewFile)
  const wantsCheckpoint = !!changes && !readOnly && !!rewindOwner
  const checkpoints = useStore((s) => s.checkpoints)
  const owned = useMemo(
    () => (wantsCheckpoint ? checkpoints.filter((record) => record.sessionKey === rewindOwner) : []),
    [checkpoints, rewindOwner, wantsCheckpoint]
  )
  const anchor = useStore(useShallow((s) => (owned.length ? promptBefore(s.messages, turn.sourceIds) : null)))
  const checkpointId = useMemo(() => {
    if (!owned.length || !anchor) return null
    return matchCheckpoint(owned, anchor.text, anchor.timestamp)?.id ?? null
  }, [anchor, owned])
  const rows = useMemo(() => (changes ? changeRows(changes.files, cwd) : []), [changes, cwd])
  const changedPaths = useMemo(() => rows.map((row) => row.file.path), [rows])
  const ignored = useIgnoredCount(cwd || previewCwd, changedPaths)
  if (!rows.length && !deliverables.length) return null
  const allIgnored = ignored > 0 && ignored >= changedPaths.length

  const text = changesText(lang)
  const prompt = checkpointId ? anchor : null
  const checkpoint = checkpointId ? { id: checkpointId } : null
  const summary = [changes ? text.summary(changes.counts) : '', deliverables.length ? text.deliverables(deliverables.length) : ''].filter(Boolean).join(' \u00b7 ')
  const single = rows.length + deliverables.length === 1
  const shownRows = rows.length > ROW_LIMIT + 1 ? rows.slice(0, ROW_LIMIT) : rows
  const hidden = rows.length - shownRows.length
  const totals = changes && changes.added >= 0 && changes.added + changes.removed > 0 ? changes : null
  const openFile = (file: ReplyFileLink): void => void previewFile(file.path, file.line, previewCwd, file.lineEnd)
  const openChange = (path: string): void => void previewFile(path, undefined, previewCwd || cwd)

  return (
    <section className="v3-chg" data-testid="v3-turn-changes" data-single={single || undefined} aria-label={`${text.title} \u00b7 ${summary}`}>
      <header className="v3-chg-head">
        <div className="v3-chg-title">
          <span className="v3-result-label" data-testid="v3-turn-changes-label">{text.title}</span>
          <span className="v3-chg-summary" data-testid="v3-turn-changes-summary">{summary}</span>
          {single ? <span className="v3-chg-sep" aria-hidden>{'\u00b7'}</span> : null}
          {single && rows[0] ? <ChangePath row={rows[0]} onOpen={openChange} /> : null}
          {single && deliverables[0] ? <DeliverableButton file={deliverables[0]} onOpen={openFile} /> : null}
          {totals ? <DiffStat className="v3-chg-stats" added={totals.added} removed={totals.removed} /> : null}
        </div>
        <div className="v3-chg-actions">
          {checkpoint && prompt ? (
            <Button size="sm" variant="ghost" onPress={() => openRewind(checkpoint.id, prompt.text)} data-testid="v3-turn-changes-undo">
              {text.undo}
              <Undo2 size={13} aria-hidden />
            </Button>
          ) : null}
          {changes && allIgnored ? (
            <span className="v3-chg-summary" title={text.ignoredAllHint} data-testid="v3-turn-changes-ignored">
              {text.ignoredAll}
            </span>
          ) : changes ? (
            <Button size="sm" variant="ghost" title={ignored > 0 ? text.ignoredSome(ignored) : undefined} onPress={() => openPanelTool('changes')} data-testid="v3-turn-changes-view">
              {text.view}
            </Button>
          ) : null}
        </div>
      </header>
      {single ? null : (
        <ul className="v3-chg-list">
          {shownRows.map((row) => (
            <li key={row.file.path} className="v3-chg-row" data-testid="v3-turn-changes-row" title={row.file.path}>
              <ChangePath row={row} onOpen={openChange} />
              {row.file.added + row.file.removed > 0 ? <DiffStat className="v3-chg-stats" added={row.file.added} removed={row.file.removed} /> : null}
            </li>
          ))}
          {hidden > 0 ? (
            <li className="v3-chg-row" data-kind="more">
              <Button size="sm" variant="ghost" className="v3-chg-more" onPress={() => openPanelTool('changes')} data-testid="v3-turn-changes-more">{text.more(hidden)}</Button>
            </li>
          ) : null}
          {deliverables.map((file) => (
            <li key={file.path} className="v3-chg-row" data-kind="deliverable">
              <DeliverableButton file={file} onOpen={openFile} />
              {file.label && file.label !== file.base ? <span className="v3-chg-note">{file.label}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ChangePath({ row, onOpen }: { row: TurnChangeRow; onOpen: (path: string) => void }): JSX.Element {
  return (
    <Button size="sm" variant="ghost" className="v3-chg-path" title={row.file.path} icon={<FileTypeIcon name={row.base} size={14} />} onPress={() => onOpen(row.file.path)} data-testid="v3-turn-change-file">
      <span className="v3-chg-name">
        {row.dir ? <span className="v3-chg-dir">{row.dir}</span> : null}
        <span className="v3-chg-base">{row.base}</span>
      </span>
    </Button>
  )
}

function DeliverableButton({ file, onOpen }: { file: ReplyFileLink; onOpen: (file: ReplyFileLink) => void }): JSX.Element {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="v3-chg-file"
      icon={<FileTypeIcon name={file.base} size={14} />}
      title={file.label && file.label !== file.base ? `${file.label}\n${file.path}` : file.path}
      onPress={() => onOpen(file)}
      data-testid="v3-turn-file"
    >
      {file.base}
    </Button>
  )
}
