import { Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components'
import { Check, Folder, FolderOpen } from 'lucide-react'
import { Button } from '../../ui'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProjectRecord } from '../../../../shared/ipc'

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
  const notify = useStore((s) => s.notify)

  const listed = (projects ?? []).filter((p) => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT)
  const current = (projects ?? []).find((p) => p.id === currentProjectId)
  const chooseFolder = lang === 'en-US' ? 'Choose folder…' : '选择文件夹…'
  const noProject = lang === 'en-US' ? 'No project' : '不使用项目'

  const openProject = (project: ProjectRecord): void => {
    if (project.id === currentProjectId) return
    void newSession({ cwd: project.cwd, projectId: project.id, scope: 'project' })
  }

  const pickFolder = async (): Promise<void> => {
    const selected = await window.yan.pickCwd().catch(() => null)
    if (!selected) return
    const result = await window.yan.setCwd(selected)
    if (!result.ok) {
      notify('error', result.error ?? selected)
      return
    }
    const settings = await window.yan.getSettings()
    useStore.setState({ settings })
    const project = settings.projects.find((p) => p.cwd === settings.cwd)
    await newSession({ cwd: settings.cwd, projectId: project?.id, scope: 'project' })
  }

  return (
    <MenuTrigger>
      <Button variant="ghost" size="sm" className="composer-permission composer-project" aria-haspopup="menu" data-testid="composer-project">
        <Folder size={13} aria-hidden />
        <span className="cp-label">{current ? projectLabel(current) : t('chat.pickProject')}</span>
      </Button>
      <Popover className="composer-permission-pop" placement="top start" offset={6}>
        <Menu className="composer-permission-menu" aria-label={t('chat.pickProject')} data-testid="composer-project-menu">
          {listed.map((project) => (
            <MenuItem
              key={project.id}
              className="cpm-item"
              textValue={projectLabel(project)}
              data-current={project.id === currentProjectId ? 'true' : undefined}
              onAction={() => openProject(project)}
            >
              <Folder size={14} aria-hidden />
              <span className="cpm-label">{projectLabel(project)}</span>
              {project.id === currentProjectId ? <Check className="cpm-check" size={13} aria-hidden /> : null}
              <span className="cpm-hint">{project.cwd}</span>
            </MenuItem>
          ))}
          {currentProjectId ? (
            <MenuItem className="cpm-item" textValue={noProject} onAction={() => void newSession({ scope: 'global' })}>
              <span className="cpm-label">{noProject}</span>
            </MenuItem>
          ) : null}
          {listed.length > 0 || currentProjectId ? <Separator className="cpm-sep" /> : null}
          <MenuItem className="cpm-item" textValue={chooseFolder} onAction={() => void pickFolder()} data-testid="composer-project-browse">
            <FolderOpen size={14} aria-hidden />
            <span className="cpm-label">{chooseFolder}</span>
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
