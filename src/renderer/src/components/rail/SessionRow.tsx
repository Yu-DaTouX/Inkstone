import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { ContextMenuSurface, type ContextMenuAnchor } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { shortProject } from './rail-utils'
import { forkLatest } from '../../lib/fork'
import { RunDot } from '../ui'

/* ---------------------------------------------------------------- 会话行 */

export function SessionRow({ s, selected, branchCount, branchIndex, branchesOpen, onToggleBranches,
  children, depth, menuOpen, menuAnchor, onOpenMenu, onCloseMenu, onSelect, pinned, onPin, unread, projectRecords, onRequestDelete, dragging, onDragStart
}: {
  s: SessionSummary; selected: boolean; branchCount: number; branchIndex?: number;
  branchesOpen: boolean; onToggleBranches: () => void; children: React.ReactNode; depth: number;
  menuOpen: boolean; menuAnchor: ContextMenuAnchor | null;
  onOpenMenu: (trigger: HTMLElement | null, point?: { x: number; y: number }) => void;
  onCloseMenu: () => void;
  onSelect: () => void; pinned: boolean; onPin: () => void; unread: boolean;
  projectRecords: ProjectRecord[];
  onRequestDelete: () => void;
  /** 正在被拖动（视觉态：整行变淡） */
  dragging: boolean;
  /** 按下即准备拖拽（越过阈值才算真拖，见 `beginDrag`） */
  onDragStart: (e: React.PointerEvent) => void
}) {
  const t = useT()
  /*
   * 运行 / 等待 / 失败状态来自**运行实例注册表**（N12）。
   *
   * 旧实现判断的是 `state.session?.sessionFile === s.path` —— 那是「当前
   * 正在看的会话」，所以后台会话在跑也看不出来。现在每个会话的实例都在
   * 注册表里，左栏每一行都能显示自己的状态。
   */
  const runner = useStore((state) => state.runners.find((r) => !!r.sessionFile && r.sessionFile === s.path))
  const titleCandidate = useStore((state) => state.titleCandidates[s.id])
  /** 可归入的空间（左栏空间分区已移除，会话归属改从本行菜单改） */
  const spaces = useStore((state) => state.spaces)
  const running = runner?.running === true
  const waiting = runner?.waiting === true
  const failure = runner?.failed ? t('rail.runnerFailed') : ''
  /*
   * 自动隔离标记（同一工作目录冲突时砚把这条会话换到了隔离工作树）。
   *
   * 只对**有运行实例**的会话可见：信息挂在主进程的运行实例快照上（与 running /
   * waiting / failed 同一条路），而不是会话摘要 —— 实例已经停掉的行没有它。
   */
  const isolation = runner?.isolation
  const isolationLabel =
    isolation === 'blocked'
      ? t('rail.isolationBlocked')
      : isolation === 'waiting'
        ? t('rail.isolationWaiting', { branch: runner?.isolationBranch ?? '' })
        : ''
  /**
   * 行内重命名。
   *
   * ⚠️ 以前用 `window.prompt` —— 而 **Electron 不支持 prompt()**
   *    （调用返回 null 并报错），于是点「重命名」什么都不会发生，
   *    用户看到的就是「左栏会话没办法重命名」。
   *    改成行内 input：不依赖浏览器对话框，也少一层弹窗。
   */
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(s.title)
  const moveTargets = projectRecords.filter((project) => !project.archived && project.id !== s.projectId)

  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === s.title) return
    void useStore.getState().setManualTitle(s.id, name)
  }

  return (
    <div className={`srow-wrap has-acts ${menuOpen ? 'menu-open' : ''}${dragging ? ' is-dragging' : ''}`} data-session-path={s.path} data-depth={depth} style={{ '--branch-depth': Math.min(depth, 3) } as React.CSSProperties} onPointerDown={onDragStart}>
      {/* 行主体：会话按钮（占满，可省略号） + 分叉开关 + 相对时间 */}
      <div className={`srow-row ${selected ? 'selected' : ''}`} onContextMenu={(e) => { e.preventDefault(); onOpenMenu(e.currentTarget, { x: e.clientX, y: e.clientY }) }}>
        {renaming ? (
          /* 行内重命名：Enter 提交 / Esc 取消 / 失焦提交 */
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
          <button className={`srow ${selected ? 'sel' : ''}`} onClick={onSelect} title={`${s.title}${s.branchOrigin ? '\n' + s.branchOrigin : ''}\n${s.path}`} data-testid={depth ? 'rail-branch-item' : 'rail-session'}>
            {/* 行首状态点：运行（强调色方点）/ 等你回答 / 失败 / 隔离 / 未读 / 空心（静止） */}
            {waiting ? <span className="srow-dot waiting" data-testid="rail-waiting" title={t('rail.waiting')} />
              : failure ? <span className="srow-dot failed" data-testid="rail-failed" title={failure} />
              : running ? <RunDot className="srow-dot-run" label={t('rail.running')} />
              : isolation ? <span className={`srow-dot iso${isolation === 'blocked' ? ' blocked' : ''}`} data-testid={`rail-isolation-${isolation}`} title={isolationLabel} />
              : unread ? <span className="srow-dot unread" data-testid="rail-unread" title={t('rail.unread')} />
              : <span className="srow-dot" aria-hidden />}
            <span className="srow-text">
              <span className="srow-line">
                {/* 分支编号：这个会话是从别的会话分出来的第几个 */}
                {branchIndex ? (
                  <span className="srow-bno" data-testid="rail-branch-no" title={t('rail.branchNo', { n: branchIndex })}>
                    #{branchIndex}
                  </span>
                ) : null}
                <span className="srow-name">{s.title}</span>
              </span>
              {/* 分叉自父会话的哪句话 */}
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

        {/* 显示的时间必须与排序键一致，否则看起来“没排序” */}
        <span className="srow-time">{relTime(s.lastActivityAt ?? s.updatedAt)}</span>
      </div>

      {branchesOpen && children ? <div className="session-children" data-testid="rail-branch-tree">{children}</div> : null}

      {/*
       * 动作按钮（⋯）**每一行都渲染**，悬停才显形。
       *
       * ⚠️ 以前只在 selected 行渲染 ── 而菜单里的「删除」又对 selected 行
       *    禁用（当前会话不能删）→ **删除功能永远点不到**（用户报的）。
       *    现在任何行悬停都能开菜单，未选中的行删除可用。
       *    隐藏时 pointer-events:none，否则看不见的按钮会抢走“点行选中”的点击。
       */}
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
            {t('rail.lastActive')} {relTime(s.lastActivityAt ?? s.updatedAt)}
          </div>
          {/* 停止**这一个**运行实例（N12）：后台会话也能单独停，不影响别的会话 */}
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
          {
            /*
             * 空间：从「左栏的一层目录」改为会话上的标签（实施-27 B3）。
             * 左栏不再有常驻的空间分区，但「把这条会话归到哪个空间」必须仍然可达 ——
             * 它本来就该跟着**具体这条会话**出现，而不是先选空间再找会话。
             */
            spaces.filter((x) => !x.archived).length > 0 || s.spaceId ? (
            <div className="srow-menu-section" data-testid="rail-session-space">
              <div className="srow-menu-section-title">{t('rail.spaces')}</div>
              {s.spaceId ? (
                <button
                  className="ui-menu-item srow-menu-btn" role="menuitem"
                  data-testid="rail-space-release-session"
                  onClick={() => {
                    void useStore.getState().setSessionSpace(s.id, null).then((done) => { if (done) onCloseMenu() })
                  }}
                >
                  <Icon name="plus" size={12} className="rail-trash-x" />
                  {t('rail.spaceRelease')}
                </button>
              ) : null}
              {spaces.filter((x) => !x.archived && x.id !== s.spaceId).map((sp) => (
                <button
                  key={sp.id}
                  className="ui-menu-item srow-menu-btn" role="menuitem"
                  data-testid={`rail-space-put-${sp.id}`}
                  onClick={() => {
                    void useStore.getState().setSessionSpace(s.id, sp.id).then((done) => { if (done) onCloseMenu() })
                  }}
                >
                  <Icon name="group" size={12} />
                  {sp.name}
                </button>
              ))}
            </div>
            ) : null
          }
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
              /*
               * 重命名。
               *
               * ⚠️ 这里曾经**没有入口** —— 后来加上了，但用 `window.prompt`；
               *    而 **Electron 不支持 prompt()**（返回 null），于是点了没反应，
               *    用户看到的就是「左栏会话没办法重命名」。
               *    现在改成行内 input（见上面的 renaming），不再依赖浏览器对话框。
               */
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

/* 分叉的两个入口在 lib/fork.ts —— 对话区（消息上的分支按钮）也要用，
   放在这里会让对话区反过来 import 左栏。 */
/* ---------------------------------------------------------------- 工具 */

/** 相对时间：12m / 5h / 3d */
function relTime(ts: number): string {
  const d = Math.max(0, Date.now() - ts)
  const m = Math.floor(d / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}
