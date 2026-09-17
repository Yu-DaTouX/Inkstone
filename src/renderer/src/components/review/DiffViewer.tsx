/**
 * 单个文件的差异呈现：文本（结构化 hunk）与图片（前后对照）。
 *
 * 为什么不用「把 patch 塞进 `<pre>`」那种做法（现有工具卡就是那样）：
 * 审查面板要能**逐文件折叠、定位到某一行、记住已查看进度**，
 * 这些都需要行号与行类型是数据而不是字符串。结构化之后还能顺便做
 * 「未修改的 N 行」折叠块 —— 长文件里真正要看的就是那几行改动。
 *
 * 「N 行未修改」是**真的能展开**的：点它去要该文件的原文（同一条
 * content 通道，与图片共用），再按行号切出那一段。不做成装饰性分隔条 ——
 * 一个点了没反应的控件比没有这个控件更糟。
 *
 * 不做语法高亮：diff 的可读性主要来自增删底色与行号对齐，
 * 而给上万个 diff 行跑 highlight.js 会让滚动明显变卡（实测过的取舍）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { GitFileContent, GitFilePatch } from '../../../../shared/ipc'
import { gapRanges } from '../../../../shared/git'
import { useT } from '../../i18n'

/** 一次最多展开多少行上下文（一个巨大的未修改区不能把界面铺满） */
const MAX_GAP_LINES = 300

export interface SideLoader {
  (path: string, side: 'old' | 'new'): Promise<GitFileContent>
}

export function DiffViewer({ patch, load }: { patch: GitFilePatch; load: SideLoader }) {
  const t = useT()
  const gaps = useMemo(() => gapRanges(patch.hunks), [patch.hunks])
  /**
   * 已经展开的未修改区（键是 hunk 下标）。
   * 展开后的行是**真的内容**，不是占位符。
   */
  const [opened, setOpened] = useState<Record<number, GapLines>>({})

  useEffect(() => {
    setOpened({})
  }, [patch.path, patch.requestId])

  if (patch.binary || patch.kind === 'binary' || patch.kind === 'submodule' || patch.kind === 'lfs') {
    return <div className="rdiff-note">{kindNote(patch.kind, t)}</div>
  }
  if (!patch.hunks.length) {
    return <div className="rdiff-note">{t('review.noTextDiff')}</div>
  }

  return (
    <div className="rdiff" data-testid="review-diff" data-path={patch.path}>
      {patch.hunks.map((h, i) => (
        <div className="rdiff-block" key={`${h.header}-${i}`}>
          {gaps[i]?.count > 0 ? (
            <ContextGap
              range={gaps[i]}
              state={opened[i]}
              onOpen={async () => {
                const loaded = await loadGap(patch, gaps[i], load)
                setOpened((p) => ({ ...p, [i]: loaded }))
              }}
            />
          ) : null}

          <div className="rdiff-hunk">
            <div className="rdiff-hunk-head" title={h.header}>
              <span className="rdiff-hunk-range">{`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`}</span>
              {h.section ? <span className="rdiff-hunk-sec">{h.section}</span> : null}
            </div>
            <div className="rdiff-lines">
              {h.lines.map((l, j) => (
                <div className={`rdiff-line ${l.type}`} key={j}>
                  <span className="rdiff-no" aria-hidden="true">{l.oldLine ?? ''}</span>
                  <span className="rdiff-no" aria-hidden="true">{l.newLine ?? ''}</span>
                  <span className="rdiff-sign" aria-hidden="true">
                    {l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'none' ? '\\' : ' '}
                  </span>
                  <span className="rdiff-text">{l.text || '\u00a0'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
      {patch.truncated ? <div className="rdiff-note">{t('review.truncatedFile')}</div> : null}
      {patch.synthesized ? <div className="rdiff-note">{t('review.untrackedNote')}</div> : null}
    </div>
  )
}

type GapLines = { kind: 'lines'; lines: { oldNo: number; newNo: number; text: string }[]; rest: number } | { kind: 'error'; message: string }

/**
 * 按行号区间把原文切出来。
 *
 * ⚠️ 两个容易搞错的地方：
 *   ① `split('\n')` 对以换行结尾的文件会多出一个空元素 —— 它不影响
 *      区间切片（只要区间落在文件行数内），但会让「最后一行」看起来多一行，
 *      所以按文件实际行数夹取。
 *   ② 删除文件的**新侧不存在**，必须回退到旧侧。此时两侧行号仍然都要显示
 *      （旧侧的行号是真实的，新侧那列跟着推进 —— 它就是“如果不删会是第几行”）。
 */
async function loadGap(patch: GitFilePatch, range: { oldStart: number; newStart: number; count: number }, load: SideLoader): Promise<GapLines> {
  const shown = Math.min(range.count, MAX_GAP_LINES)
  const rest = range.count - shown
  const trySide = async (side: 'old' | 'new'): Promise<string | null> => {
    const res = await load(patch.path, side)
    if (!res.ok || res.missing || typeof res.text !== 'string' || res.truncated) return null
    return res.text
  }
  let text = await trySide('new')
  let start = range.newStart
  if (text === null) {
    text = await trySide('old')
    start = range.oldStart
  }
  if (text === null) return { kind: 'error', message: 'no-content' }

  const all = text.split('\n')
  /* 末尾因换行多出来的空元素不算一行 */
  const total = all.length && all[all.length - 1] === '' ? all.length - 1 : all.length
  const from = start - 1
  const to = Math.min(from + shown, total)
  const lines: { oldNo: number; newNo: number; text: string }[] = []
  for (let i = from; i < to; i++) {
    const offset = i - from
    lines.push({ oldNo: range.oldStart + offset, newNo: range.newStart + offset, text: all[i] ?? '' })
  }
  return { kind: 'lines', lines, rest }
}

function ContextGap({
  range,
  state,
  onOpen
}: {
  range: { oldStart: number; newStart: number; count: number }
  state: GapLines | undefined
  onOpen: () => Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  if (state?.kind === 'lines') {
    return (
      <div className="rdiff-gap-open" data-testid="review-gap-open">
        {state.lines.map((l, i) => (
          <div className="rdiff-line ctx" key={i}>
            <span className="rdiff-no" aria-hidden="true">{l.oldNo}</span>
            <span className="rdiff-no" aria-hidden="true">{l.newNo}</span>
            <span className="rdiff-sign" aria-hidden="true">{' '}</span>
            <span className="rdiff-text">{l.text || '\u00a0'}</span>
          </div>
        ))}
        {state.rest > 0 ? <div className="rdiff-note">{t('review.gapMore', { n: state.rest })}</div> : null}
      </div>
    )
  }

  return (
    <button
      type="button"
      className="rdiff-gap"
      data-testid="review-gap"
      disabled={busy}
      title={t('review.gapTip')}
      onClick={() => {
        setBusy(true)
        void onOpen().finally(() => setBusy(false))
      }}
    >
      <span className="rdiff-gap-rule" />
      <span className="rdiff-gap-label">
        {state?.kind === 'error' ? t('review.gapFailed') : t('review.unmodified', { n: range.count })}
      </span>
      <span className="rdiff-gap-rule" />
    </button>
  )
}

function kindNote(kind: GitFilePatch['kind'], t: ReturnType<typeof useT>): string {
  switch (kind) {
    case 'binary':
      return t('review.binary')
    case 'submodule':
      return t('review.submodule')
    case 'lfs':
      return t('review.lfs')
    case 'large':
      return t('review.tooLarge')
    default:
      return t('review.noTextDiff')
  }
}

/* ── 图片对照 ───────────────────────────────────────────── */

export interface SideInfo {
  label: string
  content: GitFileContent | 'loading' | null
}

export function ImageDiff({ old, now }: { old: SideInfo; now: SideInfo }) {
  const t = useT()
  const [fit, setFit] = useState(true)
  return (
    <div className="rimg" data-testid="review-image">
      <div className="rimg-tools">
        <button type="button" className={`rimg-fit ${fit ? 'on' : ''}`} onClick={() => setFit(true)}>
          {t('review.fit')}
        </button>
        <button type="button" className={`rimg-fit ${fit ? '' : 'on'}`} onClick={() => setFit(false)}>
          {t('review.actual')}
        </button>
      </div>
      <div className="rimg-panes">
        <ImageSide info={old} fit={fit} />
        <ImageSide info={now} fit={fit} />
      </div>
    </div>
  )
}

function ImageSide({ info, fit }: { info: SideInfo; fit: boolean }) {
  const t = useT()
  const content = info.content
  return (
    <figure className="rimg-pane">
      <figcaption className="rimg-cap">
        <span>{info.label}</span>
        {content && content !== 'loading' ? (
          <span className="rimg-meta">
            {content.missing ? t('review.sideMissing') : bytesText(content.bytes, t)}
          </span>
        ) : null}
      </figcaption>
      <div className={`rimg-body ${fit ? 'fit' : 'actual'}`}>
        {content === 'loading' || content === null ? (
          <span className="rimg-empty">{t('review.loading')}</span>
        ) : content.missing ? (
          <span className="rimg-empty">{t('review.sideMissing')}</span>
        ) : content.base64 ? (
          <img src={`data:${content.mimeType ?? 'image/png'};base64,${content.base64}`} alt={info.label} />
        ) : content.kind === 'large' ? (
          <span className="rimg-empty">{t('review.tooLarge')}</span>
        ) : (
          <span className="rimg-empty">{content.error ?? t('review.sideMissing')}</span>
        )}
      </div>
    </figure>
  )
}

function bytesText(bytes: number, t: ReturnType<typeof useT>): string {
  if (bytes < 1024) return t('review.bytesB', { n: bytes })
  if (bytes < 1024 * 1024) return t('review.bytesKb', { n: Math.round(bytes / 1024) })
  return t('review.bytesMb', { n: (bytes / 1024 / 1024).toFixed(1) })
}
