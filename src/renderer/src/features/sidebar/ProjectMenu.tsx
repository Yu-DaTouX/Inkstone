import { Archive, ArchiveRestore, FolderOpen, Link, Palette, Pencil, Plus, Replace, Type } from 'lucide-react'
import { useEffect, useState, type ReactElement, type RefObject } from 'react'
import type { ProjectRecord } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, Menu, MenuItem, Modal, ModalOverlay, Notice, Popover, SubmenuTrigger } from '../../ui'
import { normalizeIconText, PROJECT_ICON_COLORS, projectIconLook } from '../../patterns/project-icon'
import { v3Text } from '../../app/v3-text'
import { ArchiveConfirm, ProjectDirectoryDialog, setProjectArchived } from './ProjectHeader'
import { shortProject } from './sidebar-model'
import { sidebarText } from './sidebar-text'

interface Props {
  project: ProjectRecord
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onNew: () => void
}

export function ProjectMenu({ project, anchor, open, onOpenChange, onNew }: Props): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const [dialog, setDialog] = useState<'rename' | 'directory' | 'archive' | 'icon-text' | null>(null)
  const [ready, setReady] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = project.name || useStore.getState().settings?.projectNames[project.cwd] || shortProject(project.cwd)
  const projects = useStore((s) => s.settings?.projects)
  const autoLook = projectIconLook((projects ?? []).map((item) => item.id === project.id ? { ...item, iconColor: undefined } : item), project.id, label)

  const saveIcon = async (patch: Pick<ProjectRecord, 'iconColor' | 'iconText'>): Promise<boolean> => {
    try {
      const state = useStore.getState()
      await state.patchSettings({
        projects: (state.settings?.projects ?? []).map((item) => {
          if (item.id !== project.id) return item
          const next: ProjectRecord = { ...item, ...patch, updatedAt: Date.now() }
          if (!next.iconColor) delete next.iconColor
          if (!next.iconText) delete next.iconText
          return next
        })
      })
      return true
    } catch {
      useStore.getState().notify('error', own.iconSaveFailed)
      return false
    }
  }

  const saveIconText = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    const ok = await saveIcon({ iconText: normalizeIconText(name) || undefined })
    setBusy(false)
    if (ok) setDialog(null)
    else setError(own.iconSaveFailed)
  }

  useEffect(() => {
    setReady(false)
    if (!dialog || open) return undefined
    let frame = 0
    const settle = (): void => {
      if (document.querySelector('.ui-popover')) frame = requestAnimationFrame(settle)
      else setReady(true)
    }
    frame = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(frame)
  }, [dialog, open])

  const saveName = async (): Promise<void> => {
    const next = name.trim()
    if (!next || busy) return
    setBusy(true)
    setError('')
    try {
      const state = useStore.getState()
      await state.patchSettings({
        projectNames: { ...state.settings?.projectNames, [project.cwd]: next },
        projects: (state.settings?.projects ?? []).map((item) => item.id === project.id ? { ...item, name: next, updatedAt: Date.now() } : item)
      })
      setDialog(null)
    } catch {
      setError(t('rail.renameFailed', { name: next }))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Popover triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement="bottom end" offset={4}>
      <Menu key={project.archived ? 'archived' : 'active'} aria-label={own.projectMenu} autoFocus="first" onClose={() => onOpenChange(false)} onAction={(key) => {
        onOpenChange(false)
        setError('')
        if (key === 'new') onNew()
        else if (key === 'rename') { setName(label); setDialog('rename') }
        else if (key === 'icon-text') { setName(project.iconText ?? ''); setDialog('icon-text') }
        else if (key === 'directory') setDialog('directory')
        else if (key === 'archive') setDialog('archive')
        else if (key === 'restore') void setProjectArchived(project.id, false).then((ok) => { if (!ok) useStore.getState().notify('error', own.restoreProjectFailed) })
        else if (key === 'reveal') void window.yan.revealPath(project.cwd).catch((cause) => useStore.getState().notify('error', String(cause)))
        else if (key === 'copy') void navigator.clipboard.writeText(project.cwd).catch((cause) => useStore.getState().notify('error', String(cause)))
      }} data-testid="v3-project-menu">
        {!project.archived ? <MenuItem id="new" icon={<Plus size={14} />}>{text.newInProject}</MenuItem> : null}
        <MenuItem id="rename" icon={<Pencil size={14} />}>{t('rail.renameProject')}</MenuItem>
        <SubmenuTrigger>
          <MenuItem id="icon-color" textValue={own.iconColor} icon={<Palette size={14} />} data-testid="v3-project-icon-color">{own.iconColor}</MenuItem>
          <Popover placement="end top" offset={2}>
            <Menu aria-label={own.iconColor} data-testid="v3-project-icon-colors" onAction={(key) => {
              onOpenChange(false)
              const tone = key === 'auto' ? undefined : Number(String(key).slice(5))
              void saveIcon({ iconColor: tone, iconText: project.iconText })
            }}>
              <MenuItem id="auto" textValue={own.iconColorAuto} icon={<IconSwatch tone={autoLook.tone} />} checked={!project.iconColor}>{own.iconColorAuto}</MenuItem>
              {PROJECT_ICON_COLORS.map((tone) => (
                <MenuItem key={tone} id={`tone-${tone}`} textValue={own.iconColorOption.replace('{n}', String(tone))} icon={<IconSwatch tone={tone} />} checked={project.iconColor === tone}>
                  {own.iconColorOption.replace('{n}', String(tone))}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </SubmenuTrigger>
        <MenuItem id="icon-text" icon={<Type size={14} />} data-testid="v3-project-icon-text">{own.iconText}</MenuItem>
        <MenuItem id="directory" icon={<Replace size={14} />}>{t('rail.changeDirectory')}</MenuItem>
        <MenuItem id="reveal" icon={<FolderOpen size={14} />}>{t('rail.reveal')}</MenuItem>
        <MenuItem id="copy" icon={<Link size={14} />}>{t('rail.copyPath')}</MenuItem>
        {project.archived
          ? <MenuItem id="restore" icon={<ArchiveRestore size={14} />}>{own.restoreProject}</MenuItem>
          : <MenuItem id="archive" tone="danger" icon={<Archive size={14} />}>{t('rail.removeProject')}</MenuItem>}
      </Menu>
    </Popover>
    {dialog === 'directory' && ready ? <ProjectDirectoryDialog project={project} onClose={() => setDialog(null)} /> : null}
    <ModalOverlay isDismissable={!busy} isOpen={ready && (dialog === 'rename' || dialog === 'archive' || dialog === 'icon-text')} onOpenChange={(next) => { if (!next) setDialog(null) }}>
      <Modal>
        <Dialog title={dialog === 'icon-text' ? own.iconText.replace('…', '') : t(dialog === 'archive' ? 'rail.removeProjectTitle' : 'rail.renameProject')} closeLabel={text.cancel} data-testid={dialog === 'archive' ? 'v3-project-archive' : dialog === 'icon-text' ? 'v3-project-icon-text-dialog' : 'v3-project-rename'}>
          {({ close }) => dialog === 'icon-text'
            ? <form className="v3-confirm" onSubmit={(event) => { event.preventDefault(); void saveIconText() }}>
                <p>{own.iconTextHint}</p>
                <input className="ui-input" autoFocus aria-label={own.iconText} placeholder={autoLook.text} value={name} disabled={busy} onChange={(event) => setName(normalizeIconText(event.target.value))} data-testid="v3-project-icon-text-input" />
                {error ? <Notice tone="fail" compact>{error}</Notice> : null}
                <DialogFooter>
                  <Button variant="secondary" onPress={() => { setName('') }} isDisabled={busy || !name}>{own.iconTextReset}</Button>
                  <Button variant="secondary" onPress={close} isDisabled={busy}>{text.cancel}</Button>
                  <Button variant="primary" type="submit" isDisabled={busy}>{t('auth.save')}</Button>
                </DialogFooter>
              </form>
            : dialog === 'archive'
            ? <ArchiveConfirm name={label} onCancel={close} onConfirm={async () => { const ok = await setProjectArchived(project.id, true); if (ok) close(); return ok }} />
            : <form className="v3-confirm" onSubmit={(event) => { event.preventDefault(); void saveName() }}>
                <input className="ui-input" autoFocus aria-label={t('rail.renameProject')} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} data-testid="v3-project-name-input" />
                {error ? <Notice tone="fail" compact>{error}</Notice> : null}
                <DialogFooter>
                  <Button variant="secondary" onPress={close} isDisabled={busy}>{text.cancel}</Button>
                  <Button variant="primary" type="submit" isDisabled={busy || !name.trim()}>{t('auth.save')}</Button>
                </DialogFooter>
              </form>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  </>
}

function IconSwatch({ tone }: { tone: number }): ReactElement {
  return <span aria-hidden className="inline-block size-3 rounded-[3px]" style={{ backgroundColor: `var(--data-${tone})` }} />
}
