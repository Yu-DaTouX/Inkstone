import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubagentRun } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { Button, Notice } from '../../ui'
import { DiffView } from '../diff'
import { loadSubagentPatch, subagentReviewGate, type SubagentPatch } from './subagent-review'
import './subagent-review.css'

interface SubagentReviewProps {
  run: SubagentRun
  loadPatch?: (patchPath: string) => Promise<SubagentPatch>
}

const defaultLoadPatch = (patchPath: string): Promise<SubagentPatch> => loadSubagentPatch(patchPath)

export function SubagentReview({ run, loadPatch }: SubagentReviewProps): JSX.Element | null {
  const t = useT()
  const { lang } = useI18n()
  const gate = useMemo(() => subagentReviewGate(run), [run])
  const [showDiff, setShowDiff] = useState(false)
  const [patch, setPatch] = useState<SubagentPatch | null>(null)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState('')

  useEffect(() => {
    setShowDiff(false)
    setPatch(null)
    setPatchError('')
  }, [run.id])

  const loaderRef = useRef(loadPatch ?? defaultLoadPatch)
  loaderRef.current = loadPatch ?? defaultLoadPatch
  const patchPath = run.diff?.patchPath

  useEffect(() => {
    if (!showDiff || !patchPath) return undefined
    let alive = true
    setPatchLoading(true)
    setPatchError('')
    setPatch(null)
    void loaderRef.current(patchPath)
      .then((value) => { if (alive) setPatch(value) })
      .catch((error: unknown) => { if (alive) setPatchError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (alive) setPatchLoading(false) })
    return () => { alive = false }
  }, [showDiff, patchPath])

  if (!gate.canReview) return null

  return (
    <section className="v3-subagent-review" data-testid="v3-subagent-review" data-review={run.review}>
      <div className="v3-subagent-review-actions">
        <span className="v3-subagent-review-state" data-testid="v3-subagent-review-state">
          {run.review === 'conflict' ? t('sa.reviewConflict') : t('sa.reviewPending')}
        </span>
        {gate.canPatch ? (
          <Button size="sm" variant="ghost" onPress={() => setShowDiff((value) => !value)} data-testid="v3-subagent-review-view">
            {showDiff ? t('sa.hidePatch') : t('sa.viewPatch')}
          </Button>
        ) : null}
      </div>

      {showDiff ? (
        <div className="v3-subagent-review-diff" data-testid="v3-subagent-review-diff">
          {patchLoading ? (
            <p className="v3-subagent-review-note">{t('sa.patchLoading')}</p>
          ) : patchError ? (
            <Notice tone="fail" compact data-testid="v3-subagent-review-diff-error">
              {t('sa.patchLoadFailed', { error: patchError })}
            </Notice>
          ) : patch ? (
            <>
              {patch.truncated ? <p className="v3-subagent-review-note">{t('sa.patchTruncated')}</p> : null}
              <DiffView patch={patch.patch} lang={lang} showFileHeader />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
