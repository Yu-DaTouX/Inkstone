import { useStore } from '../../state/store'
import type { TFunc } from '../../i18n'
import type { SessionExportFormat } from '../../../../shared/session-transfer'
import { sessionHtmlDocument } from './session-export-html'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function exportSessionFromMenu(path: string, format: SessionExportFormat, title: string, lang: string, t: TFunc): Promise<void> {
  const store = useStore.getState()
  try {
    let html: string | undefined
    if (format === 'html') {
      const source = await window.yan.sessionTransfer.sessionMarkdown(path, title)
      if (!source.ok || source.markdown === undefined) {
        store.notify('error', source.error || t('rail.transferFailed'))
        return
      }
      html = await sessionHtmlDocument(source.markdown, title, lang)
    }
    const result = await window.yan.sessionTransfer.exportSession(path, { format, title, reveal: true, ...(html === undefined ? {} : { html }) })
    if (result.ok && result.path) store.notify('info', t('rail.exportDone', { path: result.path }))
    else if (!result.cancelled) store.notify('error', result.error || t('rail.transferFailed'))
  } catch (error) {
    store.notify('error', describe(error))
  }
}
