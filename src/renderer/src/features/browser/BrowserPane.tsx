import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Plus, RotateCw, ShieldCheck } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, EmptyState, Input, IconButton, Notice, Tab, TabList, Tabs, TextField } from '../../ui'
import { claimResource, resourceOwner } from '../../state/resource-owners'
import { nextAddressInput } from '../../../../shared/browser-navigation'
import type { BrowserPaneProps } from '../workbench/types'
import { browserText } from './browser-text'
import { browserControlAllowed } from './ownership'
import { useBrowserBoundsSync, useBrowserOverlayBlocker, useBrowserSurfaceActive } from './use-browser-surface'
import { AllowedSitesDialog } from './AllowedSitesDialog'
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
  const { lang } = useI18n()
  const text = browserText(lang)
  const state = useStore((s) => s.browserState)
  const openBrowser = useStore((s) => s.openBrowser)
  const viewportRef = useRef<HTMLDivElement>(null)

  const browserOwnerKey = resourceOwner('browser')
  const adoptable = owner.active && state.open && browserOwnerKey === undefined
  useEffect(() => {
    if (adoptable) claimResource('browser', owner.key)
  }, [adoptable, owner.key])

  const owns = adoptable || browserOwnerKey === owner.key
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
  const [sitesOpen, setSitesOpen] = useState(false)
  const navSeq = useRef(0)

  useEffect(() => {
    setDraft((prev) => nextAddressInput(shownUrl, prev, dirty))
  }, [shownUrl, dirty])

  useEffect(() => {
    setDirty(false)
    setError('')
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
      await openBrowser(undefined, { key: owner.key })
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
        </div>
      )
    }
    if (!owns) return <Gate text={text.foreignOwner} testId="browser-pane-foreign" />
    return <div className="v3-browser" data-testid="browser-pane-hidden" hidden />
  }

  const tabs = state.tabs ?? []

  return (
    <div className="v3-browser" data-testid="browser-pane" data-active={surfaceActive ? '1' : '0'}>
      <div className="v3-browser__tabsrow">
        <Tabs
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
          className="v3-browser__newtab"
          data-testid="browser-pane-new-tab"
          onPress={() => {
            if (controlRef.current) void window.yan.browser.newTab()
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

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
          aria-label={text.sitesManage}
          data-testid="browser-pane-allowed-sites"
          onPress={() => setSitesOpen(true)}
        >
          <ShieldCheck size={14} aria-hidden="true" />
        </IconButton>

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
      </div>

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
      <AllowedSitesDialog isOpen={sitesOpen} onClose={() => setSitesOpen(false)} />
    </div>
  )
}
