import { Check, ChevronRight, FolderCog, FolderMinus, FolderOpen, FolderPlus, GitBranch, Layers, MoreHorizontal, Search } from '../../ui/icons'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { useT } from '../../i18n'
import { Dialog, InputGroup, InputGroupAddon, InputGroupInput, isImeComposing, ListRow, Popover } from '../../ui'
import { ProjectFavicon } from '../../t3/components/ProjectFavicon'
import { SidebarHeaderIconButton } from '../../t3/components/sidebar/SidebarThreadHeader'
import { NO_PROJECT_ID } from '../../t3/adapters/sidebar/types'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import { openAddProjectPalette } from '../projects'
import type { SidebarProjectView } from '../../t3/adapters/sidebar/types'
import './new-session-picker.css'

type FilterOption =
  | { kind: 'all' }
  | { kind: 'project'; project: SidebarProjectView }
  | { kind: 'none' }
  | { kind: 'archived-toggle'; count: number }
  | { kind: 'archived'; project: SidebarProjectView }
  | { kind: 'choose' }
  | { kind: 'create' }
  | { kind: 'more' }

const ACTIONS: FilterOption[] = [{ kind: 'choose' }, { kind: 'create' }, { kind: 'more' }]

interface Props {
  value: string | null
  projects: readonly SidebarProjectView[]
  onChange: (value: string | null) => void
  onManage: (projectId: string, anchor: HTMLElement) => void
  onAdd: () => void
  counts: ReadonlyMap<string, number>
}

export function FolderManager({ value, projects, onChange, onManage, onAdd, counts }: Props): ReactElement {
  const t = useT()
  const anchorRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const current = value && value !== NO_PROJECT_ID ? projects.find((project) => project.projectId === value) : undefined
  const label = value === null
    ? t('sidebar.t3.filter.label')
    : t('sidebar.t3.filter.active', { name: value === NO_PROJECT_ID ? t('sidebar.t3.filter.none') : (current?.displayName ?? '') })
  return (
    <>
      <SidebarHeaderIconButton
        label={label}
        data-active={value !== null ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="v3-project-filter"
        onPress={(event) => {
          anchorRef.current = event.target as HTMLElement
          setOpen(true)
        }}
      >
        {current ? (
          <ProjectFavicon project={{ projectId: current.projectId, displayName: current.displayName }} />
        ) : value === NO_PROJECT_ID ? (
          <FolderMinus />
        ) : (
          <FolderCog />
        )}
      </SidebarHeaderIconButton>
      <Popover variant="panel" className="new-session-picker" triggerRef={anchorRef} isOpen={open} onOpenChange={setOpen} placement="bottom start" offset={6}>
        <Dialog aria-label={t('sidebar.t3.filter.label')} showClose={false} body="flush">
          {() => (
            <FilterBody
              value={value}
              projects={projects}
              onPick={(next) => {
                setOpen(false)
                onChange(next)
              }}
              onManage={(projectId) => {
                setOpen(false)
                if (anchorRef.current) onManage(projectId, anchorRef.current)
              }}
              counts={counts}
              onAction={(kind) => {
                setOpen(false)
                if (kind === 'choose') void newSessionInPickedFolder(t)
                else if (kind === 'create') openAddProjectPalette('new')
                else onAdd()
              }}
            />
          )}
        </Dialog>
      </Popover>
    </>
  )
}

function FilterBody({ value, projects, onPick, onManage, onAction, counts }: {
  value: string | null
  projects: readonly SidebarProjectView[]
  onPick: (value: string | null) => void
  onManage: (projectId: string) => void
  onAction: (kind: 'choose' | 'create' | 'more') => void
  counts: ReadonlyMap<string, number>
}): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const options = useMemo<FilterOption[]>(() => {
    const needle = query.trim().toLowerCase()
    const matches = (project: SidebarProjectView): boolean =>
      !needle || project.displayName.toLowerCase().includes(needle) || project.workspaceRoot.toLowerCase().includes(needle)
    const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)
    const live = recent.filter((project) => !project.archived && matches(project))
    const archived = recent.filter((project) => project.archived && matches(project))
    const list: FilterOption[] = [{ kind: 'all' }, ...live.map((project) => ({ kind: 'project' as const, project }))]
    if ((counts.get(NO_PROJECT_ID) ?? 0) > 0 || value === NO_PROJECT_ID) list.push({ kind: 'none' })
    if (archived.length > 0) {
      list.push({ kind: 'archived-toggle', count: archived.length })
      if (archivedOpen || needle) list.push(...archived.map((project) => ({ kind: 'archived' as const, project })))
    }
    return [...list, ...ACTIONS]
  }, [archivedOpen, projects, query, counts, value])

  const safeActive = Math.min(active, options.length - 1)
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  const run = (option: FilterOption | undefined): void => {
    if (!option) return
    if (option.kind === 'all') onPick(null)
    else if (option.kind === 'none') onPick(NO_PROJECT_ID)
    else if (option.kind === 'project') onPick(option.project.projectId)
    else if (option.kind === 'archived-toggle') setArchivedOpen((previous) => !previous)
    else if (option.kind === 'choose' || option.kind === 'create' || option.kind === 'more') onAction(option.kind)
    else onManage(option.project.projectId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((safeActive + step + options.length) % options.length)
    } else if (event.key === 'Enter') {
      if (isImeComposing(event)) return
      event.preventDefault()
      run(options[safeActive])
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const option = options[safeActive]
      if (option?.kind === 'project' || option?.kind === 'archived') {
        event.preventDefault()
        onManage(option.project.projectId)
      }
    }
  }

  const selectedKey = value === null ? 'all' : value === NO_PROJECT_ID ? 'none' : value

  return (
    <div className="nsp" data-testid="v3-project-filter-panel">
      <InputGroup variant="bare" className="nsp__search">
        <InputGroupAddon align="start">
          <Search size={14} aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          type="text"
          role="combobox"
          aria-label={t('sidebar.t3.filter.search')}
          aria-expanded="true"
          aria-controls="pf-list"
          aria-autocomplete="list"
          aria-activedescendant={`pf-opt-${safeActive}`}
          placeholder={t('sidebar.t3.filter.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          data-testid="v3-project-filter-search"
        />
      </InputGroup>
      <div ref={listRef} id="pf-list" className="nsp__list" role="listbox" aria-label={t('sidebar.t3.filter.label')}>
        <div className="nsp__scroll">
        {options.slice(0, -ACTIONS.length).map((option, index) => {
          const selected = index === safeActive
          const common = {
            id: `pf-opt-${index}`,
            role: 'option',
            tabIndex: -1,
            'aria-selected': selected,
            'data-index': index,
            hoverHighlight: false,
            onMouseDown: (event: MouseEvent) => event.preventDefault(),
            onMouseMove: () => { if (index !== safeActive) setActive(index) },
            onClick: () => run(option)
          } as const
          const count = (key: string) => ((counts.get(key) ?? 0) > 0 ? <span className="nsp__count">{counts.get(key)}</span> : null)
          const check = (key: string) => (selectedKey === key ? <Check size={14} aria-label={t('sidebar.t3.filter.current')} /> : null)
          if (option.kind === 'all') {
            return <ListRow key="all" {...common} className="nsp__option" icon={<Layers size={15} />} trailing={check('all')} data-testid="v3-project-filter-all">{t('sidebar.t3.filter.all')}</ListRow>
          }
          if (option.kind === 'none') {
            return <ListRow key="none" {...common} className="nsp__option" icon={<FolderMinus size={15} />} trailing={<>{count(NO_PROJECT_ID)}{check('none')}</>} data-testid="v3-project-filter-none">{t('sidebar.t3.filter.none')}</ListRow>
          }
          if (option.kind === 'choose' || option.kind === 'create' || option.kind === 'more') return null
          if (option.kind === 'archived-toggle') {
            return (
              <ListRow key="archived-toggle" {...common} aria-expanded={archivedOpen || !!query.trim()} className="nsp__option nsp__option--first-action nsp__group-toggle" icon={<ChevronRight size={15} className="nsp__chevron" />} data-testid="v3-project-filter-archived">
                {t('sidebar.t3.filter.archived', { n: option.count })}
              </ListRow>
            )
          }
          const project = option.project
          return (
            <ListRow
              key={`${option.kind}:${project.projectId}`}
              {...common}
              className={option.kind === 'archived' ? 'nsp__option nsp__option--project nsp__option--manage nsp__option--muted' : 'nsp__option nsp__option--project nsp__option--manage'}
              icon={<ProjectFavicon project={{ projectId: project.projectId, displayName: project.displayName }} />}
              description={<span title={project.workspaceRoot}>{project.workspaceRoot}</span>}
              trailing={
                <>
                  {count(project.projectId)}
                  {option.kind === 'project' ? check(project.projectId) : null}
                  <span
                    role="button"
                    tabIndex={-1}
                    className="nsp__more"
                    aria-label={t('sidebar.t3.filter.manage', { name: project.displayName })}
                    data-testid="v3-project-filter-more"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onManage(project.projectId)
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden />
                  </span>
                </>
              }
            >
              {project.displayName}
            </ListRow>
          )
        })}
        </div>
        <div className="nsp__actions" role="group">
          {ACTIONS.map((option, offset) => {
            const index = options.length - ACTIONS.length + offset
            const kind = option.kind as 'choose' | 'create' | 'more'
            const Icon = kind === 'choose' ? FolderOpen : kind === 'create' ? FolderPlus : GitBranch
            const label = kind === 'choose' ? t('sidebar.t3.newPicker.chooseFolder') : kind === 'create' ? t('sidebar.t3.newPicker.newFolder') : t('sidebar.t3.folders.more')
            return (
              <ListRow
                key={kind}
                id={`pf-opt-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === safeActive}
                data-index={index}
                hoverHighlight={false}
                className="nsp__option nsp__action"
                icon={<Icon size={15} />}
                onMouseDown={(event: MouseEvent) => event.preventDefault()}
                onMouseMove={() => { if (index !== safeActive) setActive(index) }}
                onClick={() => run(option)}
                data-testid={`v3-folder-manager-${kind}`}
              >
                {label}
              </ListRow>
            )
          })}
        </div>
      </div>
    </div>
  )
}
