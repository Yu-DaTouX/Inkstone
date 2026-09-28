/**
 * 办公文件（docx / xlsx / pptx / pdf）的文字预览与内容对比。
 *
 * 两处复用：文件预览栏显示当前文件的分节正文；审查面板对这类二进制文件
 * 提供「内容对比」（最近一次提交 vs 当前文件）。数据都由宿主从**真实文件**提取，
 * 只显示文字，不还原版式与图片 —— 界面上照实说明。
 */
import { useEffect, useState } from 'react'
import type { OfficeCompareResult, OfficeDocumentView } from '../../../../shared/office'
import { useT } from '../../i18n'

type Loaded<T> = { status: 'loading' } | { status: 'done'; value: T } | { status: 'error'; error: string }

function useOfficeRequest<T>(run: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    run()
      .then((value) => alive && setState({ status: 'done', value }))
      .catch((e: unknown) => alive && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/** 文件预览栏：按节列出提取出的正文 */
export function OfficePreview({ path, cwd, version }: { path: string; cwd?: string; version?: number }) {
  const t = useT()
  const state = useOfficeRequest<OfficeDocumentView>(() => window.yan.office.preview(path, cwd), [path, cwd, version])
  if (state.status === 'loading') return <div className="fp-note">{t('office.loading')}</div>
  const view = state.status === 'done' ? state.value : ({ ok: false, error: state.error } as const)
  if (!view.ok) {
    return (
      <div className="fp-note err" role="alert">
        {t('office.failed', { msg: view.error })}
      </div>
    )
  }
  return (
    <div className="office-doc" data-testid="office-preview" data-format={view.format}>
      <div className="fp-note office-note">{t('office.textOnly')}{view.note ? ` · ${view.note}` : ''}</div>
      {view.sections.length === 0 ? <div className="fp-note">{t('office.empty')}</div> : null}
      {view.sections.map((section, i) => (
        <section className="office-section" key={`${section.title}-${i}`}>
          <h4 className="office-section-title">{section.title}</h4>
          {section.lines.map((line, j) => (
            <p className="office-line" key={j}>
              {line || ' '}
            </p>
          ))}
        </section>
      ))}
      {view.truncated ? <div className="fp-note">{t('office.truncated')}</div> : null}
    </div>
  )
}

/** 审查面板：提取文字的逐行对比 */
export function OfficeCompare({ path, cwd }: { path: string; cwd?: string }) {
  const t = useT()
  const state = useOfficeRequest<OfficeCompareResult>(() => window.yan.office.compare(path, cwd), [path, cwd])
  if (state.status === 'loading') return <div className="rdiff-note">{t('office.loading')}</div>
  const result = state.status === 'done' ? state.value : ({ ok: false, error: state.error } as const)
  if (!result.ok) return <div className="rdiff-note err">{t('office.failed', { msg: result.error })}</div>
  return (
    <div className="rdiff office-diff" data-testid="office-compare" data-format={result.format}>
      <div className="rdiff-note">
        {result.baseLabel} · {t('office.textOnly')}
        <span className="office-diff-stat">
          <span className="add">+{result.added}</span> <span className="del">-{result.removed}</span>
        </span>
      </div>
      {result.rows.length === 0 ? <div className="rdiff-note">{t('office.noTextChange')}</div> : null}
      <div className="rdiff-lines">
        {result.rows.map((row, i) =>
          row.type === 'section' ? (
            <div className="rdiff-hunk-head office-diff-section" key={i}>
              {row.text}
            </div>
          ) : (
            <div className={`rdiff-line ${row.type === 'same' ? 'ctx' : row.type}`} key={i}>
              <span className="rdiff-sign" aria-hidden="true">
                {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              </span>
              <span className="rdiff-text">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
