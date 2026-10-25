import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { ToolRunSummary } from './tool-run-model'

export function ToolRunStats({ summary }: { summary: Pick<ToolRunSummary, 'added' | 'removed' | 'changedFiles'> }): JSX.Element | null {
  const t = useT()
  if (summary.added !== null && summary.removed !== null) {
    return <span className="v3-steps-stats"><span className="v3-add">+{summary.added}</span><span className="v3-del">−{summary.removed}</span></span>
  }
  if (summary.changedFiles > 0) return <span className="v3-steps-stats" data-kind="files">{t('tool.wsChanges', { n: summary.changedFiles })}</span>
  return null
}
