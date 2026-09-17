/**
 * 单个文件的差异呈现：文本（结构化 hunk）与图片（前后对照）。
 *
 * 为什么不用「把 patch 塞进 `<pre>`」那种做法（现有工具卡就是那样）：
 * 审查面板要能**逐文件折叠、定位到某一行、记住已查看进度**，
 * 这些都需要行号与行类型是数据而不是字符串。结构化之后还能顺便做
 * 「未修改的 N 行」折叠块 —— 长文件里真正要看的就是那几行改动。
 *
 * 不做语法高亮：diff 的可读性主要来自增删底色与行号对齐，
 * 而给上万个 diff 行跑 highlight.js 会让滚动明显变卡（实测过的取舍）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { GitDiffHunk, GitFileContent, GitFilePatch } from '../../../../shared/ipc'
import { useT } from '../../i18n'

/** 相邻两个 hunk 之间未修改的行数（首块之前也算一段） */
export function unmodifiedGaps(hunks: GitDiffHunk[]): number[] {
  const gaps: number[] = []
  for (let i = 0; i < hunks.length; i++) {
    if (i === 0) {
      gaps.push(Math.max(0, hunks[0].oldStart - 1))
      continue
    }
    const prev = hunks[i - 1]
    const cur = hunks[i]
    gaps.push(Math.max(0, cur.oldStart - (prev.oldStart + prev.oldCount)))
  }
  return gaps
}

export function DiffViewer({ patch }: { patch: GitFilePatch }) {
  const t = useT()
  const gaps = useMemo(() => unmodifiedGaps(patch.hunks), [patch.hunks])
  /** 被用户展开的「未修改的 N 行」块（它不加载真实内容，只是不再折叠） */
  const [openedGaps, setOpenedGaps] = useState<Set<number>>(new Set())

  useEffect(() => {
    setOpenedGaps(new Set())
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
          {gaps[i] > 0 ? (
            openedGaps.has(i) ? (
              <div className="rdiff-gap open">
                <span className="rdiff-gap-rule" />
                <span className="rdiff-gap-label">{t('review.unmodified', { n: gaps[i] })}</span>
                <span className="rdiff-gap-rule" />
              </div>
            ) : (
              <button
                type="button"
                className="rdiff-gap"
                data-testid="review-gap"
                onClick={() => setOpenedGaps((p) => new Set(p).add(i))}
                title={t('review.gapTip')}
              >
                <span className="rdiff-gap-rule" />
                <span className="rdiff-gap-label">{t('review.unmodified', { n: gaps[i] })}</span>
                <span className="rdiff-gap-rule" />
              </button>
            )
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
