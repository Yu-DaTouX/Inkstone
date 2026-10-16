/**
 * 侧栏的「已归档」视图：已归档的项目（可恢复）与单独归档的会话（可取消归档、打开）。
 *
 * 数据来自 `buildArchivedView`；恢复项目写 `ProjectRecord.archived=false`，
 * 取消归档走 store 的 `setSessionArchived`，失败提示由 store / 这里的 notice 给出。
 */
import type { JSX } from 'react'
import { ArchiveRestore, Undo2 } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton } from '../../ui'
import { IconTip } from '../../app/IconTip'
import type { SessionSummary } from '../../../../shared/ipc'
import { setProjectArchived } from './ProjectHeader'
import { sidebarText } from './sidebar-text'
import type { ArchivedView as ArchivedViewData } from './sidebar-model'

export function ArchivedView({
  view,
  titleOf,
  onOpen
}: {
  view: ArchivedViewData
  titleOf: (session: SessionSummary) => string
  onOpen: (session: SessionSummary) => void
}): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const empty = view.projects.length === 0 && view.sessions.length === 0

  const restoreProject = async (projectId: string): Promise<void> => {
    const ok = await setProjectArchived(projectId, false)
    if (!ok) useStore.getState().notify('error', t('rail.projectError'))
  }

  return (
    <div className="v3-archived" data-testid="v3-archived-view">
      {empty ? <p className="v3-side-empty">{own.archivedEmpty}</p> : null}

      {view.projects.length > 0 ? (
        <div className="v3-group">
          <div className="v3-grp">
            <span className="v3-grp-label">{own.archivedProjects}</span>
          </div>
          {view.projects.map((project) => (
            <div key={project.record.id} className="v3-arow" data-testid="v3-archived-project">
              <span className="v3-arow-main">
                <span className="v3-row-title" title={project.record.cwd}>{project.label}</span>
                <span className="v3-arow-meta">{own.projectSessionCount.replace('{n}', String(project.sessionCount))}</span>
              </span>
              <IconTip label={own.restoreProject}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={own.restoreProject}
                  onPress={() => void restoreProject(project.record.id)}
                  data-testid="v3-restore-project"
                >
                  <ArchiveRestore size={14} />
                </IconButton>
              </IconTip>
            </div>
          ))}
        </div>
      ) : null}

      {view.sessions.length > 0 ? (
        <div className="v3-group">
          <div className="v3-grp">
            <span className="v3-grp-label">{own.archivedSessions}</span>
          </div>
          {view.sessions.map((session) => (
            <div key={session.path} className="v3-arow" data-testid="v3-archived-session">
              <button type="button" className="v3-arow-main v3-arow-open" onClick={() => onOpen(session)} title={session.cwd}>
                <span className="v3-row-title">{titleOf(session)}</span>
              </button>
              <IconTip label={own.restoreSession}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={own.restoreSession}
                  onPress={() => void useStore.getState().setSessionArchived(session.id, false)}
                  data-testid="v3-restore-session"
                >
                  <Undo2 size={14} />
                </IconButton>
              </IconTip>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
