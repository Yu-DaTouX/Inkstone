import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LogIn, Plus, RotateCw, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, EmptyState, Input, IconButton, Notice, Tab, TabList, Tabs, TextField } from '../../ui'
import { claimResource, releaseResource, resourceOwner } from '../../state/resource-owners'
import { nextAddressInput } from '../../../../shared/browser-navigation'
import type { BrowserPaneProps } from '../workbench/types'
import { PaneTitle, usePaneChrome } from '../workbench/pane-chrome'
import { browserText } from './browser-text'
import { browserControlAllowed } from './ownership'
import { LocalServerList } from './LocalServerList'
import { useBrowserBoundsSync, useBrowserOverlayBlocker, useBrowserSurfaceActive } from './use-browser-surface'
import './browser.css'

export type { BrowserPaneProps }

function withScheme(value: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `http://${value}`
  }
  return `https://${value}`
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
  const chrome = usePaneChrome()
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

  const shownUrl = state.url === 'about:blank' ? '' : state.url
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
    <Button variant="ghost" size="sm" title={text.importHint} data-testid="browser-pane-import" isPending={importStarting || (!!importId && importPhase === 'importing')} onPress={() => void importLogin()}>
      <LogIn size={14} aria-hidden="true" />
      {importId ? text.importCancel : text.importLogin}
    </Button>
  )
  const importStatus = importId || importNote ? (
    <Notice
      tone={importId ? 'info' : importNote?.tone === 'ok' ? 'ok' : 'fail'}
      compact
      data-testid="browser-pane-import-note"
      action={!importId && importNote ? (
        <IconButton size="sm" aria-label={text.importDismiss} data-testid="browser-pane-import-dismiss" onPress={() => setImportNote(null)}>
          <X size={14} aria-hidden="true" />
        </IconButton>
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

  const navigate = async (target?: string): Promise<void> => {
    if (!controlRef.current) return
    const value = withScheme((target ?? draft).trim())
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
  const tabStrip = (
    <div className={`v3-browser__tabsrow${chrome?.title ? ' v3-browser__tabsrow--chrome' : ''}`} data-testid="browser-pane-tabs">
      <Tabs
        className="v3-browser__tabs"
        selectedKey={state.activeTabId}
        onSelectionChange={(key) => {
          if (typeof key === 'string' && control && key !== state.activeTabId) {
            void window.yan.browser.switchTab(key)
          }
        }}
      >
        <TabList className="v3-browser__tablist" aria-label={text.tabLabel}>
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              id={tab.id}
              className="v3-browser__tab"
              closeLabel={t('browser.closeTab')}
              onClose={() => {
                if (controlRef.current) void window.yan.browser.closeTab(tab.id)
              }}
            >
              {tab.title || tab.url || t('browser.newTab')}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <IconButton
        aria-label={t('browser.newTab')}
        size="sm"
        className="v3-browser__newtab"
        data-testid="browser-pane-new-tab"
        onPress={() => {
          if (controlRef.current) void window.yan.browser.newTab()
        }}
      >
        <Plus size={14} aria-hidden="true" />
      </IconButton>
    </div>
  )

  return (
    <div className="v3-browser" data-testid="browser-pane" data-active={surfaceActive ? '1' : '0'}>
      {chrome?.title ? <PaneTitle>{tabStrip}</PaneTitle> : tabStrip}

      <div className="v3-browser__toolbar">
        <IconButton
          aria-label={t('browser.back')}
          data-testid="browser-pane-back"
          isDisabled={!state.canGoBack}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.back()
          }}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.forward')}
          data-testid="browser-pane-forward"
          isDisabled={!state.canGoForward}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.forward()
          }}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.reload')}
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
            <Input
              className="ui-input v3-browser__input"
              aria-label={t('browser.address')}
              data-testid="browser-pane-address"
              spellCheck={false}
              autoComplete="off"
            />
          </TextField>
        </form>

        <IconButton
          aria-label={t('browser.openExternal')}
          data-testid="browser-pane-open-external"
          isDisabled={!shownUrl}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.openExternal(state.url || draft)
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </IconButton>
        {importButton}
      </div>

      {importStatus ? <div className="v3-browser__status">{importStatus}</div> : null}

      {state.loading || state.loadError || error ? (
        <div className="v3-browser__status" data-testid="browser-pane-status" role="status">
          {state.loading ? <span className="v3-browser__loading">{t('browser.loading')}</span> : null}
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
              <span className="v3-browser__error-url" title={state.loadError.url} data-testid="browser-pane-error-url">
                {state.loadError.url}
              </span>
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
      />
    </div>
  )
}
