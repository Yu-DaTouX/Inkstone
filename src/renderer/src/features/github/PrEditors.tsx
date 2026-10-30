import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { Avatar, Button, Dialog, DialogTrigger, IconButton, ListBox, ListBoxItem, Notice, Popover, SearchField, SegmentedControl, Skeleton, TextArea } from '../../ui'
import { Markdown } from '../session/Markdown'
import type { PrActionText } from './pr-action-text'

export interface MarkdownEditorProps {
  label: string
  value: string
  onChange: (value: string) => void
  text: PrActionText['edit']
  cwd: string
  placeholder?: string
  rows?: number
  testId?: string
  isDisabled?: boolean
  showLabel?: boolean
}

export function MarkdownEditor({ label, value, onChange, text, cwd, placeholder, rows = 8, testId, isDisabled, showLabel = true }: MarkdownEditorProps): ReactElement {
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  return (
    <div className="gh-pr-md" data-testid={testId}>
      <div className="gh-pr-md__bar">
        {showLabel ? <span className="gh-pr-md__label ui-field__label">{label}</span> : <span />}
        <SegmentedControl<'write' | 'preview'>
          label={text.mode}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'write', label: text.write, testId: testId ? `${testId}-write` : undefined },
            { value: 'preview', label: text.preview, testId: testId ? `${testId}-preview` : undefined }
          ]}
        />
      </div>
      {mode === 'write' ? (
        <TextArea aria-label={label} value={value} onChange={onChange} rows={rows} placeholder={placeholder} isDisabled={isDisabled} />
      ) : (
        <div className="gh-pr-md__preview">
          {value.trim() ? <Markdown text={value} sourceCwd={cwd} /> : <Notice variant="hint">{text.previewEmpty}</Notice>}
        </div>
      )}
    </div>
  )
}

export interface CandidatePickerProps {
  cwd: string
  kind: 'reviewers' | 'labels'
  label: string
  exclude: readonly string[]
  onPick: (name: string) => void
  text: PrActionText
  isDisabled?: boolean
  testId?: string
}

interface Candidate {
  id: string
  name: string
  detail: string
}

function CandidateList({ cwd, kind, label, exclude, onPick, text, close }: Omit<CandidatePickerProps, 'isDisabled' | 'testId'> & { close: () => void }): ReactElement {
  const [items, setItems] = useState<Candidate[] | null>(null)
  const [failure, setFailure] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    const github = window.yan?.github
    if (!github) {
      setItems([])
      return undefined
    }
    void github
      .candidates(cwd, { kind, perPage: 100 })
      .then((res) => {
        if (!alive) return
        if (!res.ok) {
          setFailure(res.failure?.message ?? '')
          setItems([])
          return
        }
        const next =
          kind === 'labels'
            ? (res.labels ?? []).map((item) => ({ id: item.name ?? '', name: item.name ?? '', detail: item.description ?? '' }))
            : (res.reviewers ?? []).map((item) => ({ id: item.login ?? '', name: item.login ?? '', detail: item.name ?? '' }))
        setItems(next.filter((item) => item.name))
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setFailure(cause instanceof Error ? cause.message : String(cause))
        setItems([])
      })
    return () => {
      alive = false
    }
  }, [cwd, kind])

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (items ?? []).filter((item) => !exclude.includes(item.name) && (!needle || item.name.toLowerCase().includes(needle) || item.detail.toLowerCase().includes(needle)))
  }, [items, exclude, query])

  return (
    <div className="gh-pr-cand">
      <SearchField aria-label={`${label} · ${text.edit.search}`} placeholder={text.edit.search} value={query} onChange={setQuery} autoFocus />
      {items === null ? (
        <div className="gh-pr-cand__loading" aria-busy="true">
          <Skeleton width="70%" />
          <Skeleton width="55%" />
          <Skeleton width="62%" />
        </div>
      ) : (
        <ListBox<Candidate>
          aria-label={label}
          items={options}
          selectionMode="none"
          className="gh-pr-cand__list"
          onAction={(key) => {
            onPick(String(key))
            close()
          }}
          renderEmptyState={() => <span className="gh-pr-cand__empty ui-meta-text">{failure ? `${text.edit.candidatesFailed}：${failure}` : items.length ? text.summary.searchEmpty : text.edit.noCandidates}</span>}
        >
          {(item) => (
            <ListBoxItem id={item.name} textValue={item.name}>
              <span className="gh-pr-cand__item">
                {kind === 'reviewers' ? <Avatar name={item.name} /> : null}
                <span>{item.name}</span>
                {item.detail ? <span className="gh-pr-cand__detail ui-meta-text">{item.detail}</span> : null}
              </span>
            </ListBoxItem>
          )}
        </ListBox>
      )}
    </div>
  )
}

export function CandidatePicker({ isDisabled, testId, ...props }: CandidatePickerProps): ReactElement {
  return (
    <DialogTrigger>
      <IconButton size="xs" variant="ghost" aria-label={props.label} tooltip={props.label} isDisabled={isDisabled} data-testid={testId}>
        <Plus size={12} aria-hidden />
      </IconButton>
      <Popover variant="panel" placement="bottom end" className="gh-pr-cand-pop">
        <Dialog aria-label={props.label} showClose={false} body="flush">
          {({ close }) => <CandidateList {...props} close={close} />}
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}

export interface EditFooterProps {
  text: PrActionText['edit']
  busy: boolean
  canSave: boolean
  onSave: () => void
  onCancel: () => void
  testId?: string
}

export function EditFooter({ text, busy, canSave, onSave, onCancel, testId }: EditFooterProps): ReactElement {
  return (
    <div className="gh-pr-act__footer">
      <Button size="sm" variant="ghost" onPress={onCancel} isDisabled={busy}>
        {text.cancel}
      </Button>
      <Button size="sm" variant="primary" onPress={onSave} isDisabled={!canSave} isPending={busy} data-testid={testId}>
        {text.save}
      </Button>
    </div>
  )
}
