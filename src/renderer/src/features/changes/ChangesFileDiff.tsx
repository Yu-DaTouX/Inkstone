import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { GitChangePatch, GitChangesScope } from '../../../../shared/git'
import { Button, cx } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { porcelainFileStatus } from '../../lib/file-status'
import { DiffView, type DiffViewMode } from '../diff'
import { ImageCompare } from './ImageCompare'
import { resolvePatchSource } from './changes-scope'
import type { ChangeItem, ChangesImagePair, ChangesPatch, PatchLoader } from './types'
import type { ChangesText } from './text'

export interface ChangesFileDiffProps {
  item: ChangeItem
  entry?: GitChangePatch
  cwd: string
  request: GitChangesScope
  loader?: PatchLoader
  schedule: <T>(run: () => Promise<T>) => Promise<T>
  tick: number
  lang?: string
  text: ChangesText
  mode: DiffViewMode
  expanded: boolean
  onToggle: (path: string) => void
  onRetry: () => void
}

type PatchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'patch'; patch: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'too-large' }
  | { kind: 'image'; image: ChangesImagePair | null }
  | { kind: 'error'; message: string }

function splitPath(path: string): { directory: string; base: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { directory: '', base: path } : { directory: path.slice(0, cut), base: path.slice(cut + 1) }
}

export function ChangesFileDiff(props: ChangesFileDiffProps): ReactElement {
  const { item, entry, cwd, request, loader, schedule, tick, lang, text, mode, expanded, onToggle, onRetry } = props
  const [state, setState] = useState<PatchState>({ kind: 'idle' })
  const bodyId = useId()
  const origin = useMemo(() => resolvePatchSource(item.path, entry), [item.path, entry])
  const hasBody = origin.kind !== 'binary' && origin.kind !== 'too-large'

  useEffect(() => {
    if (origin.kind === 'inline') {
      setState({ kind: 'patch', patch: origin.patch, truncated: false })
      return
    }
    if (origin.kind === 'binary') {
      setState({ kind: 'binary' })
      return
    }
    if (origin.kind === 'too-large') {
      setState({ kind: 'too-large' })
      return
    }
    if (!expanded) return
    if (!loader) {
      setState({ kind: 'idle' })
      return
    }
    let alive = true
    setState({ kind: 'loading' })
    const run = (): Promise<ChangesPatch> => loader(cwd, item.path, { scope: request, images: origin.kind === 'image' })
    schedule(run)
      .then((value) => {
        if (!alive) return
        if (origin.kind === 'image') {
          setState({ kind: 'image', image: value.image ?? null })
          return
        }
        if (value.binary && !value.patch) {
          setState({ kind: 'binary' })
          return
        }
        setState({ kind: 'patch', patch: value.patch, truncated: value.truncated === true })
      })
      .catch((error: unknown) => {
        if (alive) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
    }
  }, [origin, expanded, loader, cwd, item.path, request, schedule, tick])

  const status = porcelainFileStatus(item.status)
  const labels: string[] = []
  if (status === 'untracked' || status === 'added') labels.push(text.fileNew)
  else if (status === 'deleted') labels.push(text.fileDeleted)
  else if (status === 'renamed' && item.origPath) labels.push(text.fileRenamed(item.origPath))
  if (state.kind === 'binary') labels.push(text.fileBinary)
  const counts = item.added !== undefined || item.removed !== undefined
  const { directory, base } = splitPath(item.path)

  const body = (): ReactElement | null => {
    if (!expanded && hasBody) return null
    if (state.kind === 'loading') return <p className="changes-file__note">{text.patchLoading}</p>
    if (state.kind === 'error') {
      return (
        <div className="changes-file__problem" role="alert">
          <span>{text.patchError(state.message)}</span>
          <Button size="sm" onPress={onRetry}>
            {text.retry}
          </Button>
        </div>
      )
    }
    if (state.kind === 'binary') return <p className="changes-file__note">{text.patchBinary}</p>
    if (state.kind === 'too-large') return <p className="changes-file__note">{text.patchTooLarge}</p>
    if (state.kind === 'image') {
      return state.image ? <ImageCompare before={state.image.before} after={state.image.after} text={text} /> : <p className="changes-file__note">{text.imageEmpty}</p>
    }
    if (state.kind === 'patch') {
      return (
        <>
          {state.truncated ? <p className="changes-file__note">{text.patchTruncated}</p> : null}
          <DiffView patch={state.patch} lang={lang} mode={mode} showFileHeader={false} embedded />
        </>
      )
    }
    return <p className="changes-file__note">{text.noDiffChannel}</p>
  }

  return (
    <section
      className={cx('changes-file', !hasBody && 'changes-file--fixed')}
      data-path={item.path}
      data-collapsed={hasBody && !expanded ? '' : undefined}
    >
      <div className="changes-file__header">
        <button
          type="button"
          className="changes-file__toggle"
          aria-expanded={hasBody ? expanded : undefined}
          aria-controls={hasBody ? bodyId : undefined}
          aria-disabled={hasBody ? undefined : true}
          onClick={() => {
            if (hasBody) onToggle(item.path)
          }}
        >
          <span className="changes-file__caret" data-collapsed={hasBody && expanded ? undefined : ''} aria-hidden="true">
            <ChevronDown size={16} />
          </span>
          <FileTypeIcon name={item.path} size={12} />
          <span className="changes-file__path" title={item.path}>
            <span className="changes-file__base">{base}</span>
            {directory ? <span className="changes-file__dir">{directory}</span> : null}
          </span>
          {labels.map((label) => (
            <span key={label} className="changes-file__label">
              {label}
            </span>
          ))}
          {counts ? (
            <span className="changes-file__counts">
              <span className="changes-file__count-add">+{item.added ?? 0}</span>
              <span className="changes-file__count-del">−{item.removed ?? 0}</span>
            </span>
          ) : null}
        </button>
      </div>
      {expanded || !hasBody ? (
        <div className="changes-file__body" id={bodyId}>
          {body()}
        </div>
      ) : null}
    </section>
  )
}
