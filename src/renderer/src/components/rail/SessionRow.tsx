import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { ContextMenuSurface, type ContextMenuAnchor } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { shortProject } from './rail-utils'
import { forkLatest } from '../../lib/fork'
import { RunDot } from '../ui'
import { displayedSessionOf, sameSplitSession, useSplitView } from '../../state/split-view'

export function SessionRow({ s, selected, branchCount, branchIndex, branchesOpen, onToggleBranches,
  children, depth, menuOpen, menuAnchor, onOpenMenu, onCloseMenu, onSelect, pinned, onPin, unread, projectRecords, onRequestDelete, dragging, onDragStart, archived, onArchive
}: {
  s: SessionSummary; selected: boolean; branchCount: number; branchIndex?: number;
  branchesOpen: boolean; onToggleBranches: () => void; children: React.ReactNode; depth: number;
  menuOpen: boolean; menuAnchor: ContextMenuAnchor | null;
  onOpenMenu: (trigger: HTMLElement | null, point?: { x: number; y: number }) => void;
  onCloseMenu: () => void;
  onSelect: () => void; pinned: boolean; onPin: () => void; unread: boolean;
  projectRecords: ProjectRecord[];
  onRequestDelete: () => void;
  archived: boolean; onArchive: () => void;
  dragging: boolean;
  onDragStart: (e: React.PointerEvent) => void
}) {
  const t = useT()
  const open = useSplitView((v) => !!v.split?.tiles.some((tile) => sameSplitSession(tile, { sessionId: s.id, path: s.path })))
  const runner = useStore((state) => state.runners.find((r) => !!r.sessionFile && r.sessionFile === s.path))
  const titleCandidate = useStore((state) => state.titleCandidates[s.id])
  const hasRunningSubagent = useStore((state) => state.subagents.some((r) => r.parentSessionId === s.id && (r.status === 'running' || r.status === 'starting')))
  const running = runner?.running === true || hasRunningSubagent
  const waiting = runner?.waiting === true
  const failure = runner?.failed ? t('rail.runnerFailed') : ''
  const isolation = runner?.isolation
  const isolationLabel =
    isolation === 'blocked'
      ? t('rail.isolationBlocked')
      : isolation === 'waiting'
        ? t('rail.isolationWaiting', { branch: runner?.isolationBranch ?? '' })
        : ''
  const [renaming, setRenaming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const archiveWithExit = (): void => {
    setLeaving(true)
    window.setTimeout(onArchive, 150)
    window.setTimeout(() => setLeaving(false), 600)
  }
  const [draft, setDraft] = useState(s.title)
  const moveTargets = projectRecords.filter((project) => !project.archived && project.id !== s.projectId)

  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === s.title) return
    void useStore.getState().setManualTitle(s.id, name)
  }

  return (
    <div className={`srow-wrap has-acts ${menuOpen ? 'menu-open' : ''}${dragging ? ' is-dragging' : ''}${leaving ? ' leaving' : ''}`} data-session-path={s.path} data-depth={depth} style={{ '--branch-depth': Math.min(depth, 3) } as React.CSSProperties} onPointerDown={onDragStart}>
      <div className={`srow-row ${selected ? 'selected' : open ? 'open' : ''}`} data-split-open={open || undefined} onContextMenu={(e) => { e.preventDefault(); onOpenMenu(e.currentTarget, { x: e.clientX, y: e.clientY }) }}>
        {renaming ? (
          <input
            className="srow-rename-input"
            data-testid="rail-rename-input"
            autoFocus
            value={draft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
                setDraft(s.title)
              }
            }}
          />
        ) : (
          <button className={`srow ${selected ? 'sel' : ''}`} onClick={(e) => {
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); openInSplit(s) } else {
              useStore.getState().requestComposerFocus({ sessionId: s.id, path: s.path })
              onSelect()
            }
          }} title={`${s.title}${s.branchOrigin ? '\n' + s.branchOrigin : ''}\n${s.path}`} data-testid={depth ? 'rail-branch-item' : 'rail-session'}>
            {waiting ? <span className="srow-dot waiting" data-testid="rail-waiting" title={t('rail.waiting')} />
              : failure ? <span className="srow-dot failed" data-testid="rail-failed" title={failure} />
              : running ? <RunDot className="srow-dot-run" label={t('rail.running')} />
              : isolation ? <span className={`srow-dot iso${isolation === 'blocked' ? ' blocked' : ''}`} data-testid={`rail-isolation-${isolation}`} title={isolationLabel} />
              : unread ? <span className="srow-dot unread" data-testid="rail-unread" title={t('rail.unread')} />
              : <span className="srow-dot" aria-hidden />}
            <span className="srow-text">
              <span className="srow-line">
                {branchIndex ? (
                  <span className="srow-bno" data-testid="rail-branch-no" title={t('rail.branchNo', { n: branchIndex })}>
                    #{branchIndex}
                  </span>
                ) : null}
                <span className="srow-name">{s.title}</span>
                <span className="srow-time">{relTime(s.lastActivityAt ?? s.updatedAt, t('rail.justNow'))}</span>
              </span>
              {s.branchOrigin ? (
                <span className="srow-origin" data-testid="rail-branch-origin" title={s.branchOrigin}>
                  {t('rail.fromMessage', { text: s.branchOrigin })}
                </span>
              ) : null}
            </span>
          </button>
        )}

        {branchCount > 0 ? (
          <button
            className={`srow-btoggle ${branchesOpen ? 'open' : ''}`}
            data-testid="rail-branch-toggle"
            data-open={branchesOpen ? '1' : '0'}
            aria-expanded={branchesOpen}
            title={t('rail.branchCount', { n: branchCount })}
            onClick={onToggleBranches}
          >
            <Icon name="branch" size={12} className="srow-btoggle-ico" />
            <span className="srow-btoggle-n">{branchCount}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
        ) : null}

      </div>

      {branchesOpen && children ? <div className="session-children" data-testid="rail-branch-tree">{children}</div> : null}

      <span className="srow-acts">
        <button className="rail-icon sm" title={t('rail.more')} onClick={(e) => {
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          onOpenMenu(e.currentTarget, { x: rect.left, y: rect.bottom })
        }}>
          <Icon name="menu" size={12} />
        </button>
      </span>

      <ContextMenuSurface
        open={menuOpen}
        anchor={menuAnchor}
        onClose={onCloseMenu}
        testid="rail-session-menu"
        data-session-path={s.path}
        className="ctx-menu ui-menu row-menu-surface"
      >
          <div className="srow-menu-time" data-testid="rail-menu-time">
            {t('rail.lastActive')} {relTime(s.lastActivityAt ?? s.updatedAt, t('rail.justNow'))}
          </div>
          {runner && (runner.running || runner.waiting) ? (
            <button
              className="ui-menu-item srow-menu-btn" role="menuitem"
              data-testid="rail-stop-runner"
              onClick={() => {
                onCloseMenu()
                void window.yan.stopRunner(runner.id).then(() => useStore.getState().syncRunners())
              }}
            >
              <Icon name="alert-circle" size={12} />
              {t('rail.stopRunner')}
            </button>
          ) : null}
          {titleCandidate ? (
            <div className="srow-title-candidate" data-testid="rail-title-candidate">
              <div className="srow-title-candidate-label">{t('rail.titleCandidate')}</div>
              <div className="srow-title-candidate-name" title={titleCandidate}>{titleCandidate}</div>
              <div className="srow-title-candidate-actions">
                <button
                  className="ui-menu-item srow-menu-btn" role="menuitem"
                  data-testid="rail-accept-title-candidate"
                  onClick={() => {
                    void useStore.getState().acceptTitleCandidate(s.id)
                    onCloseMenu()
                  }}
                >
                  <Icon name="check" size={12} />
                  {t('rail.acceptTitleCandidate')}
                </button>
                <button
                  className="ui-menu-item srow-menu-btn" role="menuitem"
                  data-testid="rail-dismiss-title-candidate"
                  onClick={() => {
                    useStore.getState().dismissTitleCandidate(s.id)
                    onCloseMenu()
                  }}
                >
                  <Icon name="plus" size={12} className="rail-trash-x" />
                  {t('rail.dismissTitleCandidate')}
                </button>
              </div>
            </div>
          ) : null}
          <button className="ui-menu-item srow-menu-btn" role="menuitem" onClick={() => { onPin(); onCloseMenu() }}><Icon name="pin" size={12} />{pinned ? t('rail.unpin') : t('rail.pin')}</button>
          <button className="ui-menu-item srow-menu-btn" role="menuitem" data-testid="rail-archive" onClick={() => { archiveWithExit(); onCloseMenu() }}><Icon name="folder" size={12} />{archived ? t('rail.unarchive') : t('rail.archive')}</button>
          <button
            className="ui-menu-item srow-menu-btn" role="menuitem"
            data-testid="rail-open-split"
            disabled={selected}
            title={t('rail.openSplitTip')}
            onClick={() => { openInSplit(s); onCloseMenu() }}
          >
            <Icon name="tile" size={12} />
            {t('rail.openSplit')}
          </button>
          <div className="srow-menu-section" data-testid="rail-move-session">
            <div className="srow-menu-section-title">{t('rail.moveSession')}</div>
            {s.scope !== 'global' ? (
              <button
                className="ui-menu-item srow-menu-btn" role="menuitem"
                data-testid="rail-move-global"
                onClick={() => {
                  void useStore.getState().moveSession(s.id, null).then((done) => { if (done) onCloseMenu() })
                }}
              >
                <Icon name="globe" size={12} />
                {t('rail.defaultLocation')}
              </button>
            ) : null}
            {moveTargets.map((project) => (
              <button
                key={project.id}
                className="ui-menu-item srow-menu-btn" role="menuitem"
                data-testid={`rail-move-project-${project.id}`}
                onClick={() => {
                  void useStore.getState().moveSession(s.id, project.id).then((done) => { if (done) onCloseMenu() })
                }}
              >
                <Icon name="folder" size={12} />
                {project.name || shortProject(project.cwd)}
              </button>
            ))}
          </div>
          <button
            style={{ '--i': 1 } as React.CSSProperties}
            className="ui-menu-item srow-menu-btn" role="menuitem"
            data-testid="rail-regenerate-title"
            onClick={() => {
              onCloseMenu()
              void useStore.getState().regenerateTitle(s.id)
            }}
          >
            <Icon name="sparkles" size={12} />
            {t('rail.regenerateTitle')}
          </button>
          <button
            disabled={!selected || running}
            title={!selected ? t('rail.openBeforeFork') : ''}
            style={{ '--i': 1 } as React.CSSProperties}
            className="ui-menu-item srow-menu-btn" role="menuitem"
            onClick={() => {
              void forkLatest()
              onCloseMenu()
            }}
          >
            <Icon name="branch" size={12} />
            {t('rail.forkLast')}
          </button>
          <button
            style={{ '--i': 2 } as React.CSSProperties}
            className="ui-menu-item srow-menu-btn" role="menuitem"
            data-testid="rail-rename"
            onClick={() => {
              setDraft(s.title)
              setRenaming(true)
              onCloseMenu()
            }}
          >
            <Icon name="pencil" size={12} />
            {t('rail.rename')}
          </button>
          <button
            style={{ '--i': 3 } as React.CSSProperties}
            className="ui-menu-item srow-menu-btn" role="menuitem"
            onClick={() => {
              void window.yan.revealPath(s.path)
              onCloseMenu()
            }}
          >
            <Icon name="folder" size={12} />
            {t('rail.reveal')}
          </button>
          <button
            className="ui-menu-item srow-menu-btn danger" role="menuitem"
            style={{ '--i': 4 } as React.CSSProperties}
            disabled={selected}
            title={selected ? t('rail.cantDeleteCurrent') : ''}
            onClick={() => { onRequestDelete(); onCloseMenu() }}
          >
            <Icon name="alert-circle" size={12} />
            {t('rail.delete')}
          </button>
      </ContextMenuSurface>
    </div>
  )
}

export function openInSplit(s: SessionSummary, at?: number): void {
  const st = useStore.getState()
  useSplitView.getState().open({ sessionId: s.id, path: s.path }, displayedSessionOf(st), at)
}

function relTime(ts: number, justNow: string): string {
  const d = Math.max(0, Date.now() - ts)
  const m = Math.floor(d / 60_000)
  if (m < 1) return justNow
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}
