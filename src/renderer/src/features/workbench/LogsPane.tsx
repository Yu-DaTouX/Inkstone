import { useMemo, useState, type ReactElement } from 'react'
import { Copy } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { EmptyState, IconButton } from '../../ui'
import { workbenchPaneText } from './pane-text'
import type { LogsPaneProps } from './types'

const TAIL = 200

export function LogsPane(_props: LogsPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = workbenchPaneText(lang)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)

  const statusEntries = Object.entries(statuses)
  const needle = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    const tail = logs.slice(-TAIL)
    return needle ? tail.filter((line) => line.toLowerCase().includes(needle)) : tail
  }, [logs, needle])

  if (logs.length === 0 && statusEntries.length === 0) {
    return (
      <EmptyState className="wb-note-block" data-testid="v3-wb-logs-empty" title={t('tile.logsEmpty')} description={t('tile.logsEmptyBody')} />
    )
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(visible.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (cause) {
      useStore.getState().notify('error', cause instanceof Error ? cause.message : text.copyFailed)
    }
  }

  return (
    <div className="wb-logs" data-testid="v3-wb-logs">
      {statusEntries.length > 0 ? (
        <section className="wb-logs-section" aria-label={t('rp.ext')}>
          <h4 className="wb-ctx-subtitle">{t('rp.ext')}</h4>
          <ul className="wb-ctx-rows" data-testid="v3-wb-logs-status">
            {statusEntries.map(([key, value]) => (
              <li key={key}>
                <span>{key}</span>
                <span className="ui-meta-num">{value}</span>
              </li>
            ))}
          </ul>
          <p className="wb-ctx-note">{t('rp.extHint')}</p>
        </section>
      ) : null}

      {logs.length > 0 ? (
        <section className="wb-logs-section wb-logs-main" aria-label={t('rp.log')}>
          <div className="wb-logs-bar">
            <h4 className="wb-ctx-subtitle">{t('rp.log')}</h4>
            <span className="wb-logs-count ui-meta-num" data-testid="v3-wb-logs-count">
              {needle ? `${visible.length}/${Math.min(logs.length, TAIL)}` : logs.length}
            </span>
            <input
              className="ui-input wb-logs-filter"
              type="search"
              value={filter}
              placeholder={text.logFilter}
              aria-label={text.logFilter}
              onChange={(event) => setFilter(event.target.value)}
              data-testid="v3-wb-logs-filter"
            />
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={copied ? text.copied : text.copyLogs}
              onPress={() => void copy()}
              isDisabled={visible.length === 0}
              data-testid="v3-wb-logs-copy"
            >
              <Copy size={14} />
            </IconButton>
          </div>
          {visible.length > 0 ? (
            <pre className="wb-logs-body" data-testid="v3-wb-logs-body">
              {visible.join('\n')}
            </pre>
          ) : (
            <p className="wb-ctx-note">{text.logNoMatch}</p>
          )}
          <p className="wb-ctx-note">{t('rp.logHint')}</p>
        </section>
      ) : null}
    </div>
  )
}
