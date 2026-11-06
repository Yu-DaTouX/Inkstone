import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, LogIn, Monitor, MonitorSmartphone, Pin, PinOff, Plus, RotateCw, Smartphone, Tablet } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import {
  Button,
  CloseButton,
  EmptyState,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  MiddleTruncate,
  Notice,
  RailRow,
  SiteIcon,
  Splitter,
  TextField
} from '../../ui'
import { claimResource, releaseResource, resourceOwner } from '../../state/resource-owners'
import { addressTarget, isBlankAddress, nextAddressInput } from '../../../../shared/browser-navigation'
import type { BrowserPaneProps } from '../workbench/types'
import type { BrowserViewport } from '../../../../shared/ipc'
import { browserText } from './browser-text'
import { browserControlAllowed } from './ownership'
import { BrowserStartPage } from './BrowserStartPage'
import { LocalServerList } from './LocalServerList'
import { useBrowserBoundsSync, useBrowserOverlayBlocker, useBrowserSurfaceActive } from './use-browser-surface'
import './browser.css'

export type { BrowserPaneProps }

const TABS_PINNED_KEY = 'inkstone.browser.tabsPinned'
const START_PAGE_TOKEN = 'browser-start-page'
const VIEWPORTS: readonly BrowserViewport[] = ['responsive', 'mobile', 'tablet', 'desktop']
const VIEWPORT_ICONS = { responsive: MonitorSmartphone, mobile: Smartphone, tablet: Tablet, desktop: Monitor } as const
const TABS_WIDTH_KEY = 'inkstone.browser.tabsWidth'
const PEEK_TOKEN = 'browser-tabs-peek'
const PEEK_OPEN_MS = 380
const PEEK_CLOSE_MS = 300
const UNFREEZE_MS = 160
const TABS_WIDTH_MIN = 160
const TABS_WIDTH_MAX = 480
const TABS_WIDTH_DEFAULT = 240

function readTabsWidth(): number {
  try {
    const value = Number(localStorage.getItem(TABS_WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? Math.min(TABS_WIDTH_MAX, Math.max(TABS_WIDTH_MIN, value)) : TABS_WIDTH_DEFAULT
  } catch {
    return TABS_WIDTH_DEFAULT
  }
}

function writeTabsWidth(width: number): void {
  try {
    localStorage.setItem(TABS_WIDTH_KEY, String(Math.round(width)))
  } catch {
    return
  }
}

function readTabsPinned(): boolean {
  try {
    return localStorage.getItem(TABS_PINNED_KEY) === '1'
  } catch {
    return false
  }
}

function writeTabsPinned(pinned: boolean): void {
  try {
    localStorage.setItem(TABS_PINNED_KEY, pinned ? '1' : '0')
  } catch {
    return
  }
}

function tabHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function tabMarkName(url: string, host: string, title: string): string {
  if (!LOOPBACK_HOSTS.has(host)) return host
  if (title) return title
  try {
    return new URL(url).port || host
  } catch {
    return host
  }
}

function tabFavicon(url: string): string | null {
  try {
    const page = new URL(url)
    return page.protocol === 'http:' || page.protocol === 'https:' ? new URL('/favicon.ico', page.origin).href : null
  } catch {
    return null
  }
}

function Gate({ text, testId }: { text: string; testId: string }): ReactElement {
  return (
    <div className="v3-browser v3-browser--gate" data-testid={testId}>
      <EmptyState size="sm" role="status" title={text} />
    </div>
  )
}

export function BrowserPane({ owner, visible = true }: BrowserPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = browserText(lang)
  const state = useStore((s) => s.browserState)
  const openBrowser = useStore((s) => s.openBrowser)
  const viewportRef = useRef<HTMLDivElement>(null)

  const browserOwnerKey = resourceOwner('browser')
  const adoptable = owner.active && state.open && browserOwnerKey === undefined
  const driving = owner.active && state.open && !!state.agentSessionId && state.agentSessionId === owner.sessionId
  const staleKey = browserOwnerKey !== undefined && browserOwnerKey !== owner.key && (driving || (!!owner.sessionId && browserOwnerKey === owner.sessionId))
  useEffect(() => {
    if (staleKey) releaseResource('browser')
    if (adoptable || staleKey) claimResource('browser', owner.key)
  }, [adoptable, staleKey, owner.key])

  const owns = adoptable || staleKey || browserOwnerKey === owner.key
  const control = browserControlAllowed({
    owner,
    visible,
    browserOpen: state.open,
    browserOwnerKey: owns ? owner.key : browserOwnerKey
  })
  const controlRef = useRef(control)
  controlRef.current = control

  const inView = useBrowserBoundsSync(control, viewportRef)
  const surfaceActive = control && inView
  useBrowserSurfaceActive(surfaceActive, owner.key)
  useBrowserOverlayBlocker(surfaceActive)

  const startPage = control && state.mode !== 'external' && isBlankAddress(state.url)
  useEffect(() => {
    if (!startPage) return
    return useStore.getState().acquireOverlayBlocker(START_PAGE_TOKEN)
  }, [startPage])

  const [tabsPinned, setTabsPinned] = useState(readTabsPinned)
  const [tabsWidth, setTabsWidth] = useState(readTabsWidth)
  const [peek, setPeek] = useState(false)
  const [frozen, setFrozen] = useState<string | null>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const unfreezeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const peekSeq = useRef(0)
  const resizingTabs = useRef(false)
  const peeking = peek && !tabsPinned
  const tabsCollapsed = !tabsPinned && !peek
  const openPeek = async (): Promise<void> => {
    clearTimeout(peekTimer.current)
    clearTimeout(unfreezeTimer.current)
    const seq = ++peekSeq.current
    const shot = surfaceActive && !startPage ? await window.yan.browser.snapshot().catch(() => null) : null
    if (seq !== peekSeq.current) return
    setFrozen(shot)
    setPeek(true)
  }
  const closePeek = (): void => {
    clearTimeout(peekTimer.current)
    peekSeq.current++
    setPeek(false)
    clearTimeout(unfreezeTimer.current)
    unfreezeTimer.current = setTimeout(() => setFrozen(null), UNFREEZE_MS)
  }
  const schedulePeek = (open: boolean, delay: number): void => {
    clearTimeout(peekTimer.current)
    if (!open) peekSeq.current++
    peekTimer.current = setTimeout(() => (open ? void openPeek() : closePeek()), delay)
  }
  useEffect(() => () => {
    clearTimeout(peekTimer.current)
    clearTimeout(unfreezeTimer.current)
  }, [])
  useEffect(() => {
    if (!peeking || !surfaceActive) return
    return useStore.getState().acquireOverlayBlocker(PEEK_TOKEN)
  }, [peeking, surfaceActive])
  const nativeVisible = useStore((s) => s.browserNativeVisible)
  const cover = useStore((s) => s.browserCover)
  const [coverHeld, setCoverHeld] = useState(false)
  useEffect(() => {
    if (!nativeVisible) {
      setCoverHeld(true)
      return
    }
    const timer = setTimeout(() => setCoverHeld(false), UNFREEZE_MS)
    return () => clearTimeout(timer)
  }, [nativeVisible])
  const occludedShot = surfaceActive && !startPage && (!nativeVisible || coverHeld) ? cover : null
  const toggleTabs = (): void => {
    closePeek()
    setTabsPinned((prev) => {
      writeTabsPinned(!prev)
      return !prev
    })
  }
  const resizeTabs = (width: number): void => {
    setTabsWidth(width)
    writeTabsWidth(width)
  }

  const shownUrl = isBlankAddress(state.url) ? '' : state.url
  const [draft, setDraft] = useState(shownUrl)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [importStarting, setImportStarting] = useState(false)
  const [importId, setImportId] = useState<string | null>(null)
  const [importPhase, setImportPhase] = useState<'waiting' | 'importing'>('waiting')
  const [importNote, setImportNote] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null)
  const navSeq = useRef(0)

  useEffect(() => {
    if (!importNote) return
    const timer = setTimeout(() => setImportNote(null), importNote.tone === 'ok' ? 5000 : 10000)
    return () => clearTimeout(timer)
  }, [importNote])

  useEffect(() => {
    if (!importId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const status = await window.yan.browser.loginImportStatus(importId)
        if (!active) return
        if (status.phase === 'waiting' || status.phase === 'importing') {
          setImportPhase(status.phase)
          timer = setTimeout(() => void poll(), 500)
          return
        }
        setImportId(null)
        if (status.phase === 'done' && status.result) {
          const { copied, failed, skipped } = status.result
          setImportNote({ tone: failed ? 'fail' : 'ok', text: text.importDone(copied, failed, skipped) })
        } else if (status.phase === 'failed') setImportNote({ tone: 'fail', text: text.importError(status.error) })
      } catch {
        if (active) { setImportId(null); setImportNote({ tone: 'fail', text: text.importFailed }) }
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [importId, text])

  const importLogin = async (): Promise<void> => {
    if (importStarting || (importId && importPhase === 'importing')) return
    setImportStarting(true)
    setImportNote(null)
    try {
      if (importId) {
        const status = await window.yan.browser.cancelLoginImport(importId)
        if (status.phase === 'cancelled') setImportId(null)
        else if (status.phase === 'importing') setImportPhase('importing')
      } else {
        const { id } = await window.yan.browser.startLoginImport()
        setImportPhase('waiting')
        setImportId(id)
      }
    } catch { setImportNote({ tone: 'fail', text: text.importFailed }) }
    finally { setImportStarting(false) }
  }
  const importButton = (
    <Button variant="ghost" size="sm" className="v3-browser__import" aria-label={importId ? text.importCancel : text.importLogin} icon={<LogIn size={14} aria-hidden="true" />} tooltip={text.importHint} data-testid="browser-pane-import" isPending={importStarting || (!!importId && importPhase === 'importing')} onPress={() => void importLogin()}>
      <span className="v3-browser__import-label">{importId ? text.importCancel : text.importLogin}</span>
    </Button>
  )
  const importStatus = importId || importNote ? (
    <Notice
      tone={importId ? 'info' : importNote?.tone === 'ok' ? 'ok' : 'fail'}
      compact
      data-testid="browser-pane-import-note"
      action={!importId && importNote ? (
        <CloseButton aria-label={text.importDismiss} tooltip={text.importDismiss} data-testid="browser-pane-import-dismiss" onPress={() => setImportNote(null)} />
      ) : undefined}
    >
      {importId ? (importPhase === 'waiting' ? text.importWaiting : text.importing) : importNote?.text}
    </Notice>
  ) : null


  useEffect(() => {
    setDraft((prev) => nextAddressInput(shownUrl, prev, dirty))
  }, [shownUrl, dirty])

  useEffect(() => {
    setDirty(false)
    setError('')
    setImportNote(null)
  }, [owner.key])

  const ownerSessionId = owner.sessionId ?? 'workspace'
  useEffect(() => {
    if (!owner.active) return
    let current = true
    void window.yan.browser.activateSession(ownerSessionId).then((next) => {
      if (current) useStore.setState({ browserState: next })
    }).catch(() => undefined)
    return () => {
      current = false
    }
  }, [owner.active, ownerSessionId])

  const navigate = async (target?: string): Promise<void> => {
    if (!controlRef.current) return
    const value = addressTarget(target ?? draft, useStore.getState().settings?.browserSearchEngine)
    if (!value) return
    const seq = ++navSeq.current
    let ok = false
    let message: string | undefined
    try {
      const result = await window.yan.browser.navigate(value)
      ok = result.ok
      message = result.error
    } catch (cause) {
      if (seq === navSeq.current && controlRef.current) {
        setError(cause instanceof Error ? cause.message : t('browser.navigateError'))
      }
      return
    }
    if (seq !== navSeq.current || !controlRef.current) return
    setDirty(false)
    setError(ok ? '' : (message ?? t('browser.navigateError')))
  }

  const openHere = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    try {
      await openBrowser(undefined, { key: owner.key, takeover: true })
    } finally {
      setOpening(false)
    }
  }

  if (!owner.active) return <Gate text={text.inactive} testId="browser-pane-inactive" />
  if (!control) {
    if (!state.open && (!browserOwnerKey || browserOwnerKey === owner.key)) {
      return (
        <div className="v3-browser v3-browser--gate" data-testid="browser-pane-not-open">
          <EmptyState
            size="sm"
            role="status"
            title={text.notOpen}
            action={
              <Button
                variant="secondary"
                size="sm"
                data-testid="browser-pane-open"
                isPending={opening}
                onPress={() => void openHere()}
              >
                {opening ? text.opening : text.open}
              </Button>
            }
          />
          {importButton}
          {importStatus}
          <LocalServerList
            active={visible}
            onOpen={(url) => void openBrowser(url, { key: owner.key, takeover: true })}
          />
        </div>
      )
    }
    if (!owns) return <Gate text={text.foreignOwner} testId="browser-pane-foreign" />
    return <div className="v3-browser" data-testid="browser-pane-hidden" hidden />
  }

  const tabs = state.tabs ?? []
  const viewport: BrowserViewport = tabs.find((tab) => tab.id === state.activeTabId)?.viewport ?? 'responsive'
  const ViewportIcon = VIEWPORT_ICONS[viewport]
  const newTabButton = (
    <IconButton
      aria-label={t('browser.newTab')}
      tooltip={t('browser.newTab')}
      size="sm"
      data-testid="browser-pane-new-tab"
      onPress={() => {
        if (controlRef.current) void window.yan.browser.newTab()
      }}
    >
      <Plus size={14} aria-hidden="true" />
    </IconButton>
  )
  const collapseButton = (
    <IconButton
      aria-label={tabsPinned ? text.collapseTabs : text.expandTabs}
      tooltip={tabsPinned ? text.collapseTabs : text.expandTabs}
      size="sm"
      aria-pressed={tabsPinned}
      data-testid="browser-pane-tabs-toggle"
      onPress={toggleTabs}
    >
      {tabsPinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
    </IconButton>
  )
  const tabColumn = (
    <nav
      className="v3-browser__tabcol"
      aria-label={text.tabLabel}
      data-testid="browser-pane-tabs"
      data-collapsed={tabsCollapsed ? '1' : undefined}
      data-peek={peeking ? '1' : undefined}
      onPointerEnter={() => {
        if (tabsPinned) return
        if (peek) clearTimeout(peekTimer.current)
        else schedulePeek(true, PEEK_OPEN_MS)
      }}
      onPointerLeave={() => {
        if (tabsPinned || resizingTabs.current) return
        if (peek) schedulePeek(false, PEEK_CLOSE_MS)
        else {
          clearTimeout(peekTimer.current)
          peekSeq.current++
        }
      }}
      onFocus={() => {
        if (!tabsPinned && !peek) void openPeek()
      }}
      onBlur={(event) => {
        if (!tabsPinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) closePeek()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && peeking) {
          event.stopPropagation()
          closePeek()
        }
      }}
    >
      {tabsCollapsed ? null : (
        <Splitter
          className="v3-browser__tabcol-resize ui-splitter--edge"
          orientation="vertical"
          value={tabsWidth}
          min={TABS_WIDTH_MIN}
          max={TABS_WIDTH_MAX}
          step={8}
          aria-label={text.resizeTabs}
          data-testid="browser-pane-tabs-resize"
          onPointerDownCapture={() => {
            resizingTabs.current = true
            window.addEventListener('pointerup', () => { resizingTabs.current = false }, { once: true, capture: true })
          }}
          onChange={resizeTabs}
          onReset={() => resizeTabs(TABS_WIDTH_DEFAULT)}
        />
      )}
      <div className="v3-browser__tabcol-head">
        {tabsCollapsed ? null : <span className="v3-browser__tabcol-title">{t('browser.tabs')}</span>}
        {newTabButton}
      </div>
      <ul className="v3-browser__tablist">
        {tabs.map((tab) => {
          const blank = isBlankAddress(tab.url)
          const title = isBlankAddress(tab.title) ? '' : tab.title
          const label = title || (blank ? t('browser.newTab') : tab.url)
          const host = blank ? '' : tabHost(tab.url)
          return (
            <RailRow
              key={tab.id}
              label={label}
              iconOnly={tabsCollapsed}
              title={!blank && tab.url !== label ? `${label}\n${tab.url}` : label}
              icon={host ? <SiteIcon name={tabMarkName(tab.url, host, title)} src={tabFavicon(tab.url)} className="v3-browser__tab-mark" /> : <Globe size={14} aria-hidden="true" />}
              selected={tab.id === state.activeTabId}
              actionReveal="hover"
              data-testid={`browser-pane-tab-${tab.id}`}
              buttonProps={{ 'data-testid': `browser-pane-tab-select-${tab.id}` }}
              onPress={() => {
                if (controlRef.current && tab.id !== state.activeTabId) void window.yan.browser.switchTab(tab.id)
              }}
              action={
                <CloseButton
                  aria-label={t('browser.closeTab')}
                  tooltip={t('browser.closeTab')}
                  data-testid={`browser-pane-tab-close-${tab.id}`}
                  onPress={() => {
                    if (controlRef.current) void window.yan.browser.closeTab(tab.id)
                  }}
                />
              }
            />
          )
        })}
      </ul>
      <LocalServerList
        active={visible}
        compact
        iconOnly={tabsCollapsed}
        onOpen={(url) => {
          if (controlRef.current) void window.yan.browser.newTab(url)
        }}
      />
      <div className="v3-browser__tabcol-foot">
        {importButton}
        {collapseButton}
      </div>
    </nav>
  )

  return (
    <div
      className="v3-browser v3-browser--split"
      data-testid="browser-pane"
      data-active={surfaceActive ? '1' : '0'}
      data-tabs-collapsed={tabsCollapsed ? '1' : undefined}
      data-tabs-pinned={tabsPinned ? '1' : undefined}
      style={{ '--tabs-w': `${tabsWidth}px` } as CSSProperties}
    >
      {tabColumn}
      <div className="v3-browser__main">

      <div className="v3-browser__toolbar">
        <IconButton
          aria-label={t('browser.back')}
          tooltip={t('browser.back')}
          data-testid="browser-pane-back"
          isDisabled={!state.canGoBack}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.back()
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.forward')}
          tooltip={t('browser.forward')}
          data-testid="browser-pane-forward"
          isDisabled={!state.canGoForward}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.forward()
          }}
        >
          <ArrowRight size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.reload')}
          tooltip={t('browser.reload')}
          data-testid="browser-pane-reload"
          onPress={() => {
            if (controlRef.current) void window.yan.browser.reload()
          }}
        >
          <RotateCw size={14} aria-hidden="true" />
        </IconButton>

        <form
          className="v3-browser__address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate()
          }}
        >
          <TextField
            className="v3-browser__address-field"
            aria-label={t('browser.address')}
            value={draft}
            onChange={(value) => {
              setDraft(value)
              setDirty(true)
            }}
          >
            <InputGroup>
              <InputGroupAddon align="start">
                <Globe size={14} aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t('browser.address')}
                data-testid="browser-pane-address"
                spellCheck={false}
                autoComplete="off"
              />
            </InputGroup>
          </TextField>
        </form>

        <IconButton
          aria-label={t('browser.openExternal')}
          tooltip={t('browser.openExternal')}
          data-testid="browser-pane-open-external"
          isDisabled={!shownUrl}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.openExternal(state.url || draft)
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </IconButton>
        <MenuTrigger>
          <IconButton aria-label={`${text.viewport}: ${text.viewportNames[viewport]}`} tooltip={`${text.viewport}: ${text.viewportNames[viewport]}`} aria-pressed={viewport !== 'responsive'} data-testid="browser-pane-viewport-menu">
            <ViewportIcon size={14} aria-hidden="true" />
          </IconButton>
          <Popover placement="bottom end">
            <Menu
              aria-label={text.viewport}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[viewport]}
              onAction={(key) => {
                if (controlRef.current) void window.yan.browser.setViewport(String(key) as BrowserViewport)
              }}
            >
              {VIEWPORTS.map((item) => (
                <MenuItem key={item} id={item} textValue={text.viewportNames[item]} data-testid={`browser-pane-viewport-${item}`}>
                  {text.viewportNames[item]}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      </div>

      {importStatus ? <div className="v3-browser__status">{importStatus}</div> : null}

      {state.loading || state.loadError || error ? (
        <div className="v3-browser__status" data-testid="browser-pane-status" role="status">
          {state.loading ? (
            <Notice variant="hint" loading>
              {t('browser.loading')}
            </Notice>
          ) : null}
          {state.loadError ? (
            <Notice
              tone="fail"
              compact
              data-testid="browser-pane-load-error"
              action={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="browser-pane-retry"
                    onPress={() => void navigate(state.loadError?.url)}
                  >
                    {t('browser.retry')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="browser-pane-error-external"
                    onPress={() => {
                      if (controlRef.current) {
                        void window.yan.browser.openExternal(state.loadError?.url ?? state.url)
                      }
                    }}
                  >
                    {t('browser.openExternal')}
                  </Button>
                </>
              }
            >
              <span title={state.loadError.description}>
                {t('browser.pageFailed')}
              </span>
              <MiddleTruncate className="v3-browser__error-url" value={state.loadError.url} data-testid="browser-pane-error-url" />
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="fail" compact>
              {error}
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div
        className="v3-browser__viewport"
        ref={viewportRef}
        aria-label={text.viewportLabel}
        data-testid="browser-pane-viewport"
      >
        {frozen ?? occludedShot ? <img className="v3-browser__frozen" src={frozen ?? occludedShot ?? undefined} alt="" aria-hidden="true" draggable={false} /> : null}
        {startPage ? (
          <BrowserStartPage tabId={state.activeTabId} text={text} onSubmit={(value) => void navigate(value)} />
        ) : null}
      </div>
      </div>
    </div>
  )
}
