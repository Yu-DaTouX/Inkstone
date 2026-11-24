import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, Camera, ExternalLink, Globe, LogIn, Monitor, MonitorSmartphone, Plus, RotateCw, Server, Smartphone, Tablet, X } from '../../ui/icons'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import {
  Button,
  CloseButton,
  Dialog,
  DialogTrigger,
  EmptyState,
  Header,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  MiddleTruncate,
  Notice,
  PanelTab,
  PanelTabList,
  SiteIcon,
  Spinner,
  TextField,
  showToast
} from '../../ui'
import { imageAttachmentFromDataUrl, sendToChat } from '../preview/canvas-share'
import { claimResource, releaseResource, resourceOwner } from '../../state/resource-owners'
import { addressShown, addressTarget, isBlankAddress, nextAddressInput, nextAddressMemory, type AddressMemory } from '../../../../shared/browser-navigation'
import type { BrowserPaneProps } from '../workbench/types'
import { BROWSER_VIEWPORT_PRESETS, browserViewportPreset, isBrowserViewport, type BrowserViewport } from '../../../../shared/browser-viewport'
import { browserText } from './browser-text'
import { browserControlAllowed } from './ownership'
import { BrowserStartPage } from './BrowserStartPage'
import { LocalServerList } from './LocalServerList'
import { useBrowserBoundsSync, useBrowserOverlayBlocker, useBrowserSurfaceActive } from './use-browser-surface'
import './browser.css'

export type { BrowserPaneProps }

const START_PAGE_TOKEN = 'browser-start-page'
const LOAD_ERROR_TOKEN = 'browser-load-error'
const VIEWPORTS = ['responsive', ...Object.keys(BROWSER_VIEWPORT_PRESETS)].filter(isBrowserViewport)
const VIEWPORT_ICONS = { responsive: MonitorSmartphone, mobile: Smartphone, tablet: Tablet, desktop: Monitor } as const
const UNFREEZE_MS = 160

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
  const [shooting, setShooting] = useState(false)
  const shotToChat = async (): Promise<void> => {
    if (!controlRef.current) return
    setShooting(true)
    try {
      const dataUrl = await window.yan.browser.snapshot().catch(() => null)
      const image = dataUrl ? imageAttachmentFromDataUrl(dataUrl, 'browser') : null
      if (!image) showToast(text.shotFailed, { tone: 'danger' })
      else if (!sendToChat({ images: [image] })) showToast(text.shotNoComposer, { tone: 'danger' })
    } finally {
      setShooting(false)
    }
  }

  const inView = useBrowserBoundsSync(control, viewportRef)
  const surfaceActive = control && inView
  useBrowserSurfaceActive(surfaceActive, owner.key)
  useBrowserOverlayBlocker(surfaceActive, viewportRef)

  const startPage = control && state.mode !== 'external' && isBlankAddress(state.url)
  useEffect(() => {
    if (!startPage) return
    return useStore.getState().acquireOverlayBlocker(START_PAGE_TOKEN)
  }, [startPage])
  const loadFailed = control && state.mode !== 'external' && !!state.loadError
  const failureReason = state.loadError ? text.loadFailureReason(state.loadError) : null
  useEffect(() => {
    if (!loadFailed) return
    return useStore.getState().acquireOverlayBlocker(LOAD_ERROR_TOKEN)
  }, [loadFailed])

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
  const occludedShot = surfaceActive && !startPage && !loadFailed && (!nativeVisible || coverHeld) ? cover : null
  const shownUrl = isBlankAddress(state.url) ? '' : state.url
  const [draft, setDraft] = useState(shownUrl)
  const [dirty, setDirty] = useState(false)
  const activeTabId = state.activeTabId ?? null
  const hasLoadError = !!state.loadError
  const memoryRef = useRef<AddressMemory>({ requested: null, restored: null })
  const [addressMemory, setAddressMemory] = useState<AddressMemory>(memoryRef.current)
  const addressUrl = addressShown(shownUrl, addressMemory, activeTabId)
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
    <Button variant="ghost" size="sm" className="v3-browser__import" aria-label={importId ? text.importCancel : text.importLogin} icon={<LogIn size={14} aria-hidden="true" />} tooltip={importId ? text.importCancel : text.importLogin} data-testid="browser-pane-import" isPending={importStarting || (!!importId && importPhase === 'importing')} onPress={() => void importLogin()}>
      <span className="v3-browser__import-label">{importId ? text.importCancel : text.importLogin}</span>
    </Button>
  )
  const importStatus = importId || importNote ? (
    <Notice
      tone={importId ? 'info' : importNote?.tone === 'ok' ? 'ok' : 'fail'}
      compact
      className="v3-browser__import-note"
      data-testid="browser-pane-import-note"
      action={!importId && importNote ? (
        <CloseButton aria-label={text.importDismiss} tooltip={text.importDismiss} data-testid="browser-pane-import-dismiss" onPress={() => setImportNote(null)} />
      ) : undefined}
    >
      {importId ? (
        importPhase === 'waiting' ? (
          <span className="v3-browser__import-text">
            <span>{text.importWaiting}</span>
            <span className="v3-browser__import-detail">{text.importHint}</span>
          </span>
        ) : text.importing
      ) : importNote?.text}
    </Notice>
  ) : null


  useEffect(() => {
    setDraft((prev) => nextAddressInput(addressUrl, prev, dirty))
  }, [addressUrl, dirty])

  useEffect(() => {
    const next = nextAddressMemory(memoryRef.current, { loading: !!state.loading, shownUrl, tabId: activeTabId, failed: hasLoadError })
    memoryRef.current = next
    setAddressMemory((prev) => (prev.restored === next.restored ? prev : next))
  }, [state.loading, shownUrl, activeTabId, hasLoadError])

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

  const restoreAddress = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape' || (!dirty && draft === addressUrl)) return
    event.preventDefault()
    event.stopPropagation()
    navSeq.current++
    setDirty(false)
    setDraft(addressUrl)
    setError('')
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
          <div className="v3-browser__gate-main">
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
          </div>
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
  const ViewportIcon = VIEWPORT_ICONS[browserViewportPreset(viewport)?.group ?? 'responsive']
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
  const selectBrowserTab = (id: string): void => {
    if (controlRef.current && id !== state.activeTabId) void window.yan.browser.switchTab(id)
  }
  const closeBrowserTab = (id: string): void => {
    if (controlRef.current) void window.yan.browser.closeTab(id)
  }
  const tabEntries = tabs.map((tab) => {
    const blank = isBlankAddress(tab.url)
    const title = isBlankAddress(tab.title) ? '' : tab.title
    const label = title || (blank ? t('browser.newTab') : tab.url)
    const host = blank ? '' : tabHost(tab.url)
    return {
      id: tab.id,
      label,
      title: !blank && tab.url !== label ? `${label}\n${tab.url}` : label,
      icon: host ? <SiteIcon name={tabMarkName(tab.url, host, title)} src={tabFavicon(tab.url)} className="v3-browser__tab-mark" /> : <Globe size={14} aria-hidden="true" />
    }
  })
  const tabRow = (
    <nav className="v3-browser__tabrow" aria-label={text.tabLabel} data-testid="browser-pane-tabs">
      <PanelTabList label={text.tabLabel} className="v3-browser__htabs" data-testid="browser-pane-htabs" onCloseFocused={closeBrowserTab}>
        {tabEntries.map((tab) => (
          <PanelTab
            key={tab.id}
            id={tab.id}
            label={tab.label}
            title={tab.title}
            icon={tab.icon}
            active={tab.id === state.activeTabId}
            closeLabel={t('browser.closeTab')}
            testId={`browser-pane-tab-${tab.id}`}
            onSelect={() => selectBrowserTab(tab.id)}
            onClose={() => closeBrowserTab(tab.id)}
          />
        ))}
      </PanelTabList>
      {newTabButton}
      <DialogTrigger>
        <IconButton aria-label={t('browser.localServers')} tooltip={t('browser.localServers')} size="sm" data-testid="browser-pane-servers-menu">
          <Server size={14} aria-hidden="true" />
        </IconButton>
        <Popover variant="panel" surface="solid" placement="bottom end" className="v3-browser__servers-pop">
          <Dialog aria-label={t('browser.localServers')} showClose={false} padding="none">
            {({ close }) => (
              <LocalServerList
                active={visible}
                compact
                onOpen={(url) => {
                  close()
                  if (controlRef.current) void window.yan.browser.newTab(url)
                }}
              />
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
      {importButton}
    </nav>
  )
  return (
    <div
      className="v3-browser v3-browser--split"
      data-testid="browser-pane"
      data-active={surfaceActive ? '1' : '0'}
      data-layout="horizontal"
    >
      {tabRow}
      <div className="v3-browser__main">

      <div className="v3-browser__toolbar" data-testid="browser-pane-toolbar">
        <IconButton
          size="sm"
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
          size="sm"
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
          size="sm"
          aria-label={state.loading ? t('browser.stop') : t('browser.reload')}
          tooltip={state.loading ? t('browser.stop') : t('browser.reload')}
          tooltipPlacement="left"
          data-testid={state.loading ? 'browser-pane-stop' : 'browser-pane-reload'}
          onPress={() => {
            if (!controlRef.current) return
            if (state.loading) void window.yan.browser.stop()
            else void window.yan.browser.reload()
          }}
        >
          {state.loading ? <X size={14} aria-hidden="true" /> : <RotateCw size={14} aria-hidden="true" />}
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
            <InputGroup size="sm">
              <InputGroupAddon align="start" className="v3-browser__address-icon">
                {state.loading ? <Spinner size="sm" label={t('browser.loading')} /> : <Globe size={14} aria-hidden="true" />}
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t('browser.address')}
                data-testid="browser-pane-address"
                spellCheck={false}
                autoComplete="off"
                onKeyDown={restoreAddress}
              />
            </InputGroup>
          </TextField>
        </form>

        <IconButton
          size="sm"
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
        <IconButton
          size="sm"
          aria-label={text.shotToChat}
          tooltip={text.shotToChat}
          data-testid="browser-pane-shot"
          isDisabled={!shownUrl || shooting}
          onPress={() => void shotToChat()}
        >
          <Camera size={14} aria-hidden="true" />
        </IconButton>
        <MenuTrigger>
          <IconButton size="sm" aria-label={text.viewMenuValue(text.viewportName(viewport))} tooltip={text.viewMenuValue(text.viewportName(viewport))} tooltipPlacement="left" aria-pressed={viewport !== 'responsive'} data-testid="browser-pane-viewport-menu">
            <ViewportIcon size={14} aria-hidden="true" />
          </IconButton>
          <Popover placement="bottom end" surface="solid">
            <Menu aria-label={text.viewMenu}>
              <MenuSection
                id="viewport"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[viewport]}
                onSelectionChange={(keys) => {
                  const key = keys === 'all' ? null : [...keys][0]
                  if (isBrowserViewport(key) && controlRef.current) void window.yan.browser.setViewport(key)
                }}
              >
                <Header>{text.viewport}</Header>
                {VIEWPORTS.map((item) => (
                  <MenuItem key={item} id={item} textValue={text.viewportName(item)} data-testid={`browser-pane-viewport-${item}`}>
                    {text.viewportName(item)}
                  </MenuItem>
                ))}
              </MenuSection>
            </Menu>
          </Popover>
        </MenuTrigger>
      </div>

      {importStatus ? <div className="v3-browser__status">{importStatus}</div> : null}

      {state.loadError || error ? (
        <div className="v3-browser__status" data-testid="browser-pane-status" role="status">
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
              <span title={state.loadError.description} data-testid="browser-pane-error-title">
                {t('browser.pageFailed')}
              </span>
              {failureReason ? (
                <span className="v3-browser__error-reason" data-testid="browser-pane-error-reason">
                  {failureReason}
                </span>
              ) : null}
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
        {occludedShot ? <img className="v3-browser__frozen" src={occludedShot} alt="" aria-hidden="true" draggable={false} /> : null}
        {startPage ? (
          <BrowserStartPage tabId={state.activeTabId} text={text} onSubmit={(value) => void navigate(value)} />
        ) : null}
      </div>
      </div>
    </div>
  )
}
