import { Folder, FolderOpen, FolderX } from 'lucide-react'
import { Button, Menu, MenuItem, MenuSeparator, MenuTrigger, MiddleTruncate, Popover } from '../../ui'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProjectRecord } from '../../../../shared/ipc'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'

const RECENT_LIMIT = 8

function projectLabel(project: ProjectRecord): string {
  return project.name.trim() || project.cwd.split(/[\\/]/).filter(Boolean).pop() || project.cwd
}

export function ProjectPicker() {
  const t = useT()
  const { lang } = useI18n()
  const projects = useStore((s) => s.settings?.projects)
  const currentProjectId = useStore((s) => s.runners.find((r) => r.id === s.activeRunnerId)?.projectId)
  const newSession = useStore((s) => s.newSession)

  const listed = (projects ?? []).filter((p) => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT)
  const current = (projects ?? []).find((p) => p.id === currentProjectId)
  const chooseFolder = lang === 'en-US' ? 'Choose folder…' : '选择文件夹…'
  const noProject = lang === 'en-US' ? 'No project' : '不使用项目'

  const openProject = (project: ProjectRecord): void => {
    if (project.id === currentProjectId) return
    void newSession({ cwd: project.cwd, projectId: project.id, scope: 'project' })
  }

  const pickFolder = async (): Promise<void> => {
    await newSessionInPickedFolder(t)
  }

  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        className="composer-permission composer-project"
        aria-haspopup="menu"
        data-testid="composer-project"
        icon={<Folder size={14} />}
      >
        <span className="cp-label">{current ? projectLabel(current) : t('chat.pickProject')}</span>
      </Button>
      <Popover className="composer-permission-pop" placement="top start" offset={6}>
        <Menu className="composer-permission-menu" aria-label={t('chat.pickProject')} data-testid="composer-project-menu">
          {listed.map((project) => (
            <MenuItem
              key={project.id}
              textValue={projectLabel(project)}
              checked={project.id === currentProjectId}
              icon={<Folder size={14} />}
              description={<MiddleTruncate value={project.cwd} />}
              data-current={project.id === currentProjectId ? 'true' : undefined}
              onAction={() => openProject(project)}
            >
              {projectLabel(project)}
            </MenuItem>
          ))}
          {currentProjectId ? (
            <MenuItem textValue={noProject} checked={false} icon={<FolderX size={14} />} onAction={() => void newSession({ scope: 'global' })}>
              {noProject}
            </MenuItem>
          ) : null}
          {listed.length > 0 || currentProjectId ? <MenuSeparator /> : null}
          <MenuItem
            textValue={chooseFolder}
            checked={listed.length > 0 || currentProjectId ? false : undefined}
            icon={<FolderOpen size={14} />}
            onAction={() => void pickFolder()}
            data-testid="composer-project-browse"
          >
            {chooseFolder}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
