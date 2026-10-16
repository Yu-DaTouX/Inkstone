import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import { Segmented } from './ui'
import {
  SESSION_QUESTION_FREQUENCIES,
  normalizeSessionQuestionFrequency,
  type SessionQuestionFrequency
} from '../../../shared/question-frequency'
import {
  sessionQuestionFrequencyTarget,
  type QuestionFrequencyTarget
} from '../state/question-frequency-target'

const OPTION_LABELS: Record<SessionQuestionFrequency, MessageKey> = {
  inherit: 'picker.questionFrequencyInherit',
  sparse: 'set.questionFrequencySparse',
  balanced: 'set.questionFrequencyBalanced',
  eager: 'set.questionFrequencyEager'
}

interface AuthoritativeView {
  key: string
  revision: number
  preference: SessionQuestionFrequency
  sessionId?: string
  sessionFile?: string
}

const targetKeyOf = (target: QuestionFrequencyTarget): string =>
  target.enabled
    ? `${target.runnerId ?? ''}\u0000${target.sessionId ?? ''}\u0000${target.sessionFile ?? ''}`
    : ''

const normalizePath = (value?: string): string =>
  (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

function responseMatchesTarget(
  res: { runnerId: string; sessionId?: string; sessionFile?: string },
  runnerId: string,
  target: QuestionFrequencyTarget
): boolean {
  if (res.runnerId !== runnerId) return false
  const idMatch = !!target.sessionId && target.sessionId === res.sessionId
  const pathMatch = !!target.sessionFile && normalizePath(target.sessionFile) === normalizePath(res.sessionFile)
  if (!target.sessionId && !target.sessionFile) return true
  return idMatch || pathMatch
}

export function SessionQuestionFrequencyPicker() {
  const t = useT()
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore((s) => s.session)
  const pendingActivation = useStore((s) => s.pendingActivation)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runners = useStore((s) => s.runners)
  const workMode = useStore((s) => s.workMode)

  const target = useMemo(
    () =>
      sessionQuestionFrequencyTarget({
        peekedSessionId,
        peekedPath,
        session,
        pendingActivation,
        activeRunnerId,
        runners
      }),
    [peekedSessionId, peekedPath, session, pendingActivation, activeRunnerId, runners]
  )
  const targetKey = targetKeyOf(target)
  const targetRef = useRef(target)
  targetRef.current = target
  const targetKeyRef = useRef(targetKey)
  targetKeyRef.current = targetKey

  const ownsPush = target.enabled && target.runnerId === activeRunnerId
  const pushRevision =
    ownsPush && typeof workMode?.revision === 'number' && Number.isFinite(workMode.revision)
      ? workMode.revision
      : undefined
  const pushPreference = ownsPush && workMode ? normalizeSessionQuestionFrequency(workMode.questionFrequency) : undefined

  const [fetched, setFetched] = useState<AuthoritativeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchSeq = useRef(0)

  useEffect(() => {
    if (!target.enabled || !target.runnerId || pushRevision !== undefined) return
    const runnerId = target.runnerId
    const key = targetKey
    const seq = ++fetchSeq.current
    let cancelled = false
    void (async () => {
      try {
        const res = await window.yan.getSessionQuestionFrequency(runnerId)
        if (cancelled || seq !== fetchSeq.current || targetKeyRef.current !== key) return
        if (!res.ok) {
          setFetched(null)
          return
        }
        if (!responseMatchesTarget(res, runnerId, targetRef.current)) return
        setFetched({ key, revision: res.revision, preference: res.preference, sessionId: res.sessionId, sessionFile: res.sessionFile })
      } catch {
        if (!cancelled && seq === fetchSeq.current && targetKeyRef.current === key) setFetched(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target.enabled, target.runnerId, targetKey, pushRevision])

  const preference =
    pushPreference ??
    (fetched && fetched.key === targetKey ? fetched.preference : undefined) ??
    normalizeSessionQuestionFrequency(workMode?.questionFrequency)
  const revision = pushRevision ?? (fetched && fetched.key === targetKey ? fetched.revision : undefined)

  const submitSeq = useRef(0)
  const change = useCallback(
    async (value: SessionQuestionFrequency) => {
      const current = targetRef.current
      const keyAtStart = targetKeyRef.current
      const revisionAtStart = revision
      if (!current.enabled || !current.runnerId || revisionAtStart === undefined || busy) return
      const seq = ++submitSeq.current
      setBusy(true)
      setError(null)
      const authoritative = fetched && fetched.key === keyAtStart ? fetched : null
      try {
        const res = await window.yan.setSessionQuestionFrequency({
          runnerId: current.runnerId,
          sessionId: authoritative?.sessionId ?? current.sessionId,
          sessionFile: authoritative?.sessionFile ?? current.sessionFile,
          expectedRevision: revisionAtStart,
          questionFrequency: value
        })
        if (seq !== submitSeq.current || targetKeyRef.current !== keyAtStart) return
        if (res.ok) {
          setFetched({ key: keyAtStart, revision: res.revision, preference: res.preference, sessionId: res.sessionId, sessionFile: res.sessionFile })
        } else if (res.error === 'version-mismatch' && typeof res.revision === 'number' && res.preference) {
          setFetched({
            key: keyAtStart,
            revision: res.revision,
            preference: res.preference,
            sessionId: authoritative?.sessionId ?? current.sessionId,
            sessionFile: authoritative?.sessionFile ?? current.sessionFile
          })
        } else if (res.error === 'stale_session' || res.error === 'identity-changed') {
          setFetched(null)
        } else {
          setError(t('picker.questionFrequencyFailed'))
        }
      } catch {
        if (seq === submitSeq.current && targetKeyRef.current === keyAtStart) {
          setError(t('picker.questionFrequencyFailed'))
        }
      } finally {
        if (seq === submitSeq.current) setBusy(false)
      }
    },
    [revision, busy, fetched, t]
  )

  const disabled = !target.enabled || revision === undefined || busy
  const options = SESSION_QUESTION_FREQUENCIES.map((value) => ({
    value,
    label: t(OPTION_LABELS[value]),
    testId: `session-question-frequency-${value}`,
    disabled
  }))

  return (
    <div
      className="mt-line"
      data-testid="session-question-frequency"
      title={disabled ? t('picker.questionFrequencyDisabled') : t('picker.questionFrequencyDesc')}
    >
      <span className="mt-head-title">{t('picker.questionFrequency')}</span>
      <Segmented
        size="sm"
        label={t('picker.questionFrequency')}
        testId="session-question-frequency-stops"
        value={preference}
        onChange={(value) => void change(value)}
        options={options}
      />
      {error ? (
        <span role="alert" className="ui-row-desc">
          {error}
        </span>
      ) : null}
    </div>
  )
}
