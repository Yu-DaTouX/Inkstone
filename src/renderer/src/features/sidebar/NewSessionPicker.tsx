import { FolderOpen, FolderPlus, Search } from '../../ui/icons'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type RefObject } from 'react'
import type { ProjectRecord } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Dialog, InputGroup, InputGroupAddon, InputGroupInput, isImeComposing, KbdGroup, ListRow, Popover } from '../../ui'
import { ProjectFavicon } from '../../t3/components/ProjectFavicon'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import { openAddProjectPalette } from '../projects'
import { shortProject } from './sidebar-model'
import './new-session-picker.css'

const SHORTCUT_SLOTS = 9
const MOD_KEY = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

type PickerOption =
  | { kind: 'project'; project: ProjectRecord; label: string }
  | { kind: 'choose' }
  | { kind: 'create' }

interface Props {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onProject: (project: ProjectRecord) => void
  onStarted: () => void
  placement?: 'bottom start' | 'top end'
}

export function NewSessionPicker({ anchor, open, onOpenChange, onProject, onStarted, placement = 'bottom start' }: Props): ReactElement {
  return (
    <Popover variant="panel" className="new-session-picker" triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement={placement} offset={6}>
      <Dialog aria-label={useT()('sidebar.t3.newPicker.label')} showClose={false} body="flush">
        {() => <PickerBody close={() => onOpenChange(false)} onProject={onProject} onStarted={onStarted} />}
      </Dialog>
    </Popover>
  )
}

function PickerBody({ close, onProject, onStarted }: { close: () => void; onProject: Props['onProject']; onStarted: () => void }): ReactElement {
  const t = useT()
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const options = useMemo<PickerOption[]>(() => {
    const needle = query.trim().toLowerCase()
    const listed = (projects ?? [])
      .filter((project) => !project.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((project) => ({ kind: 'project' as const, project, label: project.name || projectNames?.[project.cwd] || shortProject(project.cwd) }))
      .filter((entry) => !needle || entry.label.toLowerCase().includes(needle) || entry.project.cwd.toLowerCase().includes(needle))
    return [...listed, { kind: 'choose' }, { kind: 'create' }]
  }, [projects, projectNames, query])

  const projectCount = options.filter((option) => option.kind === 'project').length
  const safeActive = Math.min(active, options.length - 1)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])
  const run = (option: PickerOption | undefined): void => {
    if (!option) return
    if (option.kind === 'project') {
      close()
      onProject(option.project)
    } else if (option.kind === 'choose') {
      close()
      void newSessionInPickedFolder(t).then((created) => { if (created) onStarted() })
    } else {
      close()
      openAddProjectPalette('new')
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const slot = /^[1-9]$/.test(event.key) && (event.ctrlKey || event.metaKey) ? Number(event.key) : 0
    if (slot) {
      event.preventDefault()
      if (slot <= Math.min(projectCount, SHORTCUT_SLOTS)) run(options[slot - 1])
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((safeActive + step + options.length) % options.length)
    } else if (event.key === 'Enter') {
      if (isImeComposing(event)) return
      event.preventDefault()
      run(options[safeActive])
    }
  }

  return (
    <div className="nsp" data-testid="v3-new-session-picker">
      <InputGroup variant="bare" className="nsp__search">
        <InputGroupAddon align="start">
          <Search size={14} aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          type="text"
          role="combobox"
          aria-label={t('sidebar.t3.newPicker.search')}
          aria-expanded="true"
          aria-controls="nsp-list"
          aria-autocomplete="list"
          aria-activedescendant={`nsp-opt-${safeActive}`}
          placeholder={t('sidebar.t3.newPicker.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          data-testid="v3-new-session-search"
        />
      </InputGroup>
      <div ref={listRef} id="nsp-list" className="nsp__list" role="listbox" aria-label={t('sidebar.t3.newPicker.title')}>
        <div className="nsp__group-label" aria-hidden="true">{t('sidebar.t3.newPicker.title')}</div>
        {projectCount === 0 ? <div className="nsp__empty">{t('sidebar.t3.newPicker.empty')}</div> : null}
        {options.map((option, index) => {
          const selected = index === safeActive
          const common = {
            id: `nsp-opt-${index}`,
            role: 'option',
            tabIndex: -1,
            'aria-selected': selected,
            'data-index': index,
            'data-active': selected ? 'true' : undefined,
            hoverHighlight: false,
            onMouseDown: (event: MouseEvent) => event.preventDefault(),
            onMouseMove: () => { if (index !== safeActive) setActive(index) },
            onClick: () => run(option)
          } as const
          if (option.kind === 'project') {
            return (
              <ListRow
                key={option.project.id}
                {...common}
                className="nsp__option nsp__option--project"
                icon={<ProjectFavicon project={{ projectId: option.project.id, displayName: option.label }} className="t3-favicon--lg" />}
                description={<span title={option.project.cwd}>{option.project.cwd}</span>}
                trailing={index < SHORTCUT_SLOTS ? <KbdGroup keys={[MOD_KEY, String(index + 1)]} /> : undefined}
              >
                {option.label}
              </ListRow>
            )
          }
          const isChoose = option.kind === 'choose'
          return (
            <ListRow
              key={option.kind}
              {...common}
              className={isChoose ? 'nsp__option nsp__option--first-action' : 'nsp__option'}
              icon={isChoose ? <FolderOpen size={15} /> : <FolderPlus size={15} />}
              data-testid={isChoose ? 'v3-new-session-choose' : 'v3-new-session-create'}
            >
              {t(isChoose ? 'sidebar.t3.newPicker.chooseFolder' : 'sidebar.t3.newPicker.newFolder')}
            </ListRow>
          )
        })}
      </div>
    </div>
  )
}
