import { useCallback, useEffect, useRef, useState } from 'react'
import { createLatestOnly, type LatestOnly } from '../../lib/latest-only'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type { KnowledgeActionRequest, KnowledgeEntryView, KnowledgeListView, KnowledgeScope } from '../../../../shared/ipc'
import { Button, SettingRow } from '../ui'

export function KnowledgeTab() {
  const t = useT()
  const [exportText, setExportText] = useState('')
  const tk = (key: string): string => t(key as MessageKey)
  const switchSession = useStore((s) => s.switchSession)
  const closeSettings = useStore((s) => s.closeSettings)
  const sessionCwd = useStore((s) => s.session?.cwd)

  const [view, setView] = useState<KnowledgeListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [filter, setFilter] = useState<'active' | 'candidate' | 'review'>('active')
  const [scope, setScope] = useState<KnowledgeScope>('project')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [replacing, setReplacing] = useState<{ id: string; text: string } | null>(null)
  const [asking, setAsking] = useState<{ id: string; permanent: boolean } | null>(null)

  const guardRef = useRef<LatestOnly | null>(null)
  if (guardRef.current === null) guardRef.current = createLatestOnly()
  const projectRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const guard = guardRef.current as LatestOnly
    const token = guard.begin()
    setLoading(true)
    try {
      const next = await window.yan.knowledge.list(scope)
      if (!guard.isCurrent(token)) return
      setView(next)
      if ((next.projectId ?? null) !== projectRef.current) {
        projectRef.current = next.projectId ?? null
        setEditing(null)
        setReplacing(null)
        setAsking(null)
      }
    } catch (error) {
      if (!guard.isCurrent(token)) return
      setView({
        ok: false,
        enabled: false,
        entries: [],
        counts: { all: 0, active: 0, candidate: 0, review: 0 },
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (guard.isCurrent(token)) setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh, sessionCwd])

  useEffect(
    () => () => {
      ;(guardRef.current as LatestOnly).invalidate()
    },
    []
  )

  const entries = view?.entries ?? []
  const counts = view?.counts ?? { all: 0, active: 0, candidate: 0, review: 0 }
  const shown = entries.filter((entry) => {
    if (filter === 'active') return entry.status === 'active'
    if (filter === 'candidate') return entry.status === 'candidate'
    return entry.review.needed
  })

  const runAction = async (id: string, req: KnowledgeActionRequest): Promise<boolean> => {
    setBusy(id)
    setNotice(null)
    try {
      const res = await window.yan.knowledge.action({ ...req, expectedProjectId: view?.projectId, scope })
      if (!res.ok) {
        const text =
          res.latestRevision !== undefined
            ? `${res.error ?? tk('set.knFailed')}${t('set.knStale', { n: res.latestRevision })}`
            : (res.error ?? tk('set.knFailed'))
        setNotice({ kind: 'err', text })
        await refresh()
        return false
      }
      setNotice({ kind: 'ok', text: tk('set.knSaved') })
      setEditing(null)
      setReplacing(null)
      setAsking(null)
      await refresh()
      return true
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : tk('set.knFailed') })
      return false
    } finally {
      setBusy(null)
    }
  }

  const jumpTo = async (sessionId: string): Promise<void> => {
    setBusy(sessionId)
    setNotice(null)
    try {
      const res = await window.yan.knowledge.sourceSession(sessionId)
      if (!res.ok || !res.path) {
        setNotice({ kind: 'err', text: res.error ?? tk('set.knSourceGone') })
        return
      }
      closeSettings()
      await switchSession(res.path)
    } catch (error) {
      setNotice({
        kind: 'err',
        text: error instanceof Error ? error.message : tk('set.knIpcFailed')
      })
    } finally {
      setBusy(null)
    }
  }

  const exportMarkdown = async (mode: 'copy' | 'save'): Promise<void> => {
    setBusy('__export__')
    setNotice(null)
    try {
      const res = await window.yan.knowledge.export(mode, scope)
      if (!res.ok) {
        setNotice({ kind: 'err', text: res.error ?? tk('set.knFailed') })
        return
      }
      if (mode === 'copy' && res.markdown) {
        try {
          await navigator.clipboard.writeText(res.markdown)
          setNotice({ kind: 'ok', text: tk('set.knExported') })
        } catch {
          setExportText(res.markdown)
          setNotice({ kind: 'err', text: tk('set.knExportManual') })
        }
        return
      }
      if (res.canceled) return
      setNotice({ kind: 'ok', text: `${tk('set.knExportSaved')}：${res.path ?? ''}` })
    } catch (error) {
      setNotice({
        kind: 'err',
        text: error instanceof Error ? error.message : tk('set.knIpcFailed')
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ui-rows">
      <SettingRow name={tk('set.knowledge')} desc={<span data-testid="kn-desc">{tk('ctx.nativeMaterials')}</span>} />

      <SettingRow
        name={tk('set.knScope')}
        desc={
          <span className="set-path" data-testid="kn-project">
            {scope === 'personal'
              ? tk('set.knPersonalDesc')
              : view?.projectId ?? (loading ? '…' : tk('set.knNoProject'))}
          </span>
        }
        ctlClassName="seg"
        ctlProps={{ 'data-testid': 'kn-scope' }}
      >
        {(['project', 'personal'] as const).map((id) => (
          <button
            key={id}
            className={`seg-btn ${scope === id ? 'sel' : ''}`}
            data-testid={`kn-scope-${id}`}
            onClick={() => setScope(id)}
          >
            {tk(id === 'project' ? 'set.knScopeProject' : 'set.knScopePersonal')}
          </button>
        ))}
      </SettingRow>

      <div className="ui-row kn-filter-row">
        <div className="seg sm kn-filter" data-testid="kn-filter">
          {(
            [
              ['active', 'set.knFilterActive', counts.active],
              ['candidate', 'set.knFilterCandidate', counts.candidate],
              ['review', 'set.knFilterReview', counts.review]
            ] as const
          ).map(([id, key, count]) => (
            <button
              key={id}
              className={`seg-btn ${filter === id ? 'sel' : ''}`}
              data-testid={`kn-filter-${id}`}
              onClick={() => setFilter(id)}
            >
              {tk(key)} {count}
            </button>
          ))}
        </div>
        {view?.error ? (
          <div className="ui-row-desc kn-err" data-testid="kn-error">
            {view.error}
            <Button size="sm" variant="ghost" className="kn-retry" onClick={() => void refresh()} data-testid="kn-retry">
              {tk('set.knRetry')}
            </Button>
          </div>
        ) : null}
      </div>

      {loading && !view ? <div className="ui-row-desc" role="status">{tk('browser.loading')}</div> : null}
      {shown.length === 0 ? (
        <div className="ui-row col">
          <div className="ui-row-desc" data-testid="kn-empty">
            {!view?.projectId ? tk('set.knNoProject') : entries.length === 0 ? tk('set.knEmpty') : tk('set.knEmptyFilter')}
          </div>
        </div>
      ) : (
        shown.map((entry) => (
          <KnowledgeRow
            key={entry.id}
            entry={entry}
            busy={busy === entry.id}
            editing={editing?.id === entry.id ? editing.text : null}
            replacing={replacing?.id === entry.id ? replacing.text : null}
            asking={asking?.id === entry.id ? asking.permanent : null}
            onStartEdit={() => setEditing({ id: entry.id, text: entry.text })}
            onEdit={setEditing}
            onStartReplace={() => setReplacing({ id: entry.id, text: entry.text })}
            onReplace={setReplacing}
            onAskDelete={(permanent) => setAsking({ id: entry.id, permanent })}
            onCancel={() => {
              setEditing(null)
              setReplacing(null)
              setAsking(null)
            }}
            onConfirm={() => void runAction(entry.id, { action: 'confirm', id: entry.id, expectedRevision: entry.revision })}
            onSave={(text) =>
              void runAction(entry.id, { action: 'update', id: entry.id, expectedRevision: entry.revision, text })
            }
            onSupersede={(text) =>
              void runAction(entry.id, {
                action: 'supersede',
                id: entry.id,
                expectedRevision: entry.revision,
                text
              })
            }
            onDelete={(permanent) =>
              void runAction(entry.id, { action: 'delete', id: entry.id, expectedRevision: entry.revision, permanent })
            }
            onJump={(sessionId) => void jumpTo(sessionId)}
            tk={tk}
          />
        ))
      )}

      {exportText ? <textarea className="ui-input" readOnly rows={12} value={exportText} aria-label={tk('set.knExport')} /> : null}
      <SettingRow name={tk('set.knExport')} desc={tk('set.knExportHint')}>
        <Button size="sm" variant="ghost" disabled={busy === '__export__'} onClick={() => void exportMarkdown('copy')} data-testid="kn-export-copy">
          {tk('set.knExportCopy')}
        </Button>
        <Button size="sm" disabled={busy === '__export__'} onClick={() => void exportMarkdown('save')} data-testid="kn-export-save">
          {tk('set.knExportSave')}
        </Button>
      </SettingRow>

      {notice ? (
        <div className={`ui-row col kn-notice ${notice.kind}`} data-testid="kn-notice">
          <div className="ui-row-desc">{notice.text}</div>
        </div>
      ) : null}
    </div>
  )
}

function KnowledgeRow({
  entry,
  busy,
  editing,
  replacing,
  asking,
  onStartEdit,
  onEdit,
  onStartReplace,
  onReplace,
  onAskDelete,
  onCancel,
  onConfirm,
  onSave,
  onSupersede,
  onDelete,
  onJump,
  tk
}: {
  entry: KnowledgeEntryView
  busy: boolean
  editing: string | null
  replacing: string | null
  asking: boolean | null
  onStartEdit: () => void
  onEdit: (v: { id: string; text: string }) => void
  onStartReplace: () => void
  onReplace: (v: { id: string; text: string }) => void
  onAskDelete: (permanent: boolean) => void
  onCancel: () => void
  onConfirm: () => void
  onSave: (text: string) => void
  onSupersede: (text: string) => void
  onDelete: (permanent: boolean) => void
  onJump: (sessionId: string) => void
  tk: (key: string) => string
}) {
  const kindLabel = tk(`set.knKind.${entry.kind}`)
  return (
    <div className="ui-row col kn-item" data-testid={`kn-item-${entry.id}`}>
      <div className="set-ctrow">
        <div className="ui-row-label">
          <span className="ui-row-name">
            {kindLabel} · <span className="kn-id">{entry.id}</span>
          </span>
          <span className="ui-row-desc">
            <span className={`kn-badge st-${entry.status}`}>{tk(`set.knStatus.${entry.status}`)}</span>
            <span className="kn-badge">{tk(`set.knConfidence.${entry.confidenceClass}`)}</span>
          </span>
        </div>
        <div className="ui-row-ctl kn-actions">
          {entry.status === 'candidate' ? (
            <Button disabled={busy} onClick={onConfirm} data-testid={`kn-confirm-${entry.id}`}>
              {tk('set.knConfirm')}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onStartEdit} data-testid={`kn-edit-${entry.id}`}>
            {tk('set.knEdit')}
          </Button>
          <Button disabled={busy} onClick={onStartReplace} data-testid={`kn-replace-${entry.id}`}>
            {tk('set.knReplace')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => onAskDelete(false)} data-testid={`kn-delete-${entry.id}`}>
            {tk('set.knDelete')}
          </Button>
        </div>
      </div>

      {editing !== null ? (
        <div className="kn-editor">
          <textarea
            className="kn-textarea"
            value={editing}
            data-testid={`kn-editor-${entry.id}`}
            onChange={(event) => onEdit({ id: entry.id, text: event.target.value })}
          />
          <div className="ui-row-ctl">
            <Button disabled={busy || !editing.trim()} onClick={() => onSave(editing)} data-testid={`kn-save-${entry.id}`}>
              {tk('set.knSave')}
            </Button>
            <Button onClick={onCancel}>
              {tk('set.knCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="kn-text">{entry.text}</div>
      )}

      {replacing !== null ? (
        <div className="kn-editor">
          <div className="ui-row-desc">{tk('set.knReplaceHint')}</div>
          <textarea
            className="kn-textarea"
            value={replacing}
            data-testid={`kn-replace-editor-${entry.id}`}
            onChange={(event) => onReplace({ id: entry.id, text: event.target.value })}
          />
          <div className="ui-row-ctl">
            <Button disabled={busy || !replacing.trim()} onClick={() => onSupersede(replacing)} data-testid={`kn-replace-save-${entry.id}`}>
              {tk('set.knReplaceSave')}
            </Button>
            <Button onClick={onCancel}>
              {tk('set.knCancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {asking !== null ? (
        <div className="kn-editor kn-ask">
          <div className="ui-row-desc">{tk('set.knDeleteAsk')}</div>
          <div className="ui-row-ctl">
            <Button disabled={busy} onClick={() => onDelete(false)} data-testid={`kn-delete-logical-${entry.id}`}>
              {tk('set.knDeleteLogical')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => onDelete(true)} data-testid={`kn-delete-permanent-${entry.id}`}>
              {tk('set.knDeletePermanent')}
            </Button>
            <Button onClick={onCancel}>
              {tk('set.knCancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="ui-row-desc kn-meta">
        {entry.tags.length ? (
          <span>
            {tk('set.knTags')}：{entry.tags.join('、')}
          </span>
        ) : null}
        <span>
          {tk('set.knSource')}：
          {entry.evidence.length === 0 ? (
            <span>{tk('set.knNoEvidence')}</span>
          ) : (
            entry.evidence.map((item, index) => (
              <span key={index} className="kn-evidence">
                {item.file ? <code>{item.file}</code> : null}
                {item.sessionId ? (
                  <>
                    <button
                      className="kn-link"
                      disabled={!item.readable}
                      title={item.readable ? tk('set.knJump') : tk('set.knSourceGone')}
                      onClick={() => onJump(item.sessionId as string)}
                      data-testid={`kn-jump-${entry.id}`}
                    >
                      {tk('set.knSourceSession')} {item.sessionId.slice(0, 8)}
                    </button>
                    {!item.readable ? <span className="kn-gone">{tk('set.knSourceGone')}</span> : null}
                  </>
                ) : null}
                {item.excerpt ? <span className="kn-excerpt">「{item.excerpt}」</span> : null}
              </span>
            ))
          )}
        </span>
        {entry.validFor ? (
          <span>
            {tk('set.knScope')}：
            {[
              entry.validFor.branch ? `${tk('set.knBranch')} ${entry.validFor.branch}` : '',
              entry.validFor.commit ? `commit ${entry.validFor.commit.slice(0, 8)}` : '',
              entry.validFor.paths?.length ? entry.validFor.paths.join('、') : ''
            ]
              .filter(Boolean)
              .join(' / ')}
          </span>
        ) : null}
        {entry.supersedes?.length ? (
          <span>
            {tk('set.knSupersedes')}：{entry.supersedes.join('、')}
          </span>
        ) : null}
        {entry.review.needed ? (
          <span className="kn-review" data-testid={`kn-review-${entry.id}`}>
            {tk('set.knReview')}：{entry.review.reasons.map((reason) => tk(`set.knReview.${reason}`)).join('、')}
          </span>
        ) : null}
        <span>{`${tk('set.knUpdated')} ${entry.updatedAt.slice(0, 16).replace('T', ' ')} · rev ${entry.revision}`}</span>
      </div>
    </div>
  )
}
