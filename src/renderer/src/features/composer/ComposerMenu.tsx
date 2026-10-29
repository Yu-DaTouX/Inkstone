import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder } from 'lucide-react'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { Kbd, Skeleton } from '../../ui'
import { InlineImage } from '../../ui/InlineImage'
import { useT, type TFunc } from '../../i18n'
import type { SlashCommand } from '../../../../shared/ipc'
import { firstClause, toAbsoluteFilePath, type CompletionState } from './useCompletion'
import {
  highlightParts,
  MENU_EDGE,
  menuMaxHeight,
  placeMenu,
  placeTooltip,
  tooltipMaxWidth,
  type MenuAnchor
} from './composer-menu-layout'

function sourceLabel(t: TFunc, source: SlashCommand['source']): string {
  return t(({
    yan: 'composer.src.yan',
    pi: 'composer.src.pi',
    extension: 'composer.src.extension',
    skill: 'composer.src.skill',
    prompt: 'composer.src.prompt',
    compatibility: 'composer.src.compatibility'
  } as const)[source])
}

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

function dirName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? '' : trimmed.slice(0, at)
}

function Hit({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query)
  return (
    <span className="cmp-label">
      {parts.map((part, i) =>
        part.hit ? (
          <b key={i} className="cmp-hit">
            {part.text}
          </b>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        )
      )}
    </span>
  )
}

export function ComposerMenu({
  completion,
  anchor
}: {
  completion: CompletionState
  anchor: () => MenuAnchor | null
}) {
  const t = useT()
  const { open, index, slashMatches, slashQuery, atQuery } = completion
  const listRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const pointerIndex = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const announced = useRef({ open: false, count: -1 })

  useEffect(() => {
    const total = slashQuery !== null ? slashMatches.length : completion.atImages.length + completion.atMatches.length
    if (!open || total === 0) {
      announced.current = { open: false, count: total }
      setAnnouncement('')
      return
    }
    const fresh = !announced.current.open || announced.current.count !== total
    announced.current = { open: true, count: total }
    setAnnouncement(
      fresh ? t('composer.menuAnnounce', { n: total }) : t('composer.menuPosition', { n: index + 1, total })
    )
  }, [completion.atImages.length, completion.atMatches.length, index, open, slashMatches.length, slashQuery, t])

  const place = useCallback(() => {
    const list = listRef.current
    const rect = anchor()
    if (!list || !rect) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const width = Math.max(0, Math.min(rect.right - rect.left, viewport.width - MENU_EDGE * 2))
    list.style.width = `${width}px`
    list.style.maxHeight = `${menuMaxHeight(rect)}px`
    const box = placeMenu({
      anchor: rect,
      size: { width, height: list.scrollHeight },
      viewport: { ...viewport, width: Math.max(viewport.width, width + MENU_EDGE * 2) }
    })
    list.style.left = `${box.left}px`
    list.style.top = `${box.top}px`
    list.style.visibility = 'visible'
    const tip = tipRef.current
    const row = list.querySelector<HTMLElement>('[data-selected="true"]')
    if (!tip || !row) return
    tip.style.maxWidth = `min(26rem, ${tooltipMaxWidth({ left: box.left, width: list.offsetWidth }, viewport)}px)`
    const placement = placeTooltip({
      menu: { left: box.left, width: list.offsetWidth },
      row: { top: row.getBoundingClientRect().top, height: row.offsetHeight },
      tooltip: { width: tip.offsetWidth, height: tip.offsetHeight },
      viewport
    })
    tip.style.left = `${placement.left}px`
    tip.style.top = `${placement.top}px`
    tip.dataset.side = placement.side
    tip.style.visibility = 'visible'
  }, [anchor])

  useLayoutEffect(() => {
    place()
  })

  useEffect(() => {
    if (!open) return undefined
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    if (pointerIndex.current === index) {
      pointerIndex.current = null
      return
    }
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, index])

  if (!open) {
    return createPortal(
      <div className="sr-only" role="status" aria-live="polite" data-testid="composer-menu-status">
        {announcement}
      </div>,
      document.body
    )
  }

  const hoverIndex = (next: number): void => {
    pointerIndex.current = next === index ? null : next
    completion.setIndex(next)
  }

  const slashMode =
    completion.slashQuery !== null &&
    (slashMatches.length > 0 || (atQuery === null && completion.slashStatus !== 'idle'))
  const query = slashMode ? completion.slashQuery ?? '' : completion.atQuery ?? ''
  const offset = completion.atImages.length
  const selectedCommand = slashMode ? slashMatches[index] : undefined
  const selectedPath = !slashMode && index >= offset ? completion.atMatches[index - offset] : undefined
  const selectedDescription = selectedCommand?.description ?? ''
  const tooltipText = slashMode
    ? selectedDescription !== firstClause(selectedDescription) ? selectedDescription : ''
    : selectedPath
      ? toAbsoluteFilePath(completion.cwd, selectedPath)
      : ''

  const menu = (
    <div
      ref={listRef}
      className="cmp-menu"
      role="listbox"
      aria-label={slashMode ? t('composer.slashSelect') : t('composer.file')}
      data-kind={slashMode ? 'slash' : 'at'}
      data-testid={slashMode ? 'slash-menu' : 'at-menu'}
      style={{ visibility: 'hidden' }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {slashMode
        ? slashMatches.map((command, i) => (
            <Fragment key={`${command.source}:${command.name}:${command.module ?? ''}`}>
              {i === 0 || slashMatches[i - 1].source !== command.source ? (
                <div className="cmp-group" data-source={command.source}>
                  {sourceLabel(t, command.source)}
                </div>
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                id={`composer-slash-option-${i}`}
                role="option"
                className="cmp-item"
                data-selected={i === index || undefined}
                data-compat={command.executable ? undefined : true}
                aria-selected={i === index}
                aria-disabled={!command.executable}
                disabled={!command.executable}
                title={command.executable ? undefined : command.availability}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => hoverIndex(i)}
                onClick={() => completion.completeSlash(command)}
              >
                <span className="cmp-name">
                  <Hit text={`/${command.name}`} query={query} />
                </span>
                <span className="cmp-desc">
                  <Hit text={firstClause(command.description)} query={query} />
                </span>
                {command.module ? <span className="cmp-src">{command.module}</span> : null}
              </button>
            </Fragment>
          ))
        : null}

      {slashMode && slashMatches.length === 0 && completion.slashStatus === 'loading' ? (
        <div className="cmp-state" data-testid="slash-loading">
          <Skeleton shape="text" width={96} />
          {t('composer.slashLoading')}
        </div>
      ) : null}

      {slashMode && slashMatches.length === 0 && completion.slashStatus === 'error' ? (
        <div className="cmp-state" data-testid="slash-error">
          <span>{t('composer.slashError')}</span>
          <button type="button" tabIndex={-1} className="cmp-retry" onClick={() => completion.retrySlash()}>
            {t('composer.slashRetry')}
          </button>
        </div>
      ) : null}

      {!slashMode && completion.atImages.length ? <div className="cmp-group">{t('composer.imageRefGroup')}</div> : null}
      {!slashMode
        ? completion.atImages.map((option, i) => (
            <button
              key={option.attachment.id}
              type="button"
              tabIndex={-1}
              id={`composer-at-option-${i}`}
              role="option"
              className="cmp-item"
              data-selected={i === index || undefined}
              data-testid="at-image-option"
              aria-selected={i === index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => hoverIndex(i)}
              onClick={() => completion.completeImage(option)}
            >
              <span className="cmp-name">
                <InlineImage className="cmp-thumb" src={option.attachment.preview.startsWith('data:') ? option.attachment.preview : `data:${option.attachment.mimeType};base64,${option.attachment.preview}`} alt="" />
                <Hit text={option.label} query={query} />
              </span>
              <span className="cmp-desc">{option.attachment.name}</span>
              <span className="cmp-src">{t('composer.imageRefKind')}</span>
            </button>
          ))
        : null}
      {!slashMode && offset > 0 && (completion.atLoading || completion.atMatches.length > 0) ? (
        <div className="cmp-group">{t('composer.file')}</div>
      ) : null}
      {!slashMode && completion.atLoading ? <div className="cmp-state" data-testid="at-loading">{t('composer.pathLoading')}</div> : null}
      {!slashMode && !completion.atLoading && completion.atError ? (
        <div className="cmp-state" data-testid="at-error">
          {completion.atStatus === 'permission' ? t('composer.pathPermission') : t('composer.pathError')}
        </div>
      ) : null}
      {!slashMode && !completion.atLoading && !completion.atError && completion.atMatches.length === 0 && offset === 0 ? (
        <div className="cmp-state" data-testid="at-empty">{t('composer.pathNoMatch')}</div>
      ) : null}
      {!slashMode && !completion.atLoading && !completion.atError
        ? completion.atMatches.map((path, i) => (
            <button
              key={path}
              type="button"
              tabIndex={-1}
              id={`composer-at-option-${i + offset}`}
              role="option"
              className="cmp-item"
              data-selected={i + offset === index || undefined}
              aria-selected={i + offset === index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => hoverIndex(i + offset)}
              onClick={() => completion.completeAt(path)}
            >
              <span className="cmp-name">
                {path.endsWith('/') ? <Folder size={14} aria-hidden /> : <FileTypeIcon name={path} size={14} />}
                <Hit text={baseName(path)} query={query} />
              </span>
              <span className="cmp-desc">
                <Hit text={dirName(path)} query={query} />
              </span>
            </button>
          ))
        : null}
      {!slashMode && !completion.atLoading && !completion.atError && completion.atTruncated ? (
        <div className="cmp-hint" data-testid="at-truncated">{t('composer.pathTruncated')}</div>
      ) : null}

      {slashMode && slashMatches.length > 0 ? (
        <div className="cmp-hint" data-testid="slash-hint">
          <span><Kbd>↑↓</Kbd> {t('composer.slashSelect')}</span>
          <span><Kbd>Enter</Kbd> / <Kbd>Tab</Kbd> {t('composer.slashFill')}</span>
          <span><Kbd>Esc</Kbd> {t('composer.slashClose')}</span>
          <span className="cmp-count">{t('composer.slashCount', { n: slashMatches.length })}</span>
        </div>
      ) : null}
    </div>
  )

  return createPortal(
    <>
      {menu}
      <div className="sr-only" role="status" aria-live="polite" data-testid="composer-menu-status">
        {announcement}
      </div>
      {tooltipText ? (
        <div ref={tipRef} className="cmp-tip" role="tooltip" style={{ visibility: 'hidden' }}>
          {tooltipText}
        </div>
      ) : null}
    </>,
    document.body
  )
}
