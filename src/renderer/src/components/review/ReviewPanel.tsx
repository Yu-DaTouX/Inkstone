/**
 * 审查面板（方案 §3.2 / §4）。
 *
 * 位置：右栏的详情视图之一，但**优先级最高**，且打开时右栏会加宽
 *（`.app.review-on` 把 `--w-right` 换成审查档位）。为什么不去占主内容区：
 * 那样聊天会被卸载，滚动位置与输入草稿都要手工保存/恢复，而"并排看聊天
 * 与改动"本来就是审查时的常见需求（Codex 也是并排的）。
 *
 * ── 这个面板的硬约束 ──
 * 1. **只读**：所有数据都来自 `yan:git:*` 的只读查询。打开、刷新、切范围
 *    都不改变工作区与暂存区（真实仓库测试专门钉住这一条）。
 * 2. **不搬正文**：清单里没有 diff 正文，每个文件的 patch 在它被展开时
 *    才按需加载。
 * 3. **不伪造状态**：拿不到的行数显示为空、二进制明说不能显示文本差异、
 *    非 Git 目录说「未使用 Git」而不是给一个空的 diff。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitChangedFile, GitRefOption, GitScopeRequest } from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { ChangedFileTree, statusGlyph } from './ChangedFileTree'
import { DiffViewer, ImageDiff } from './DiffViewer'
import { patchKeyOf, usePatchStore, useReviewSnapshot, useSideContent, useViewedStore } from './useGitReview'

/** 打开时默认展开多少个文件的正文（小改动全展开，大改动先给前一批） */
const AUTO_EXPAND = 12

export function ReviewPanel() {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const scope = useStore((s) => s.reviewScope)
  const setReviewScope = useStore((s) => s.setReviewScope)
  const closeReview = useStore((s) => s.closeReview)
  const cwd = session?.cwd ?? settings?.cwd

  const [bump, setBump] = useState(0)
  const view = useReviewSnapshot(cwd, scope, true, bump)
  const files = view.snapshot?.files ?? []
  const requestId = view.snapshot?.requestId ?? ''
  const patches = usePatchStore(cwd, scope, requestId)
  const viewed = useViewedStore()
  const sides = useSideContent(cwd, scope, true)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)

  /* 新快照（换了范围或刷新）→ 重置展开态，默认展开前 AUTO_EXPAND 个 */
  useEffect(() => {
    const auto = files.slice(0, AUTO_EXPAND).map((f) => f.path)
    setExpanded(new Set(auto))
    setSelected((prev) => (prev && files.some((f) => f.path === prev) ? prev : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, scope.kind, scope.base, scope.target])

  /* 展开的文件才去要 patch（懒加载的全部意义所在） */
  useEffect(() => {
    for (const f of files) if (expanded.has(f.path)) patches.ensure(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, files, requestId])

  const toggle = useCallback((path: string) => {
    setExpanded((p) => {
      const next = new Set(p)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const jumpTo = useCallback((f: GitChangedFile) => {
    setSelected(f.path)
    setExpanded((p) => new Set(p).add(f.path))
    requestAnimationFrame(() => {
      streamRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(f.path)}"]`)?.scrollIntoView({
        behavior: 'auto',
        block: 'start'
      })
    })
  }, [])

  const identity = view.identity
  const viewedCount = useMemo(
    () => files.reduce((n, f) => n + (viewed.isViewed(f, identity) ? 1 : 0), 0),
    [files, identity, viewed]
  )

  const rangeMode = scope.kind === 'range'
  const stats = view.snapshot?.stats
  const notes = view.snapshot?.notes ?? []

  return (
    <div className={`review ${rangeMode ? 'range' : ''}`} data-testid="review-panel">
      <div className="review-head">
        <select
          className="review-scope"
          value={scope.kind}
          data-testid="review-scope"
          aria-label={t('review.scopeLabel')}
          onChange={(e) => {
            const kind = e.target.value as GitScopeRequest['kind']
            if (kind === 'range') {
              setReviewScope({ kind: 'range', base: scope.base ?? 'HEAD~1', target: scope.target ?? 'HEAD' })
              return
            }
            setReviewScope({ kind })
          }}
        >
          {(['working', 'unstaged', 'staged', 'range'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`review.scope.${k}` as 'review.scope.working')}
            </option>
          ))}
        </select>

        {stats ? (
          <span className="review-stat" data-testid="review-stats">
            <span className="review-stat-files">{t('review.fileCount', { n: stats.files })}</span>
            <span className="add">+{stats.additions}</span>
            <span className="del">-{stats.deletions}</span>
            {stats.binary > 0 ? <span className="review-stat-bin">{t('review.binaryCount', { n: stats.binary })}</span> : null}
          </span>
        ) : null}

        <span className="spacer" />

        <button
          type="button"
          className="review-act"
          title={t('review.markAllViewed')}
          aria-label={t('review.markAllViewed')}
          data-testid="review-mark-all"
          disabled={!files.length}
          onClick={() => viewed.markAll(files, identity)}
        >
          <Icon name="check-circle" size={12} />
        </button>
        <button
          type="button"
          className="review-act"
          title={t('review.refresh')}
          aria-label={t('review.refresh')}
          data-testid="review-refresh"
          onClick={() => {
            patches.clear()
            setBump((v) => v + 1)
          }}
        >
          <Icon name="refresh" size={12} />
        </button>
        <button
          type="button"
          className="review-act"
          title={t('review.close')}
          aria-label={t('review.close')}
          data-testid="review-close"
          onClick={closeReview}
        >
          <Icon name="menu" size={12} />
        </button>
      </div>

      {rangeMode ? <RangeBar scope={scope} cwd={cwd} onChange={setReviewScope} /> : null}

      {notes.length ? (
        <div className="review-notes" data-testid="review-notes">
          {notes.map((n) => (
            <div className="review-note" key={n}>
              {n}
            </div>
          ))}
        </div>
      ) : null}

      {view.error ? (
        <div className="review-error" data-testid="review-error">
          {view.error}
        </div>
      ) : null}

      <div className="review-body">
        <div className="review-stream" ref={streamRef} data-testid="review-stream">
          {!view.snapshot && !view.error ? <div className="review-hint">{t('review.loading')}</div> : null}

          {view.snapshot && !view.snapshot.repo ? (
            <div className="review-hint" data-testid="review-notgit">
              {t('review.notGit')}
            </div>
          ) : null}

          {view.snapshot?.repo && files.length === 0 && !view.error ? (
            <div className="review-hint" data-testid="review-empty">
              {t('review.noChanges')}
            </div>
          ) : null}

          {files.map((f) => (
            <FileCard
              key={f.path}
              file={f}
              open={expanded.has(f.path)}
              onToggle={() => toggle(f.path)}
              patch={patches.patches[patchKeyOf(f)]}
              viewed={viewed.isViewed(f, identity)}
              onViewed={(next) => (next ? viewed.mark(f, identity) : viewed.unmark(f, identity))}
              sides={sides}
              scopeKind={scope.kind}
            />
          ))}

          {view.snapshot?.truncated ? (
            <div className="review-hint" data-testid="review-truncated">
              {t('review.truncatedList')}
            </div>
          ) : null}
        </div>

        <div className="review-side">
          <ChangedFileTree
            files={files}
            selected={selected}
            onSelect={jumpTo}
            isViewed={(f) => viewed.isViewed(f, identity)}
            viewedCount={viewedCount}
          />
        </div>
      </div>
    </div>
  )
}

/* ── 两端比较的基准选择 ─────────────────────────────────── */

function RangeBar({
  scope,
  cwd,
  onChange
}: {
  scope: GitScopeRequest
  cwd: string | undefined
  onChange: (s: GitScopeRequest) => void
}) {
  const t = useT()
  const [refs, setRefs] = useState<GitRefOption[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!cwd) return
    let alive = true
    void window.yan.git
      .refs(cwd)
      .then((res) => {
        if (!alive) return
        setRefs(res.refs)
        setError(res.ok ? '' : (res.error ?? ''))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cwd])

  /* 当前值不在列表里（例如 HEAD~1）也要能显示 —— 否则 select 会静默重置 */
  const options = useMemo(() => {
    const list = [...refs]
    for (const v of [scope.base, scope.target]) {
      if (v && !list.some((r) => r.ref === v)) {
        list.unshift({ ref: v, label: v, kind: 'head', current: false })
      }
    }
    return list
  }, [refs, scope.base, scope.target])

  return (
    <div className="review-range" data-testid="review-range">
      <select
        className="review-ref"
        value={scope.base ?? ''}
        aria-label={t('review.base')}
        data-testid="review-base"
        onChange={(e) => onChange({ ...scope, base: e.target.value })}
      >
        {options.map((r) => (
          <option key={`b-${r.ref}`} value={r.ref}>
            {r.kind === 'remote' ? `${r.ref} (${t('review.remoteRef')})` : r.ref}
          </option>
        ))}
      </select>
      <span className="review-arrow" aria-hidden="true">→</span>
      <select
        className="review-ref"
        value={scope.target ?? ''}
        aria-label={t('review.target')}
        data-testid="review-target"
        onChange={(e) => onChange({ ...scope, target: e.target.value })}
      >
        {options.map((r) => (
          <option key={`t-${r.ref}`} value={r.ref}>
            {r.kind === 'remote' ? `${r.ref} (${t('review.remoteRef')})` : r.ref}
          </option>
        ))}
      </select>
      {error ? <span className="review-range-err">{error}</span> : null}
    </div>
  )
}

/* ── 单个文件的卡片 ─────────────────────────────────────── */

function FileCard({
  file,
  open,
  onToggle,
  patch,
  viewed,
  onViewed,
  sides,
  scopeKind
}: {
  file: GitChangedFile
  open: boolean
  onToggle: () => void
  patch: ReturnType<typeof usePatchStore>['patches'][string] | undefined
  viewed: boolean
  onViewed: (next: boolean) => void
  sides: ReturnType<typeof useSideContent>
  scopeKind: GitScopeRequest['kind']
}) {
  const t = useT()
  const isImage = file.kind === 'image'

  /* 图片：两侧内容都在展开时才请求（未展开的图片文件不该产生两次 IPC） */
  const oldContent = sides.cache[`old|${file.path}`]
  const newContent = sides.cache[`new|${file.path}`]

  useEffect(() => {
    if (!open || !isImage) return
    if (!oldContent) void sides.load(file.path, 'old')
    if (!newContent) void sides.load(file.path, 'new')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isImage, file.path, oldContent, newContent])

  return (
    <section className={`rcard ${viewed ? 'viewed' : ''}`} data-file={file.path} data-testid="review-file">
      <header className="rcard-head">
        <button
          type="button"
          className="rcard-toggle"
          onClick={onToggle}
          aria-expanded={open}
          data-testid="review-file-toggle"
        >
          <span className={`chev ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
          <span className={`rtree-glyph st-${file.status}`} aria-hidden="true">{statusGlyph(file.status)}</span>
          {file.oldPath ? <span className="rcard-old">{file.oldPath} →</span> : null}
          <span className="rcard-path" title={file.path}>
            {file.path}
          </span>
        </button>

        <span className="rcard-stat">
          {file.additions ? <span className="add">+{file.additions}</span> : null}
          {file.deletions ? <span className="del">-{file.deletions}</span> : null}
          {!file.additions && !file.deletions ? (
            <span className="rcard-nostat">{t('review.noLineStat')}</span>
          ) : null}
        </span>

        <button
          type="button"
          className={`rcard-viewed ${viewed ? 'on' : ''}`}
          data-testid="review-viewed"
          title={viewed ? t('review.viewedOn') : t('review.viewed')}
          onClick={() => onViewed(!viewed)}
        >
          <Icon name={viewed ? 'check-circle' : 'check'} size={12} />
          <span>{viewed ? t('review.viewedOn') : t('review.viewed')}</span>
        </button>
      </header>

      {open ? (
        <div className="rcard-body">
          {isImage ? (
            <ImageDiff
              old={{
                label: scopeKind === 'unstaged' ? t('review.sideIndex') : t('review.sideOld'),
                content: oldContent ?? 'loading'
              }}
              now={{
                label: scopeKind === 'staged' ? t('review.sideIndex') : t('review.sideNew'),
                content: newContent ?? 'loading'
              }}
            />
          ) : !patch ? (
            <div className="rdiff-note">{t('review.loading')}</div>
          ) : patch.status === 'loading' ? (
            <div className="rdiff-note">{t('review.loading')}</div>
          ) : patch.status === 'error' ? (
            <div className="rdiff-note err">{t('review.loadFailed', { msg: patch.error })}</div>
          ) : (
            <DiffViewer patch={patch.patch} load={sides.load} />
          )}
        </div>
      ) : null}
    </section>
  )
}
