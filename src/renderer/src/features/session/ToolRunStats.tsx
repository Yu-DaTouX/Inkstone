import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { ToolRunSummary } from './tool-run-model'

export function ToolRunStats({ summary }: { summary: Pick<ToolRunSummary, 'added' | 'removed' | 'changedFiles' | 'failed'> }): JSX.Element | null {
  const t = useT()
  const changes = summary.added !== null && summary.removed !== null
    ? <span className="v3-steps-stats"><span className="v3-add">+{summary.added}</span><span className="v3-del">−{summary.removed}</span></span>
    : summary.changedFiles > 0
      ? <span className="v3-steps-stats" data-kind="files">{t('tool.wsChanges', { n: summary.changedFiles })}</span>
      : null
  const failed = summary.failed > 0
    ? <span className="v3-steps-stats err" data-kind="failed" data-testid="v3-steps-failed">{t('tool.wsFailed', { n: summary.failed })}</span>
    : null
  if (!changes && !failed) return null
  return <>{changes}{failed}</>
}
