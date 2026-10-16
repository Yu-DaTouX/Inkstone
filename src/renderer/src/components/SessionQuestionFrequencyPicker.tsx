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

/**
 * 四态的界面文案。
 *
 * 三档显式值复用设置页已有的翻译键（少问 / 适中 / 多问），只有 `inherit`
 * 是会话特有的一项 —— 不再造一套同义词。
 */
const OPTION_LABELS: Record<SessionQuestionFrequency, MessageKey> = {
  inherit: 'picker.questionFrequencyInherit',
  sparse: 'set.questionFrequencySparse',
  balanced: 'set.questionFrequencyBalanced',
  eager: 'set.questionFrequencyEager'
}

/** 权威值（revision 用于 CAS；preference 用于显示；身份用于提交）。 */
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

/**
 * 响应必须是这条会话：sessionId 或路径命中一个即可。
 *
 * pi 对同一份文件切回后可能给出新 sessionId（见 work-mode-service 的键说明），
 * 只比 sessionId 会把同一条会话判成不属于当前目标。
 */
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

/**
 * 会话级提问频率（四态：继承全局 / 少问 / 适中 / 多问）。
 *
 * 复用模型菜单里的统一分段控件，不新开工作台。目标身份由
 * `sessionQuestionFrequencyTarget` 从**屏幕正在看的会话**推出：deferred 预览
 * 时不会误改当前 active 实例；后台已运行会话能对上 runner 时定向改它，不激活、
 * 不建 worktree。
 *
 * 值以宿主为准：active 会话用宿主 `work-mode` 推送的 `revision` / 频率；
 * 后台 / 尚未收到推送时用 `getSessionQuestionFrequency` 拿权威 revision。
 * 任何来源都必须带正确身份 —— 不用 0 猜。提交带预期身份与 revision；返回后
 * 用请求序号 + 目标身份核对，A 的迟到结果 / busy 不会串到 B。
 */
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
  /* 供 await 回调读取「此刻」的目标，不闭包旧值 */
  const targetRef = useRef(target)
  targetRef.current = target
  const targetKeyRef = useRef(targetKey)
  targetKeyRef.current = targetKey

  /* active 会话的推送就是它自己的权威投影；后台 / 未推送时改用 IPC 查询 */
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
  /* revision 只能来自「正确归属的推送」或权威查询，绝不用 0 猜 */
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
      /* 提交用权威查询返回的身份（若有），而不是屏幕会话可能过期的 sessionId */
      const authoritative = fetched && fetched.key === keyAtStart ? fetched : null
      try {
        const res = await window.yan.setSessionQuestionFrequency({
          runnerId: current.runnerId,
          sessionId: authoritative?.sessionId ?? current.sessionId,
          sessionFile: authoritative?.sessionFile ?? current.sessionFile,
          expectedRevision: revisionAtStart,
          questionFrequency: value
        })
        /* 序号 + 身份双保险：期间切了目标就丢弃这条响应 */
        if (seq !== submitSeq.current || targetKeyRef.current !== keyAtStart) return
        if (res.ok) {
          setFetched({ key: keyAtStart, revision: res.revision, preference: res.preference, sessionId: res.sessionId, sessionFile: res.sessionFile })
        } else if (res.error === 'version-mismatch' && typeof res.revision === 'number' && res.preference) {
          /* 乐观锁过期：采纳宿主回传的当前值；身份沿用本次提交用的那条 */
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
        /* busy 是组件级的：A 的迟到响应可以解除，但绝不写入 B 的值 */
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
