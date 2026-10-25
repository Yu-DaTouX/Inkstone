import { useState, type ReactElement } from 'react'
import { GitMerge } from 'lucide-react'
import { Button, Notice } from '../../ui'
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
    <Notice
      className="isolation-merge"
      tone={error ? 'fail' : blocked ? 'stall' : 'info'}
      icon={<GitMerge size={18} />}
      title={t(blocked ? 'isolation.merge.blockedTitle' : 'isolation.merge.title')}
      data-testid="isolation-merge-bar"
      action={
        <Button
          variant="primary"
          size="sm"
          data-testid="isolation-merge"
          isDisabled={busy || runner.running}
          onPress={() => void merge()}
        >
          {t(busy ? 'isolation.merge.merging' : blocked ? 'isolation.merge.retry' : 'isolation.merge.action')}
        </Button>
      }
    >
      <div>{t('isolation.merge.branch', { branch: runner.isolationBranch ?? '' })}</div>
      <div>{error ?? t(blocked ? 'isolation.merge.blockedHint' : 'isolation.merge.hint')}</div>
    </Notice>
  )
}
