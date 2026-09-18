import { useCallback, useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type { KnowledgeActionRequest, KnowledgeEntryView, KnowledgeListView } from '../../../../shared/ipc'

/**
 * 「项目知识」设置页（实施-03 S5）。
 *
 * 这一页要回答三个问题，顺序也就是界面的顺序：
 *   ① **开不开**：检索开关（默认关）。关掉就停止检索 / 注入 —— 页面本身还能看历史条目；
 *   ② **有哪些**：已确认 / 待确认 / 需复核三种筛选。**需复核是派生状态**
 *      （分支变了、引用路径没了、来源会话被删），由主进程判断后随列表下来；
 *   ③ **怎么处置**：确认（候选 → 已确认）、编辑、替代（新条目取代旧条目）、删除。
 *
 * 三条不可越过的口径（与主进程一致，见 `main/index.ts` 的 `yan:knowledge:*`）：
 *   · 身份只认**当前会话绑定的项目** —— 界面没有「切项目看别人的知识」这种入口；
 *   · 每条写操作都带 `expectedRevision`：磁盘上已经变了就报错让你刷新，**不静默覆盖**；
 *   · 「确认」是**用户动作**，界面显示的是真实来源与状态，不显示可信度百分比。
 */
export function KnowledgeTab() {
  const t = useT()
  /* 运行期拼出来的 key（筛选项 / 复核原因），i18n 的 key 是编译期联合类型，这里集中断言一次 */
  const tk = (key: string): string => t(key as MessageKey)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const switchSession = useStore((s) => s.switchSession)
  const closeSettings = useStore((s) => s.closeSettings)
  const enabled = settings?.projectKnowledge?.enabled === true

  const [view, setView] = useState<KnowledgeListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [filter, setFilter] = useState<'active' | 'candidate' | 'review'>('active')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [replacing, setReplacing] = useState<{ id: string; text: string } | null>(null)
  const [asking, setAsking] = useState<{ id: string; permanent: boolean } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setView(await window.yan.knowledge.list())
    } catch (error) {
      setView({
        ok: false,
        enabled,
        entries: [],
        counts: { all: 0, active: 0, candidate: 0, review: 0 },
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const entries = view?.entries ?? []
  const counts = view?.counts ?? { all: 0, active: 0, candidate: 0, review: 0 }
  const shown = entries.filter((entry) => {
    /*
     * 「已确认」= 所有 active（**包括**需复核的那几条）：它们仍然是已确认的知识，
     * 把它从这一栏里藏起来用户就找不到了。「需复核」是一个**跨越状态**的视图。
     */
    if (filter === 'active') return entry.status === 'active'
    if (filter === 'candidate') return entry.status === 'candidate'
    return entry.review.needed
  })

  const runAction = async (id: string, req: KnowledgeActionRequest): Promise<boolean> => {
    setBusy(id)
    setNotice(null)
    try {
      const res = await window.yan.knowledge.action(req)
      if (!res.ok) {
        /*
         * CAS 冲突要说清是「有人先改了」而不是「你没权限」——
         * `latestRevision` 存在就说明磁盘上有更新的一版。
         */
        const text =
          res.latestRevision !== undefined
            ? `${res.error ?? tk('set.knFailed')}（磁盘上是第 ${res.latestRevision} 版，刷新后再改）`
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

  /** 来源跳转：拿会话文件路径（只有主进程知道）→ 切会话 → 关设置。 */
  const jumpTo = async (sessionId: string): Promise<void> => {
    setBusy(sessionId)
    try {
      const res = await window.yan.knowledge.sourceSession(sessionId)
      if (!res.ok || !res.path) {
        setNotice({ kind: 'err', text: res.error ?? tk('set.knSourceGone') })
        return
      }
      closeSettings()
      await switchSession(res.path)
    } finally {
      setBusy(null)
    }
  }

  const exportMarkdown = async (mode: 'copy' | 'save'): Promise<void> => {
    setBusy('__export__')
    setNotice(null)
    try {
      const res = await window.yan.knowledge.export(mode)
      if (!res.ok) {
        setNotice({ kind: 'err', text: res.error ?? tk('set.knFailed') })
        return
      }
      if (mode === 'copy' && res.markdown) {
        try {
          await navigator.clipboard.writeText(res.markdown)
          setNotice({ kind: 'ok', text: tk('set.knExported') })
        } catch {
          /* 剪贴板被拒（无权限）：把正文塞进 textarea 让用户自己复制，不静默失败 */
          setEditing({ id: '__export__', text: res.markdown })
          setNotice({ kind: 'err', text: tk('set.knExportManual') })
        }
        return
      }
      if (res.canceled) return
      setNotice({ kind: 'ok', text: `${tk('set.knExportSaved')}：${res.path ?? ''}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="set-group">
      {/* ① 开关 */}
      <div className="set-row col">
        <div className="set-ctrow">
          <div className="set-label">
            <span className="set-name">{tk('set.knTitle')}</span>
          </div>
          <div className="set-ctl seg" data-testid="kn-toggle">
            <button
              className="seg-btn"
              data-testid="kn-toggle-btn"
              onClick={() => void patchSettings({ projectKnowledge: { enabled: !enabled } })}
            >
              {tk(enabled ? 'set.knOn' : 'set.knOff')}
            </button>
          </div>
        </div>
        <div className="set-desc">
          <span className="set-tag kn-tagline">{tk('set.knTag')}</span>
        </div>
        <div className="set-desc" data-testid="kn-desc">
          {tk(enabled ? 'set.knDescOn' : 'set.knDescOff')}
        </div>
      </div>

      {/* ② 状态 + 筛选 */}
      <div className="set-row col">
        <div className="set-ctrow">
          <div className="set-label">
            <span className="set-name">{tk('set.knProject')}</span>
            <div className="set-desc set-path" data-testid="kn-project">
              {view?.projectId ?? (loading ? '…' : tk('set.knNoProject'))}
            </div>
          </div>
          <div className="set-ctl seg kn-filter" data-testid="kn-filter">
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
        </div>
        {view?.error ? (
          <div className="set-desc kn-err" data-testid="kn-error">
            {view.error}
            <button className="btn kn-inline-btn" onClick={() => void refresh()} data-testid="kn-retry">
              {tk('set.knRetry')}
            </button>
          </div>
        ) : null}
      </div>

      {/* ③ 列表 */}
      {shown.length === 0 ? (
        <div className="set-row col">
          <div className="set-desc" data-testid="kn-empty">
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

      {/* ④ 导出 */}
      <div className="set-row col">
        <div className="set-ctrow">
          <div className="set-label">
            <span className="set-name">{tk('set.knExport')}</span>
            <div className="set-desc">{tk('set.knExportHint')}</div>
          </div>
          <div className="set-ctl">
            <button className="btn" disabled={busy === '__export__'} onClick={() => void exportMarkdown('copy')} data-testid="kn-export-copy">
              {tk('set.knExportCopy')}
            </button>
            <button className="btn" disabled={busy === '__export__'} onClick={() => void exportMarkdown('save')} data-testid="kn-export-save">
              {tk('set.knExportSave')}
            </button>
          </div>
        </div>
      </div>

      {notice ? (
        <div className={`set-row col kn-notice ${notice.kind}`} data-testid="kn-notice">
          <div className="set-desc">{notice.text}</div>
        </div>
      ) : null}
    </div>
  )
}

/** 一条知识。编辑 / 替代 / 删除都在这张卡里就地展开，不弹二级对话框。 */
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
    <div className="set-row col kn-item" data-testid={`kn-item-${entry.id}`}>
      <div className="set-ctrow">
        <div className="set-label">
          {/* 标题行只放「类型 · id」，正文在下面出**一次** —— 两处都放正文会让同一条看起来像两条（首版就是这个毛病，视觉矩阵抓到的） */}
          <span className="set-name">
            {kindLabel} · <span className="kn-id">{entry.id}</span>
          </span>
          <span className="set-desc">
            <span className={`kn-badge st-${entry.status}`}>{tk(`set.knStatus.${entry.status}`)}</span>
            <span className="kn-badge">{tk(`set.knConfidence.${entry.confidenceClass}`)}</span>
          </span>
        </div>
        <div className="set-ctl kn-actions">
          {entry.status === 'candidate' ? (
            <button className="btn" disabled={busy} onClick={onConfirm} data-testid={`kn-confirm-${entry.id}`}>
              {tk('set.knConfirm')}
            </button>
          ) : null}
          <button className="btn" disabled={busy} onClick={onStartEdit} data-testid={`kn-edit-${entry.id}`}>
            {tk('set.knEdit')}
          </button>
          <button className="btn" disabled={busy} onClick={onStartReplace} data-testid={`kn-replace-${entry.id}`}>
            {tk('set.knReplace')}
          </button>
          <button className="btn danger" disabled={busy} onClick={() => onAskDelete(false)} data-testid={`kn-delete-${entry.id}`}>
            {tk('set.knDelete')}
          </button>
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
          <div className="set-ctl">
            <button className="btn" disabled={busy || !editing.trim()} onClick={() => onSave(editing)} data-testid={`kn-save-${entry.id}`}>
              {tk('set.knSave')}
            </button>
            <button className="btn" onClick={onCancel}>
              {tk('set.knCancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="kn-text">{entry.text}</div>
      )}

      {replacing !== null ? (
        <div className="kn-editor">
          <div className="set-desc">{tk('set.knReplaceHint')}</div>
          <textarea
            className="kn-textarea"
            value={replacing}
            data-testid={`kn-replace-editor-${entry.id}`}
            onChange={(event) => onReplace({ id: entry.id, text: event.target.value })}
          />
          <div className="set-ctl">
            <button
              className="btn"
              disabled={busy || !replacing.trim()}
              onClick={() => onSupersede(replacing)}
              data-testid={`kn-replace-save-${entry.id}`}
            >
              {tk('set.knReplaceSave')}
            </button>
            <button className="btn" onClick={onCancel}>
              {tk('set.knCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {asking !== null ? (
        <div className="kn-editor kn-ask">
          <div className="set-desc">{tk('set.knDeleteAsk')}</div>
          <div className="set-ctl">
            <button className="btn" disabled={busy} onClick={() => onDelete(false)} data-testid={`kn-delete-logical-${entry.id}`}>
              {tk('set.knDeleteLogical')}
            </button>
            <button className="btn danger" disabled={busy} onClick={() => onDelete(true)} data-testid={`kn-delete-permanent-${entry.id}`}>
              {tk('set.knDeletePermanent')}
            </button>
            <button className="btn" onClick={onCancel}>
              {tk('set.knCancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="set-desc kn-meta">
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
