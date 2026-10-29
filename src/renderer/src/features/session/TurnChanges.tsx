import { useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, Undo2 } from 'lucide-react'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel, DiffStat } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n, type Lang } from '../../i18n'
import { useStore } from '../../state/store'
import { openPanelTool } from '../workbench/panel-actions'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import type { UIMessage } from '../../../../shared/ipc'
import type { AssistantTurn } from '../../../../shared/turns'
import { groupChangesByDir, splitChangePath, type TurnChangeGroup, type TurnFileChange, type TurnFileStatus } from './turn-changes'
import { turnChangeSet } from './turn-process'
import './turn-changes.css'

const OPEN_GROUPS_UP_TO = 1

interface ChangesText {
  summary: (counts: Record<TurnFileStatus, number>) => string
  files: (n: number) => string
  view: string
  undo: string
}

const ZH: ChangesText = {
  summary: (c) => [
    c.created ? `新建 ${c.created} 个文件` : '',
    c.modified ? `编辑 ${c.modified} 个文件` : '',
    c.deleted ? `删除 ${c.deleted} 个文件` : ''
  ].filter(Boolean).join(' · '),
  files: (n) => `${n} 个文件有改动`,
  view: '查看更改',
  undo: '撤销'
}
const EN: ChangesText = {
  summary: (c) => [
    c.created ? `Created ${c.created} ${c.created === 1 ? 'file' : 'files'}` : '',
    c.modified ? `Edited ${c.modified} ${c.modified === 1 ? 'file' : 'files'}` : '',
    c.deleted ? `Deleted ${c.deleted} ${c.deleted === 1 ? 'file' : 'files'}` : ''
  ].filter(Boolean).join(' · '),
  files: (n) => `${n} ${n === 1 ? 'file changed' : 'files changed'}`,
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
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const cwd = turn.response?.sourceCwd || sessionCwd || undefined
  const changes = useMemo(() => turnChangeSet(turn, cwd), [turn, cwd])
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
  if (!changes) return null

  const text = changesText(lang)
  const prompt = checkpointId ? anchor : null
  const checkpoint = checkpointId ? { id: checkpointId } : null
  const single = changes.files.length === 1 ? changes.files[0] : null
  const groups = single ? [] : groupChangesByDir(changes.files, cwd)
  const openByDefault = groups.length <= OPEN_GROUPS_UP_TO
  const singleBase = single ? splitChangePath(single.path, cwd).base : ''

  return (
    <section className="v3-chg" data-testid="v3-turn-changes" aria-label={text.summary(changes.counts)}>
      <header className="v3-chg-head">
        <div className="v3-chg-title" title={single ? single.path : text.summary(changes.counts)}>
          {single ? (
            <span className="v3-chg-path"><FileTypeIcon name={singleBase} size={14} />{singleBase}</span>
          ) : (
            <strong>{text.files(changes.files.length)}</strong>
          )}
          {changes.added >= 0 && changes.added + changes.removed > 0 ? <DiffStat className="v3-chg-stats" added={changes.added} removed={changes.removed} /> : null}
        </div>
        <div className="v3-chg-actions">
          {checkpoint && prompt ? (
            <Button size="sm" variant="ghost" onPress={() => openRewind(checkpoint.id, prompt.text)} data-testid="v3-turn-changes-undo">
              {text.undo}
              <Undo2 size={13} aria-hidden />
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onPress={() => openPanelTool('changes')} data-testid="v3-turn-changes-view">
            {text.view}
          </Button>
        </div>
      </header>
      {groups.length ? (
        <ul className="v3-chg-list">
          {groups.map((group) => group.dir
            ? <ChangeGroup key={group.dir} group={group} expanded={openDirs[group.dir] ?? openByDefault} onExpandedChange={(open) => setOpenDirs((prev) => ({ ...prev, [group.dir]: open }))} />
            : group.files.map(({ file, base }) => <ChangeRow key={file.path} file={file} base={base} />))}
        </ul>
      ) : null}
    </section>
  )
}

function ChangeGroup({ group, expanded, onExpandedChange }: { group: TurnChangeGroup; expanded: boolean; onExpandedChange: (open: boolean) => void }): JSX.Element {
  const known = group.files.every(({ file }) => file.added >= 0 && file.removed >= 0)
  return (
    <li className="v3-chg-group">
      <Collapsible isExpanded={expanded} onExpandedChange={onExpandedChange}>
        <CollapsibleHeader
          className="v3-chg-dir-head"
          size="compact"
          icon={<Folder size={14} aria-hidden />}
          accessory={known && group.added + group.removed > 0 ? <DiffStat className="v3-chg-stats" added={group.added} removed={group.removed} /> : undefined}
          data-testid="v3-turn-changes-dir"
        >
          <span className="v3-chg-dir" title={group.dir}>{group.dir.replace(/\/$/, '')}</span>
        </CollapsibleHeader>
        <CollapsiblePanel className="v3-chg-panel">
          {expanded ? (
            <ul className="v3-chg-sub">
              {group.files.map(({ file, base }) => <ChangeRow key={file.path} file={file} base={base} />)}
            </ul>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </li>
  )
}

function ChangeRow({ file, base }: { file: TurnFileChange; base: string }): JSX.Element {
  return (
    <li className="v3-chg-row" data-testid="v3-turn-changes-row" title={file.path}>
      <span className="v3-chg-path"><FileTypeIcon name={base} size={14} />{base}</span>
      {file.added + file.removed > 0 ? <DiffStat className="v3-chg-stats" added={file.added} removed={file.removed} /> : null}
    </li>
  )
}
