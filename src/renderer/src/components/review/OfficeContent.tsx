/** 从实际办公文件提取文字，供文件预览使用；不还原版式与图片。 */
import { useEffect, useState } from 'react'
import type { OfficeDocumentView } from '../../../../shared/office'
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
