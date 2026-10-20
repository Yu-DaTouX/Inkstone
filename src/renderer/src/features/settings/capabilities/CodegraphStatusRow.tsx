import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { CodegraphStatus } from '../../../../../shared/plugin-market'
import { Button } from '../../../ui'
import { Actions, Meta, StatusBadge, Warn } from './parts'

export function CodegraphStatusRow({ refreshKey }: { refreshKey: string }): ReactElement | null {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [status, setStatus] = useState<CodegraphStatus | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.yan.packages.codegraphStatus(cwd)
      if (alive.current) setStatus(next)
    } catch {
      if (alive.current) setStatus(null)
    }
  }, [cwd])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const index = async (): Promise<void> => {
    setIndexing(true)
    setResult(null)
    try {
      const r = await window.yan.packages.codegraphIndex(cwd)
      if (!alive.current) return
      setResult(r.ok ? { ok: true, text: t('market.cgIndexDone') } : { ok: false, text: t('market.cgIndexFailed', { error: [r.error, r.log].filter(Boolean).join('\n') }) })
    } catch (cause) {
      if (alive.current) setResult({ ok: false, text: t('market.cgIndexFailed', { error: cause instanceof Error ? cause.message : String(cause) }) })
    } finally {
      if (alive.current) setIndexing(false)
    }
    if (alive.current) await refresh()
  }

  if (!status) return null
  return (
    <div data-testid="caps-market-codegraph-status">
      <Actions>
        <StatusBadge tone={status.configured ? 'accent' : 'neutral'}>
          {status.configured ? t('market.cgConfigured') : t('market.cgNotConfigured')}
        </StatusBadge>
        {!status.cliInstalled ? <StatusBadge tone="stall">{t('market.cgCliMissing')}</StatusBadge> : null}
      </Actions>
      {status.cwd ? (
        <Meta title={status.cwd}>
          {status.indexed ? t('market.cgProjectIndexed', { cwd: status.cwd }) : t('market.cgProjectMissing', { cwd: status.cwd })}
        </Meta>
      ) : (
        <Meta>{t('market.cgNoProject')}</Meta>
      )}
      {status.cwd && !status.indexed && status.cliInstalled ? (
        <Actions>
          <Button
            variant="secondary"
            isDisabled={indexing}
            isPending={indexing}
            onPress={() => void index()}
            data-testid="caps-market-codegraph-index"
          >
            {t('market.cgIndex')}
          </Button>
        </Actions>
      ) : null}
      {result ? (result.ok ? <Meta>{result.text}</Meta> : <Warn>{result.text}</Warn>) : null}
    </div>
  )
}
