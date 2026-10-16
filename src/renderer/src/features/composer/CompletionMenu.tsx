import { Fragment } from 'react'
import { File as FileIcon, Folder } from 'lucide-react'
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
  if (!open) return null

  if (slashMatches.length > 0) {
    return (
      <div className="cmp-menu" role="listbox" aria-label={t('composer.slashSelect')} data-testid="slash-menu">
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
              onMouseEnter={() => completion.setIndex(i)}
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
  const { atMatches, atLoading, atError, atStatus, atTruncated, cwd } = completion
  return (
    <div className="cmp-menu" role="listbox" aria-label={t('composer.file')} data-testid="at-menu">
      {atLoading ? <div className="cmp-empty" data-testid="at-loading">{t('composer.pathLoading')}</div> : null}
      {!atLoading && atError ? (
        <div className="cmp-empty" data-testid="at-error">
          {atStatus === 'permission' ? t('composer.pathPermission') : t('composer.pathError')}
        </div>
      ) : null}
      {!atLoading && !atError && atMatches.length === 0 ? (
        <div className="cmp-empty" data-testid="at-empty">{t('composer.pathNoMatch')}</div>
      ) : null}
      {!atLoading && !atError
        ? atMatches.map((path, i) => (
            <button
              key={path}
              type="button"
              tabIndex={-1}
              id={`composer-at-option-${i}`}
              role="option"
              className="cmp-item"
              data-selected={i === index || undefined}
              aria-selected={i === index}
              title={toAbsoluteFilePath(cwd, path)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => completion.setIndex(i)}
              onClick={() => completion.completeAt(path)}
            >
              <span className="cmp-name">
                {path.endsWith('/') ? <Folder size={12} aria-hidden /> : <FileIcon size={12} aria-hidden />}
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
