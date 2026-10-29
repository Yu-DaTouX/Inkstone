import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { GitChangePatch, GitChangesScope } from '../../../../shared/git'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel, DiffStat, Notice, Spinner, cx } from '../../ui'
import { DiffView, type DiffContents, type DiffViewMode } from '../diff'
import { ImageCompare } from './ImageCompare'
import { ChangePathLabel, ChangeStatusMark } from './ChangeEntryLabel'
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

function samePatchText(patch: string): string {
  const text = patch.replace(/\r\n/g, '\n')
  const body = text.search(/^@@ /m)
  return (body < 0 ? text : text.slice(body)).trim()
}

function patchLineCounts(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

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

  const shownPatch = useRef('')
  shownPatch.current = state.kind === 'patch' ? state.patch : ''
  const canLoadContents = Boolean(loader) && origin.kind !== 'image' && state.kind === 'patch' && !state.truncated
  const loadContents = useCallback(async (): Promise<DiffContents | null> => {
    if (!loader) return null
    const expected = samePatchText(shownPatch.current)
    const value = await schedule(() => loader(cwd, item.path, { scope: request, contents: true }))
    if (!value.contents || samePatchText(value.patch) !== expected) return null
    return value.contents
  }, [loader, schedule, cwd, item.path, request])

  const known = item.added !== undefined || item.removed !== undefined
  const derived = useMemo(() => (!known && state.kind === 'patch' && !state.truncated ? patchLineCounts(state.patch) : null), [known, state])
  const lineCounts = known ? { added: item.added ?? 0, removed: item.removed ?? 0 } : derived
  const counts = state.kind !== 'binary' && lineCounts !== null

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
            loadContents={canLoadContents ? loadContents : undefined}
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
          accessory={counts && lineCounts ? <DiffStat added={lineCounts.added} removed={lineCounts.removed} /> : undefined}
        >
          <ChangePathLabel stacked path={item.path} mark={<ChangeStatusMark item={item} lang={lang} text={text} />} />
        </CollapsibleHeader>
        <CollapsiblePanel className="changes-file__body">{open ? body() : null}</CollapsiblePanel>
      </Collapsible>
    </section>
  )
}
