import { useEffect, useRef, useState, type RefObject } from 'react'
import { Bookmark, FileText, Trash2 } from 'lucide-react'
import type { Attachment } from '../../../../shared/ipc'
import { IconButton, MenuItem, Popover } from '../../ui'
import { InlineImage } from '../../ui/InlineImage'
import { useI18n, useT, type Lang, type TFunc } from '../../i18n'
import {
  PROMPT_STASH_SNIPPET_MAX,
  requestPromptStashOpen,
  requestPromptStashSave,
  stashAge,
  stashFiles,
  stashImages,
  stashSnippet,
  type PromptStashEntry
} from './prompt-stash'
import { usePromptStashEntries } from './usePromptStash'
import './prompt-stash.css'

function attachmentLabel(kind: 'image' | 'file', n: number, t: TFunc): string {
  if (kind === 'image') return n === 1 ? t('stash.imageOne') : t('stash.images', { n })
  return n === 1 ? t('stash.fileOne') : t('stash.files', { n })
}

function snippetLabel(entry: PromptStashEntry, t: TFunc): string {
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
  const src = image.preview
  return src.startsWith('data:') ? src : `data:${image.mimeType};base64,${src}`
}

export interface StashPanelProps {
  entries: readonly PromptStashEntry[]
  highlightId: string | null
  onHighlight: (id: string) => void
  onRestore: (entry: PromptStashEntry) => void
  onDelete: (entry: PromptStashEntry) => void
  bodyRef?: RefObject<HTMLDivElement | null>
}

export function StashPanel({ entries, highlightId, onHighlight, onRestore, onDelete, bodyRef }: StashPanelProps) {
  const t = useT()
  const { lang } = useI18n()
  const now = Date.now()

  return (
    <div className="ps" ref={bodyRef}>
      <div className="ps-head">
        <Bookmark size={13} aria-hidden />
        <span className="ps-title">{t('stash.title')}</span>
        <span className="ps-count" aria-hidden>
          {entries.length}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="ps-empty" data-testid="prompt-stash-empty">
          <span className="ps-empty-title">{t('stash.empty')}</span>
          <span className="ps-empty-hint">{t('stash.emptyHint', { keys: t('stash.shortcut') })}</span>
        </div>
      ) : (
        <ul className="ps-list" role="listbox" aria-label={t('stash.title')}>
          {entries.map((entry) => {
            const images = stashImages(entry)
            const files = stashFiles(entry).length
            const label = snippetLabel(entry, t)
            return (
              <li
                key={entry.id}
                className="ps-row"
                data-stash-row={entry.id}
                data-highlighted={entry.id === highlightId || undefined}
                onMouseMove={() => {
                  if (entry.id !== highlightId) onHighlight(entry.id)
                }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={entry.id === highlightId}
                  className="ps-restore"
                  title={entry.text}
                  aria-label={t('stash.restore', { snippet: label })}
                  onFocus={() => onHighlight(entry.id)}
                  onClick={() => onRestore(entry)}
                >
                  <span className="ps-snippet">{label}</span>
                  <span className="ps-meta">
                    {images.length > 0 ? (
                      <span className="ps-thumbs">
                        {images.slice(0, 3).map((image) => (
                          <InlineImage key={image.id} className="ps-thumb" src={thumbSource(image)} alt="" aria-hidden />
                        ))}
                        {images.length > 3 ? <span className="ps-thumb-more">+{images.length - 3}</span> : null}
                        <span className="ps-count-badge">{attachmentLabel('image', images.length, t)}</span>
                      </span>
                    ) : null}
                    {files > 0 ? (
                      <span className="ps-files">
                        <FileText size={11} aria-hidden />
                        {attachmentLabel('file', files, t)}
                      </span>
                    ) : null}
                    <time className="ps-time" dateTime={new Date(entry.createdAt).toISOString()}>
                      {ageLabel(entry, now, lang, t)}
                    </time>
                  </span>
                </button>
                <IconButton
                  size="sm"
                  className="ps-del"
                  aria-label={t('stash.delete')}
                  title={`${t('stash.delete')} · ${t('stash.shortcutDelete')}`}
                  data-stash-delete={entry.id}
                  onPress={() => onDelete(entry)}
                >
                  <Trash2 size={12} aria-hidden />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
      <p className="ps-hint">{t('stash.hint')}</p>
    </div>
  )
}

export interface StashMenuProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  scopeRef?: RefObject<HTMLElement | null>
  entries: readonly PromptStashEntry[]
  onRestore: (entry: PromptStashEntry) => void
  onDelete: (entry: PromptStashEntry) => void
}

export function StashMenu({
  isOpen,
  onOpenChange,
  anchorRef,
  scopeRef,
  entries,
  onRestore,
  onDelete
}: StashMenuProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [highlightId, setHighlightId] = useState<string | null>(entries[0]?.id ?? null)

  useEffect(() => {
    if (!isOpen) return
    setHighlightId((current) =>
      current && entries.some((entry) => entry.id === current) ? current : entries[0]?.id ?? null
    )
  }, [isOpen, entries])

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (bodyRef.current?.contains(target)) return
      onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isOpen, onOpenChange])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const target = event.target
      if (!(target instanceof Node)) return
      const withinMenu = !!bodyRef.current?.contains(target)
      const withinComposer = !!scopeRef?.current?.contains(target)
      if (!withinMenu && !withinComposer) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onOpenChange(false)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (entries.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        const step = event.key === 'ArrowDown' ? 1 : -1
        const index = entries.findIndex((entry) => entry.id === highlightId)
        const from = index >= 0 ? index : step === 1 ? -1 : 0
        const next = entries[(from + step + entries.length) % entries.length]
        setHighlightId(next.id)
        bodyRef.current?.querySelector(`[data-stash-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (event.key === 'Enter') {
        if (target instanceof Element && target.closest('[data-stash-delete]')) return
        const entry = entries.find((item) => item.id === highlightId) ?? entries[0]
        if (!entry) return
        event.preventDefault()
        event.stopPropagation()
        onRestore(entry)
        return
      }
      if (event.key === 'Backspace' && (event.ctrlKey || event.metaKey)) {
        const entry = entries.find((item) => item.id === highlightId)
        if (!entry) return
        event.preventDefault()
        event.stopPropagation()
        onDelete(entry)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen, entries, highlightId, onDelete, onOpenChange, onRestore, scopeRef])

  if (!isOpen) return null

  return (
    <Popover
      triggerRef={anchorRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isNonModal
      placement="top start"
      offset={8}
      className="ps-pop"
      data-testid="prompt-stash-menu"
    >
      <StashPanel
        bodyRef={bodyRef}
        entries={entries}
        highlightId={highlightId}
        onHighlight={setHighlightId}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    </Popover>
  )
}

export function StashMenuItem() {
  const t = useT()
  const count = usePromptStashEntries().length
  return (
    <MenuItem
      className="cpm-item"
      textValue={t('stash.menu', { n: count })}
      onAction={requestPromptStashOpen}
      data-testid="composer-plus-stash"
    >
      <Bookmark size={14} aria-hidden />
      <span className="cpm-label">{t('stash.menu', { n: count })}</span>
    </MenuItem>
  )
}

export function StashSaveMenuItem() {
  const t = useT()
  return (
    <MenuItem
      className="cpm-item"
      textValue={t('stash.save')}
      onAction={requestPromptStashSave}
      data-testid="composer-plus-stash-save"
    >
      <Bookmark size={14} aria-hidden />
      <span className="cpm-label">{t('stash.save')}</span>
      <span className="cpm-hint">{t('stash.shortcut')}</span>
    </MenuItem>
  )
}
