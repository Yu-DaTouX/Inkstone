import { Fragment, useEffect, useRef } from 'react'
import { Folder } from 'lucide-react'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { Kbd } from '../../ui'
import { useT, type TFunc } from '../../i18n'
import type { SlashCommand } from '../../../../shared/ipc'
import { firstClause, toAbsoluteFilePath, type CompletionState } from './useCompletion'

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

export function CompletionMenu({ completion }: { completion: CompletionState }) {
  const t = useT()
  const { open, index, slashMatches, atQuery } = completion
  const listRef = useRef<HTMLDivElement>(null)
  const pointerIndex = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    if (pointerIndex.current === index) {
      pointerIndex.current = null
      return
    }
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, index])

  const hoverIndex = (next: number): void => {
    pointerIndex.current = next === index ? null : next
    completion.setIndex(next)
  }

  if (!open) return null

  if (slashMatches.length > 0) {
    return (
      <div ref={listRef} className="cmp-menu" role="listbox" aria-label={t('composer.slashSelect')} data-testid="slash-menu">
        {slashMatches.map((command, i) => (
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
              title={command.availability}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => hoverIndex(i)}
              onClick={() => completion.completeSlash(command)}
            >
              <span className="cmp-name">/{command.name}</span>
              <span className="cmp-desc" title={command.description}>{firstClause(command.description)}</span>
              {command.module ? <span className="cmp-src">{command.module}</span> : null}
            </button>
          </Fragment>
        ))}
        <div className="cmp-hint" data-testid="slash-hint">
          <span><Kbd>↑↓</Kbd> {t('composer.slashSelect')}</span>
          <span><Kbd>Enter</Kbd> / <Kbd>Tab</Kbd> {t('composer.slashFill')}</span>
          <span><Kbd>Esc</Kbd> {t('composer.slashClose')}</span>
          <span className="cmp-count">{t('composer.slashCount', { n: slashMatches.length })}</span>
        </div>
      </div>
    )
  }

  if (atQuery === null) return null
  const { atImages, atMatches, atLoading, atError, atStatus, atTruncated, cwd } = completion
  const offset = atImages.length
  return (
    <div ref={listRef} className="cmp-menu" role="listbox" aria-label={t('composer.file')} data-testid="at-menu">
      {atImages.length ? <div className="cmp-group">{t('composer.imageRefGroup')}</div> : null}
      {atImages.map((option, i) => (
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
          title={option.attachment.name}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => hoverIndex(i)}
          onClick={() => completion.completeImage(option)}
        >
          <span className="cmp-name">
            <img className="cmp-thumb" src={`data:${option.attachment.mimeType};base64,${option.attachment.preview}`} alt="" />
            {option.label}
          </span>
          <span className="cmp-desc">{option.attachment.name}</span>
          <span className="cmp-src">{t('composer.imageRefKind')}</span>
        </button>
      ))}
      {atImages.length > 0 && (atLoading || atMatches.length > 0) ? <div className="cmp-group">{t('composer.file')}</div> : null}
      {atLoading ? <div className="cmp-empty" data-testid="at-loading">{t('composer.pathLoading')}</div> : null}
      {!atLoading && atError ? (
        <div className="cmp-empty" data-testid="at-error">
          {atStatus === 'permission' ? t('composer.pathPermission') : t('composer.pathError')}
        </div>
      ) : null}
      {!atLoading && !atError && atMatches.length === 0 && atImages.length === 0 ? (
        <div className="cmp-empty" data-testid="at-empty">{t('composer.pathNoMatch')}</div>
      ) : null}
      {!atLoading && !atError
        ? atMatches.map((path, i) => (
            <button
              key={path}
              type="button"
              tabIndex={-1}
              id={`composer-at-option-${i + offset}`}
              role="option"
              className="cmp-item"
              data-selected={i + offset === index || undefined}
              aria-selected={i + offset === index}
              title={toAbsoluteFilePath(cwd, path)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => hoverIndex(i + offset)}
              onClick={() => completion.completeAt(path)}
            >
              <span className="cmp-name">
                {path.endsWith('/') ? <Folder size={14} aria-hidden /> : <FileTypeIcon name={path} size={14} />}
                {path}
              </span>
              <span className="cmp-src">{path.endsWith('/') ? t('composer.dir') : t('composer.file')}</span>
            </button>
          ))
        : null}
      {!atLoading && !atError && atTruncated ? (
        <div className="cmp-hint" data-testid="at-truncated">{t('composer.pathTruncated')}</div>
      ) : null}
    </div>
  )
}
