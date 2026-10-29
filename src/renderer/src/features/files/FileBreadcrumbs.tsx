import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { IconButton, Menu, MenuItem, Popover, Separator } from '../../ui'
import type { DirEntry } from '../../../../shared/ipc'
import {
  breadcrumbChildDirs,
  breadcrumbCrumbs,
  breadcrumbParent,
  estimateCrumbWidth,
  foldBreadcrumbs,
  foldBreadcrumbsToWidth,
  type BreadcrumbCrumb
} from './breadcrumb-model'
import type { FilesText } from './files-text'
import './file-breadcrumbs.css'

export interface FileBreadcrumbsProps {
  rootLabel: string
  path: string
  text: FilesText
  label: string
  tail?: string
  browse?: boolean
  entries?: (path: string) => readonly DirEntry[] | null | undefined
  onBrowse?: (path: string) => void
  onNavigate: (path: string) => void
  className?: string
}

type OpenMenu = { kind: 'fold' } | { kind: 'children'; path: string }

const PARENT_KEY = 'go:parent'
const DIR_PREFIX = 'go:dir:'
const CRUMB_PREFIX = 'go:crumb:'

export function FileBreadcrumbs({
  rootLabel,
  path,
  text,
  label,
  tail,
  browse = false,
  entries,
  onBrowse,
  onNavigate,
  className
}: FileBreadcrumbsProps): ReactElement {
  const trail = useMemo(() => breadcrumbCrumbs(rootLabel, path), [rootLabel, path])
  const currentPath = trail[trail.length - 1]?.path ?? ''
  const [available, setAvailable] = useState(0)
  const reserve = tail ? estimateCrumbWidth(tail) + 16 : 0
  const folded = useMemo(
    () => (available > 0 ? foldBreadcrumbsToWidth(trail, available - reserve) : foldBreadcrumbs(trail)),
    [trail, available, reserve]
  )
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const browseRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)

  useEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const measure = (): void => setAvailable(list.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!browse || !restoreFocus.current) return undefined
    restoreFocus.current = false
    const frame = requestAnimationFrame(() => {
      const nodes = listRef.current?.querySelectorAll<HTMLElement>('[data-crumb-path]')
      if (nodes && nodes.length) nodes[nodes.length - 1].focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [browse, path])

  const navigate = useCallback(
    (next: string): void => {
      restoreFocus.current = browse
      onNavigate(next)
    },
    [browse, onNavigate]
  )

  const closeMenu = useCallback(
    (restore = true): void => {
      const anchor = anchorRef.current
      setMenu(null)
      if (browse && restore) requestAnimationFrame(() => anchor?.focus())
    },
    [browse]
  )

  const openChildren = useCallback(
    (dir: string, anchor: HTMLElement | null): void => {
      if (!anchor) return
      anchorRef.current = anchor
      onBrowse?.(dir)
      setMenu({ kind: 'children', path: dir })
    },
    [onBrowse]
  )

  const openFold = useCallback((anchor: HTMLElement): void => {
    anchorRef.current = anchor
    setMenu({ kind: 'fold' })
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!browse || event.defaultPrevented || event.nativeEvent.isComposing) return
    const holder = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-crumb-path]') : null
    if (event.key === 'ArrowLeft') {
      const parent = breadcrumbParent(currentPath)
      if (parent === null) return
      event.preventDefault()
      navigate(parent)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      openChildren(holder ? (holder.dataset.crumbPath ?? currentPath) : currentPath, holder ?? event.currentTarget)
    }
  }

  const crumbButton = (crumb: BreadcrumbCrumb, last: boolean): ReactElement => (
    <button
      type="button"
      className="v3-files-crumb"
      title={crumb.path || rootLabel}
      aria-current={last && !tail ? 'page' : undefined}
      data-crumb-path={crumb.path}
      data-testid={`v3-files-crumb-${crumb.path || 'root'}`}
      onClick={() => navigate(crumb.path)}
    >
      {crumb.label}
    </button>
  )

  const items: ReactElement[] = []
  let separator = false
  const pushItem = (key: string, content: ReactNode): void => {
    items.push(
      <li className="v3-files-crumb-item" key={key}>
        {separator ? <ChevronRight size={12} className="v3-files-crumb-sep" aria-hidden /> : null}
        {content}
      </li>
    )
    separator = true
  }

  folded.visible.forEach((crumb, index) => {
    if (index === 1 && folded.hidden.length) {
      pushItem(
        'fold',
        <button
          type="button"
          className="v3-files-crumb v3-files-crumb--fold"
          aria-label={text.breadcrumbMore}
          title={folded.hidden.map((item) => item.label).join(' / ')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'fold'}
          data-testid="v3-files-crumb-fold"
          onClick={(event: MouseEvent<HTMLButtonElement>) => openFold(event.currentTarget)}
        >
          <span aria-hidden>…</span>
        </button>
      )
    }
    pushItem(`crumb:${crumb.path}`, crumbButton(crumb, index === folded.visible.length - 1))
  })
  if (tail) {
    pushItem(
      'tail',
      <span className="v3-files-crumb v3-files-crumb--tail" aria-current="page" title={tail}>
        {tail}
      </span>
    )
  }

  const listing = menu?.kind === 'children' ? entries?.(menu.path) : undefined
  const children = menu?.kind === 'children' ? breadcrumbChildDirs(listing, menu.path) : []

  const runMenuAction = (key: Key): void => {
    const id = String(key)
    closeMenu(false)
    if (id === PARENT_KEY) {
      const parent = menu?.kind === 'children' ? breadcrumbParent(menu.path) : null
      if (parent !== null) navigate(parent)
      return
    }
    if (id.startsWith(DIR_PREFIX)) navigate(id.slice(DIR_PREFIX.length))
    else if (id.startsWith(CRUMB_PREFIX)) navigate(id.slice(CRUMB_PREFIX.length))
  }

  return (
    <nav
      className={className ? `v3-files-crumbs ${className}` : 'v3-files-crumbs'}
      aria-label={label}
      data-testid="v3-files-crumbs"
      onKeyDown={onKeyDown}
    >
      <ol className="v3-files-crumb-list" ref={listRef}>
        {items}
      </ol>
      {browse ? (
        <IconButton
          ref={browseRef}
          size="sm"
          className="v3-files-crumb-browse"
          aria-label={text.browseFolders}
          tooltip={text.browseFolders}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'children'}
          data-testid="v3-files-crumb-browse"
          onPress={() => openChildren(currentPath, browseRef.current)}
        >
          <ChevronDown size={12} />
        </IconButton>
      ) : null}
      {menu ? (
        <Popover
          triggerRef={anchorRef}
          isOpen
          onOpenChange={(open) => {
            if (!open) closeMenu()
          }}
          placement="bottom start"
          offset={4}
        >
          <Menu
            aria-label={menu.kind === 'fold' ? text.breadcrumbMore : text.browseFolders}
            autoFocus="first"
            onAction={runMenuAction}
            onClose={() => closeMenu()}
            data-testid={menu.kind === 'fold' ? 'v3-files-crumb-fold-menu' : 'v3-files-crumb-children'}
          >
            {menu.kind === 'fold'
              ? folded.hidden.map((crumb) => (
                  <MenuItem key={`${CRUMB_PREFIX}${crumb.path}`} id={`${CRUMB_PREFIX}${crumb.path}`} textValue={crumb.label}>
                    <span className="v3-files-crumb-menu-label" title={crumb.path}>
                      {crumb.label}
                    </span>
                  </MenuItem>
                ))
              : [
                  menu.path === '' ? null : (
                    <MenuItem key={PARENT_KEY} id={PARENT_KEY} textValue={text.backToParent} icon={<ArrowLeft size={14} />}>
                      {text.backToParent}
                    </MenuItem>
                  ),
                  menu.path === '' ? null : <Separator key="sep" />,
                  listing === undefined ? (
                    <MenuItem key="loading" id="state:loading" isDisabled textValue={text.loading}>
                      {text.loading}
                    </MenuItem>
                  ) : listing === null ? (
                    <MenuItem key="failed" id="state:failed" isDisabled textValue={text.subfoldersFailed}>
                      {text.subfoldersFailed}
                    </MenuItem>
                  ) : children.length === 0 ? (
                    <MenuItem key="empty" id="state:empty" isDisabled textValue={text.subfoldersEmpty}>
                      {text.subfoldersEmpty}
                    </MenuItem>
                  ) : (
                    children.map((child) => (
                      <MenuItem
                        key={`${DIR_PREFIX}${child.path}`}
                        id={`${DIR_PREFIX}${child.path}`}
                        textValue={child.label}
                        icon={<Folder size={14} />}
                      >
                        <span className="v3-files-crumb-menu-label" title={child.path}>
                          {child.label}
                        </span>
                      </MenuItem>
                    ))
                  )
                ]}
          </Menu>
        </Popover>
      ) : null}
    </nav>
  )
}
