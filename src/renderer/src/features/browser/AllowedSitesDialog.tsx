import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, EmptyState, IconButton, Input, Modal, ModalOverlay, Notice, TextField } from '../../ui'
import { siteLabelOf } from './site-label'
import { browserText } from './browser-text'
import './browser.css'

export function AllowedSitesDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }): ReactElement {
  const { lang } = useI18n()
  const text = browserText(lang)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [sites, setSites] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSites(await window.yan.browser.allowedSites())
    } catch {
      setError(text.sitesLoadError)
    }
  }, [text])

  useEffect(() => {
    if (!isOpen) return undefined
    setDraft('')
    setError('')
    void refresh()
    return acquireOverlayBlocker('browser-allowed-sites')
  }, [isOpen, refresh, acquireOverlayBlocker])

  const add = async (): Promise<void> => {
    if (busy || !draft.trim()) return
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.browser.addAllowedSite(draft.trim())
      setSites(result.list)
      if (result.result === 'ok') setDraft('')
      else setError(text.sitesError(result.result))
    } catch {
      setError(text.sitesLoadError)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (origin: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.browser.removeAllowedSite(origin)
      setSites(result.list)
    } catch {
      setError(text.sitesLoadError)
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setSites(await window.yan.browser.clearAllowedSites())
    } catch {
      setError(text.sitesLoadError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal className="v3-browser-sites">
        <Dialog title={text.sitesTitle} closeLabel={text.sitesDone} data-testid="browser-allowed-sites">
          <p className="v3-browser-sites__description">{text.sitesDescription}</p>
          <form
            className="v3-browser-sites__add"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <TextField
              className="v3-browser-sites__add-field"
              aria-label={text.sitesAddLabel}
              value={draft}
              onChange={(value) => {
                setDraft(value)
                setError('')
              }}
            >
              <Input
                className="ui-input"
                aria-label={text.sitesAddLabel}
                placeholder={text.sitesAddPlaceholder}
                spellCheck={false}
                autoComplete="off"
                data-testid="browser-allowed-sites-input"
              />
            </TextField>
            <Button
              variant="secondary"
              type="submit"
              icon={<Plus size={14} aria-hidden="true" />}
              isDisabled={!draft.trim()}
              isPending={busy}
              data-testid="browser-allowed-sites-add"
            >
              {text.sitesAdd}
            </Button>
          </form>
          {error ? (
            <Notice tone="fail" compact data-testid="browser-allowed-sites-error">
              {error}
            </Notice>
          ) : null}
          {sites.length === 0 ? (
            <EmptyState size="sm" role="status" title={text.sitesEmpty} />
          ) : (
            <ul className="v3-browser-sites__rows" data-testid="browser-allowed-sites-list">
              {sites.map((origin) => {
                const label = siteLabelOf(origin)
                return (
                  <li key={origin} className="v3-browser-sites__row" data-origin={origin}>
                    <span className="v3-browser-sites__label" title={origin}>{label}</span>
                    <IconButton
                      size="sm"
                      aria-label={text.sitesRemove(label)}
                      tooltip={text.sitesRemove(label)}
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => void remove(origin)}
                      data-testid="browser-allowed-sites-remove"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
          <DialogFooter align="between">
            <Button
              variant="danger"
              isDisabled={sites.length === 0}
              onPress={() => void clear()}
              data-testid="browser-allowed-sites-clear"
            >
              {text.sitesClear}
            </Button>
            <Button variant="primary" onPress={onClose} data-testid="browser-allowed-sites-done">
              {text.sitesDone}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
