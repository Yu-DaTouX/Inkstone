import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { GitChangePatch, GitChangesScope } from '../../../../shared/git'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleHeader,
  CollapsiblePanel,
  DiffStat,
  MiddleTruncate,
  Notice,
  Spinner,
  cx
} from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { porcelainFileStatus } from '../../lib/file-status'
import { DiffView, type DiffViewMode } from '../diff'
import { ImageCompare } from './ImageCompare'
import { resolvePatchSource } from './changes-scope'
import type { ChangeItem, ChangesAnnotate, ChangesImagePair, ChangesPatch, PatchLoader } from './types'
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
  annotate?: ChangesAnnotate
}

type PatchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'patch'; patch: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'too-large' }
  | { kind: 'image'; image: ChangesImagePair | null }
  | { kind: 'error'; message: string }

export function ChangesFileDiff(props: ChangesFileDiffProps): ReactElement {
  const { item, entry, cwd, request, loader, schedule, tick, lang, text, mode, expanded, onToggle, onRetry, annotate } = props
  const [state, setState] = useState<PatchState>({ kind: 'idle' })
  const origin = useMemo(() => resolvePatchSource(item.path, entry), [item.path, entry])
  const hasBody = origin.kind !== 'binary' && origin.kind !== 'too-large'
  const open = expanded || !hasBody

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

  const note = (message: string): ReactElement => (
    <Notice variant="hint" className="changes-file__note">
      {message}
    </Notice>
  )

  const body = (): ReactElement | null => {
    if (state.kind === 'loading') {
      return (
        <Notice variant="hint" icon={<Spinner size="xs" />} className="changes-file__note">
          {text.patchLoading}
        </Notice>
      )
    }
    if (state.kind === 'error') {
      return (
        <Notice
          tone="fail"
          compact
          className="changes-file__note"
          action={
            <Button size="xs" onPress={onRetry}>
              {text.retry}
            </Button>
          }
        >
          {text.patchError(state.message)}
        </Notice>
      )
    }
    if (state.kind === 'binary') return note(text.patchBinary)
    if (state.kind === 'too-large') return note(text.patchTooLarge)
    if (state.kind === 'image') {
      return state.image ? <ImageCompare before={state.image.before} after={state.image.after} text={text} /> : note(text.imageEmpty)
    }
    if (state.kind === 'patch') {
      return (
        <>
          {state.truncated ? note(text.patchTruncated) : null}
          <DiffView
            patch={state.patch}
            title={item.path}
            lang={lang}
            mode={mode}
            showFileHeader={false}
            annotate={
              annotate
                ? { labels: annotate.labels, onSubmit: (annotation) => annotate.onComment(item.path, annotation) }
                : undefined
            }
            embedded
          />
        </>
      )
    }
    return note(text.noDiffChannel)
  }

  return (
    <section
      className={cx('changes-file', !hasBody && 'changes-file--fixed')}
      data-path={item.path}
      data-collapsed={hasBody && !expanded ? '' : undefined}
    >
      <Collapsible
        isExpanded={open}
        isDisabled={!hasBody}
        onExpandedChange={() => {
          if (hasBody) onToggle(item.path)
        }}
      >
        <CollapsibleHeader
          className="changes-file__head"
          tone="emphasized"
          icon={<FileTypeIcon name={item.path} size={12} />}
          accessory={
            labels.length > 0 || counts ? (
              <>
                {labels.map((label) => (
                  <Badge key={label} className="changes-file__label">
                    {label}
                  </Badge>
                ))}
                {counts ? <DiffStat added={item.added ?? 0} removed={item.removed ?? 0} /> : null}
              </>
            ) : undefined
          }
        >
          <MiddleTruncate value={item.path} className="changes-file__path" />
        </CollapsibleHeader>
        <CollapsiblePanel className="changes-file__body">{open ? body() : null}</CollapsiblePanel>
      </Collapsible>
    </section>
  )
}
