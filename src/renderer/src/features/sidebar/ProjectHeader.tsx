import { useRef, useState, type JSX } from 'react'
import { Archive, ChevronRight, FolderOpen, Link, MoreHorizontal, Pencil, Plus, Replace, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, IconButton, Menu, MenuItem, Modal, ModalOverlay, Notice, Popover } from '../../ui'
import { v3Text } from '../../app/v3-text'
import type { ProjectRecord } from '../../../../shared/ipc'
import { warnIfWorkspaceUnfit } from '../../lib/workspace-fit'
import { isGlobalGroup, sameCwd, type SidebarGroup } from './sidebar-model'
import { SidebarTip } from './SidebarTip'
import { ProjectBadge } from './ProjectBadge'
import { sidebarText } from './sidebar-text'

type MenuKey = 'new' | 'rename' | 'directory' | 'reveal' | 'copy' | 'archive'

export async function setProjectArchived(projectId: string, archived: boolean): Promise<boolean> {
  const store = useStore.getState()
  const projects = (store.settings?.projects ?? []).map((item) =>
    item.id === projectId ? { ...item, archived, updatedAt: Date.now() } : item
  )
  try {
    await store.patchSettings({ projects })
    return true
  } catch {
    return false
  }
}

export async function ensureProjectForCwd(cwd: string): Promise<ProjectRecord | undefined> {
  const find = (): ProjectRecord | undefined => useStore.getState().settings?.projects.find((item) => sameCwd(item.cwd, cwd))
  const existing = find()
  if (existing) return existing
  const recent = useStore.getState().settings?.recentCwds ?? []
  try {
    await useStore.getState().patchSettings({ recentCwds: [cwd, ...recent.filter((item) => item !== cwd)] })
  } catch {
    return undefined
  }
  return find()
}

export interface ProjectHeaderProps {
  group: SidebarGroup
  record?: ProjectRecord
  collapsed: boolean
  onToggle: () => void
  onNew: (projectId: string) => void
  clearLabel?: string
}

export function ProjectHeader({ group, record, collapsed, onToggle, onNew, clearLabel }: ProjectHeaderProps): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(group.label)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const label = group.label || text.projectFallback
  const manageable = !!group.cwd

  const notifyError = (message: string): void => useStore.getState().notify('error', message)

  const commitRename = async (): Promise<void> => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === group.label) return
    const target = record ?? (await ensureProjectForCwd(group.cwd))
    if (!target) {
      notifyError(t('rail.renameFailed', { name }))
      return
    }
    const settings = useStore.getState().settings
    try {
      await useStore.getState().patchSettings({
        projectNames: { ...(settings?.projectNames ?? {}), [target.cwd]: name },
        projects: (settings?.projects ?? []).map((item) => (item.id === target.id ? { ...item, name, updatedAt: Date.now() } : item))
      })
    } catch {
      notifyError(t('rail.renameFailed', { name }))
    }
  }

  const createHere = async (): Promise<void> => {
    const target = record ?? (await ensureProjectForCwd(group.cwd))
    if (target) onNew(target.id)
    else notifyError(own.registerFailed)
  }

  const openDirectory = async (): Promise<void> => {
    const target = record ?? (await ensureProjectForCwd(group.cwd))
    if (target) setDirectoryOpen(true)
    else notifyError(own.registerFailed)
  }

  const run = (key: MenuKey): void => {
    switch (key) {
      case 'new':
        void createHere()
        return
      case 'rename':
        setDraft(group.label)
        setRenaming(true)
        return
      case 'directory':
        void openDirectory()
        return
      case 'reveal':
        void window.yan.revealPath(group.cwd).catch((cause) => notifyError(cause instanceof Error ? cause.message : t('rail.projectError')))
        return
      case 'copy':
        void navigator.clipboard.writeText(group.cwd).catch((cause) => notifyError(cause instanceof Error ? cause.message : t('rail.projectError')))
        return
      case 'archive':
        setArchiveOpen(true)
    }
  }

  return (
    <div
      ref={rowRef}
      className="v3-grp"
      data-menu={menuOpen ? '1' : undefined}
      onContextMenu={(event) => {
        if (!manageable || renaming) return
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      {renaming ? (
        <input
          className="ui-input v3-grp-rename"
          aria-label={t('rail.renameProject')}
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') void commitRename()
            else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
          }}
          data-testid="v3-project-rename"
        />
      ) : (
        <SidebarTip label={label} detail={group.cwd || undefined}>
          <button
            type="button"
            className="v3-grp-toggle"
            aria-expanded={clearLabel ? undefined : !collapsed}
            aria-label={clearLabel ? `${label} · ${clearLabel}` : undefined}
            onClick={onToggle}
            data-testid="v3-group-toggle"
          >
            {clearLabel ? <ProjectBadge label={label} global={isGlobalGroup(group)} /> : null}
            <span className="v3-grp-label">{label}</span>
            {clearLabel ? (
              <X size={12} aria-hidden className="v3-grp-clear" />
            ) : (
              <ChevronRight size={12} aria-hidden className="v3-grp-chev" data-open={collapsed ? undefined : '1'} />
            )}
          </button>
        </SidebarTip>
      )}
      {manageable && !renaming ? (
        <span className="v3-grp-actions">
          <IconButton
            variant="ghost"
            className="v3-grp-more"
            aria-label={own.projectMenu}
            onPress={() => setMenuOpen(true)}
            data-testid="v3-project-more"
          >
            <MoreHorizontal size={14} />
          </IconButton>
          <IconButton
            variant="ghost"
            className="v3-grp-add"
            aria-label={`${text.newInProject} · ${label}`}
            onPress={() => void createHere()}
            data-testid="v3-project-new"
          >
            <Plus size={14} />
          </IconButton>
        </span>
      ) : null}

      {manageable ? (
        <Popover triggerRef={rowRef} isOpen={menuOpen} onOpenChange={setMenuOpen} placement="bottom end" offset={4}>
          <Menu aria-label={own.projectMenu} autoFocus="first" onAction={(key) => run(key as MenuKey)} onClose={() => setMenuOpen(false)} data-testid="v3-project-menu">
            <MenuItem id="new" textValue={text.newInProject}>
              <Plus size={14} aria-hidden />
              {text.newInProject}
            </MenuItem>
            <MenuItem id="rename" textValue={t('rail.renameProject')}>
              <Pencil size={14} aria-hidden />
              {t('rail.renameProject')}
            </MenuItem>
            <MenuItem id="directory" textValue={t('rail.changeDirectory')}>
              <Replace size={14} aria-hidden />
              {t('rail.changeDirectory')}
            </MenuItem>
            <MenuItem id="reveal" textValue={t('rail.reveal')}>
              <FolderOpen size={14} aria-hidden />
              {t('rail.reveal')}
            </MenuItem>
            <MenuItem id="copy" textValue={t('rail.copyPath')}>
              <Link size={14} aria-hidden />
              {t('rail.copyPath')}
            </MenuItem>
            <MenuItem id="archive" textValue={t('rail.removeProject')} className="v3-menu-danger">
              <Archive size={14} aria-hidden />
              {t('rail.removeProject')}
            </MenuItem>
          </Menu>
        </Popover>
      ) : null}

      {record && directoryOpen ? <ProjectDirectoryDialog project={record} onClose={() => setDirectoryOpen(false)} /> : null}

      <ModalOverlay isDismissable isOpen={archiveOpen} onOpenChange={setArchiveOpen}>
        <Modal>
          <Dialog title={t('rail.removeProjectTitle')} closeLabel={text.cancel} data-testid="v3-project-archive">
            {({ close }) => (
              <ArchiveConfirm
                name={label}
                onCancel={close}
                onConfirm={async () => {
                  const target = record ?? (await ensureProjectForCwd(group.cwd))
                  if (!target) return false
                  const ok = await setProjectArchived(target.id, true)
                  if (ok) close()
                  return ok
                }}
              />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  )
}

export function ArchiveConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => Promise<boolean> }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="v3-confirm">
      <p className="v3-confirm-body">{t('rail.removeProjectExplain', { name })}</p>
      {error ? <Notice tone="fail" compact>{error}</Notice> : null}
      <div className="v3-confirm-actions">
        <Button variant="secondary" onPress={onCancel} isDisabled={busy}>{text.cancel}</Button>
        <Button
          variant="danger"
          isDisabled={busy}
          onPress={async () => {
            setBusy(true)
            setError('')
            const ok = await onConfirm()
            if (!ok) {
              setError(t('rail.removeProjectFailed'))
              setBusy(false)
            }
          }}
          data-testid="v3-project-archive-confirm"
        >
          {busy ? t('rail.removingProject') : t('rail.removeProjectAction')}
        </Button>
      </div>
    </div>
  )
}

export function ProjectDirectoryDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const [cwd, setCwd] = useState(project.cwd)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (close: () => void): Promise<void> => {
    if (busy || !cwd.trim()) return
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.changeProjectDirectory({ projectId: project.id, expectedCwd: project.cwd, cwd })
      if (!result.ok) {
        setError(result.error)
        return
      }
      useStore.getState().applyServerSettings(result.settings)
      void useStore.getState().refreshSessions()
      warnIfWorkspaceUnfit(cwd.trim(), t)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay isDismissable isOpen onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal>
        <Dialog title={t('rail.changeDirectory')} closeLabel={text.cancel} data-testid="v3-project-directory">
          {({ close }) => (
            <div className="v3-confirm">
              <p className="v3-confirm-body">{t('rail.directoryProject', { name: project.name || project.cwd })}</p>
              <p className="v3-confirm-body">{t('rail.directoryDescription')}</p>
              <label className="v3-field">
                <span className="v3-field-label">{t('rail.directoryOld')}</span>
                <input className="ui-input" value={project.cwd} readOnly tabIndex={-1} />
              </label>
              <label className="v3-field">
                <span className="v3-field-label">{t('rail.directoryNew')}</span>
                <span className="v3-field-row">
                  <input
                    className="ui-input"
                    value={cwd}
                    disabled={busy}
                    autoFocus
                    onChange={(event) => setCwd(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void save(close)
                      }
                    }}
                    data-testid="v3-project-directory-input"
                  />
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={async () => {
                      const selected = await window.yan.pickCwd().catch(() => null)
                      if (selected) setCwd(selected)
                    }}
                  >
                    {t('rail.directoryBrowse')}
                  </Button>
                </span>
              </label>
              {error ? <Notice tone="fail" compact data-testid="v3-project-directory-error">{error}</Notice> : null}
              <div className="v3-confirm-actions">
                <Button variant="secondary" onPress={close}>{text.cancel}</Button>
                <Button variant="primary" isDisabled={busy || !cwd.trim()} onPress={() => void save(close)} data-testid="v3-project-directory-save">
                  {busy ? t('rail.directorySaving') : t('rail.directorySave')}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
