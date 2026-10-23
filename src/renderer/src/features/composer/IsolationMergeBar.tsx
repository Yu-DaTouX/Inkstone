import { useState, type ReactElement } from 'react'
import { GitMerge } from 'lucide-react'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import './composer.css'

export function IsolationMergeBar(): ReactElement | null {
  const t = useT()
  const runner = useStore((s) => s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId) ?? null)
  const syncRunners = useStore((s) => s.syncRunners)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!runner || (runner.isolation !== 'ready' && runner.isolation !== 'blocked')) return null

  const merge = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.yan.mergeIsolation(runner.cwd)
      if (!res.ok) setError(res.error ?? t('isolation.merge.failed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      void syncRunners()
    }
  }

  const blocked = runner.isolation === 'blocked'
  return (
    <div className="quota-wait" role="status" data-testid="isolation-merge-bar">
      <GitMerge className="quota-wait-icon" size={18} aria-hidden />
      <div className="quota-wait-body">
        <span className="quota-wait-title">{t(blocked ? 'isolation.merge.blockedTitle' : 'isolation.merge.title')}</span>
        <span className="quota-wait-eta">{t('isolation.merge.branch', { branch: runner.isolationBranch ?? '' })}</span>
        <span className="quota-wait-hint">{error ?? t(blocked ? 'isolation.merge.blockedHint' : 'isolation.merge.hint')}</span>
      </div>
      <Button
        variant="primary"
        size="sm"
        className="quota-wait-cancel"
        data-testid="isolation-merge"
        isDisabled={busy || runner.running}
        onPress={() => void merge()}
      >
        {t(busy ? 'isolation.merge.merging' : blocked ? 'isolation.merge.retry' : 'isolation.merge.action')}
      </Button>
    </div>
  )
}
