import { BookmarkIcon, FileIcon, FileTextIcon } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Attachment } from '../../../../../shared/ipc'
import { useI18n, useT, type Lang, type TFunc } from '@/i18n'
import {
  PROMPT_STASH_SNIPPET_MAX,
  stashAge,
  stashFiles,
  stashImages,
  stashSnippet,
  type PromptStashEntry
} from '@/features/composer/prompt-stash'
import type { PromptStashAdapter } from '@/t3/adapters/composer-stash'
import { cx } from '@/ui/cx'
import { ComposerBanner } from './ComposerBanner'
import './ComposerStash.css'

function attachmentLabel(kind: 'image' | 'file', count: number, t: TFunc): string {
  if (kind === 'image') return count === 1 ? t('stash.imageOne') : t('stash.images', { n: count })
  return count === 1 ? t('stash.fileOne') : t('stash.files', { n: count })
}

function entryLabel(entry: PromptStashEntry, t: TFunc): string {
  const snippet = stashSnippet(entry.text, PROMPT_STASH_SNIPPET_MAX)
  if (snippet) return snippet
  const images = stashImages(entry).length
  const files = stashFiles(entry).length
  const parts: string[] = []
  if (images > 0) parts.push(attachmentLabel('image', images, t))
  if (files > 0) parts.push(attachmentLabel('file', files, t))
  return t('stash.only', { label: parts.join(' + ') })
}

function ageLabel(entry: PromptStashEntry, now: number, lang: Lang, t: TFunc): string {
  const age = stashAge(now, entry.createdAt)
  if (age.unit === 'now') return t('stash.time.now')
  if (age.unit === 'date') return new Date(entry.createdAt).toLocaleDateString(lang)
  if (age.unit === 'minute') return t('stash.time.minute', { n: age.value })
  if (age.unit === 'hour') return t('stash.time.hour', { n: age.value })
  return t('stash.time.day', { n: age.value })
}

function thumbSource(image: Attachment): string {
  const src = image.preview ?? image.data ?? ''
  return src.startsWith('data:') ? src : `data:${image.mimeType};base64,${src}`
}

export function ComposerStashMenuV3(props: {
  entries: readonly PromptStashEntry[]
  onRestore: (entry: PromptStashEntry) => void
  onDelete: (entry: PromptStashEntry) => void
  onClose: () => void
  scopeRef?: RefObject<HTMLElement | null>
}) {
  const t = useT()
  const { lang } = useI18n()
  const { entries, onRestore, onDelete, onClose, scopeRef } = props
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ entries, onRestore, onDelete, onClose, scopeRef, highlightedId })
  latest.current = { entries, onRestore, onDelete, onClose, scopeRef, highlightedId }

  const highlighted = entries.find((entry) => entry.id === highlightedId) ?? entries[0]

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const drawer = drawerRef.current
      if (!drawer) return
      if (
        event.composedPath().includes(drawer) ||
        (event.target instanceof Element &&
          event.target.closest('[data-prompt-stash-badge="true"]'))
      ) {
        return
      }
      latest.current.onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const drawer = drawerRef.current
      if (!drawer) return
      const target = event.target
      const scope = latest.current.scopeRef?.current
      if (
        !(target instanceof Node) ||
        (target !== document.body &&
          !(target instanceof Element && target.closest('[data-prompt-stash-badge="true"]')) &&
          !drawer.contains(target) &&
          !scope?.contains(target))
      ) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        latest.current.onClose()
        return
      }
      const list = latest.current.entries
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (list.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        const currentIndex = list.findIndex((entry) => entry.id === latest.current.highlightedId)
        const offset = event.key === 'ArrowDown' ? 1 : -1
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0
        const nextIndex = (normalizedIndex + offset + list.length) % list.length
        const next = list[nextIndex]
        if (!next) return
        setHighlightedId(next.id)
        const button = drawer.querySelectorAll<HTMLButtonElement>('[data-stash-restore]')[nextIndex]
        button?.scrollIntoView({ block: 'nearest' })
        if (drawer.contains(document.activeElement)) button?.focus({ preventScroll: true })
        return
      }
      if (event.key === 'Enter') {
        if (event.target instanceof Element && event.target.closest('button[aria-label]')) return
        const entry =
          list.find((item) => item.id === latest.current.highlightedId) ?? list[0]
        if (!entry) return
        event.preventDefault()
        event.stopPropagation()
        latest.current.onRestore(entry)
        return
      }
      if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
        const entry = list.find((item) => item.id === latest.current.highlightedId)
        if (!entry) return
        event.preventDefault()
        event.stopPropagation()
        latest.current.onDelete(entry)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const now = Date.now()

  return (
    <ComposerBanner.Root data-composer-stash-drawer="true" ref={drawerRef}>
      <ComposerBanner.Row
        aria-expanded="true"
        aria-label={t('composer.t3.stash.closeAria')}
        onClick={onClose}
        onPointerDown={(event) => event.preventDefault()}
        as="button"
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="t3-stash-menu__muted">
          {t('composer.t3.stash')}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children aria-label={t('stash.title')} as="ul">
          {entries.length === 0 ? (
            <ComposerBanner.Row as="li">
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="t3-stash-menu__muted">
                {t('stash.empty')} {t('stash.emptyHint', { keys: t('stash.shortcut') })}
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            entries.map((entry) => {
              const images = stashImages(entry)
              const files = stashFiles(entry).length
              const label = entryLabel(entry, t)
              return (
                <ComposerBanner.Row
                  className={cx(
                    't3-stash-menu__row',
                    highlighted?.id === entry.id && 't3-stash-menu__row--active'
                  )}
                  data-highlighted={highlighted?.id === entry.id || undefined}
                  data-stash-entry={entry.id}
                  key={entry.id}
                  onFocus={() => setHighlightedId(entry.id)}
                  onMouseMove={() => {
                    if (highlightedId !== entry.id) setHighlightedId(entry.id)
                  }}
                  as="li"
                >
                  <ComposerBanner.Icon>
                    <FileTextIcon />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content>
                    <button
                      aria-label={t('stash.restore', { snippet: label })}
                      className="t3-stash-menu__restore"
                      data-stash-restore={entry.id}
                      onClick={() => onRestore(entry)}
                      onPointerDown={(event) => event.preventDefault()}
                      type="button"
                    >
                      {label}
                    </button>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {images.length > 0 ? (
                      <span className="t3-stash-menu__thumbs">
                        {images.slice(0, 3).map((image) => (
                          <img
                            alt=""
                            aria-hidden="true"
                            className="t3-stash-menu__thumb"
                            key={image.id}
                            src={thumbSource(image)}
                          />
                        ))}
                      </span>
                    ) : null}
                    {files > 0 ? (
                      <span className="t3-stash-menu__files">
                        <FileIcon aria-hidden className="t3-icon--xs" />
                        {files}
                      </span>
                    ) : null}
                    <time
                      className="t3-stash-menu__time"
                      dateTime={new Date(entry.createdAt).toISOString()}
                    >
                      {ageLabel(entry, now, lang, t)}
                    </time>
                    <ComposerBanner.Dismiss
                      aria-label={t('stash.delete')}
                      className="t3-stash-menu__dismiss"
                      data-stash-delete={entry.id}
                      onClick={() => onDelete(entry)}
                      onPointerDown={(event) => event.preventDefault()}
                    />
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              )
            })
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  )
}

export function composerStashFrameProps(
  stash: PromptStashAdapter,
  t: TFunc
): {
  count: number
  menuOpen: boolean
  pulseKey: number
  label: string
  ariaLabel: string
  onToggleMenu: () => void
} {
  return {
    count: stash.count,
    menuOpen: stash.isOpen,
    pulseKey: stash.pulseKey,
    label: t('composer.t3.stash'),
    ariaLabel: t('composer.t3.stashAria', { n: stash.count }),
    onToggleMenu: stash.toggle
  }
}
