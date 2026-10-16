/**
 * 会话级提问频率控件该改哪条会话 —— 纯选择器。
 *
 * 为什么不能直接用 `activeRunnerId + session.sessionId`：分屏 / deferred 只读
 * 预览时，界面正在显示的是**另一条会话**（peek 优先），而 `activeRunnerId`
 * 仍指向上一条实例。直接把这对字段交给 IPC，用户看的是一条会话、改的却是
 * 另一条（甚至替它新建 worktree）。
 *
 * 规则：先按 `displayedSessionOf` 的同一口径定出屏幕正在看的会话（peek 优先），
 * 再在 `runners` 里按**稳定 sessionId / 路径**找它的运行实例：
 *   · 找到（含后台已运行、active 却不是它）→ 定向改那个 runner，不激活、不建树；
 *   · 完全找不到 → 禁用并说明原因（正在按路径打开 / 没有实例）。
 *
 * 与 `split-view.displayedSessionOf` 共用「peek 优先」语义；这里不再 import
 * 那个模块，避免选择器把 zustand 运行实例一并拖进单测。
 */

export interface QuestionFrequencyRunnerView {
  /** 注册表内的运行实例 id（与 `runId` 同值） */
  id: string
  runId?: string
  sessionId?: string
  sessionFile?: string
}

export interface QuestionFrequencyTargetInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string } | null
  /** 正在按路径打开、身份还没落定的会话（deferred 预览）。 */
  pendingActivation: { sessionId?: string; sessionFile?: string } | null
  activeRunnerId: string | null
  runners: readonly QuestionFrequencyRunnerView[]
}

export type QuestionFrequencyTargetReason = 'ok' | 'no-session' | 'pending-activation' | 'no-runner'

export interface QuestionFrequencyTarget {
  enabled: boolean
  reason: QuestionFrequencyTargetReason
  /** 要寻址的运行实例 id；禁用时不存在 */
  runnerId?: string
  sessionId?: string
  sessionFile?: string
}

/** 路径比较：统一分隔符、去掉尾斜杠、大小写折叠（Windows 优先的既有口径）。 */
const normalizePath = (value?: string): string => (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

interface DisplayedSession {
  sessionId?: string
  sessionFile?: string
}

/** 屏幕正在显示哪条会话：切换途中铺上的 peek 优先于运行实例当前的会话。 */
function displayedSession(input: QuestionFrequencyTargetInput): DisplayedSession | null {
  if (input.peekedSessionId || input.peekedPath) {
    return { sessionId: input.peekedSessionId ?? undefined, sessionFile: input.peekedPath ?? undefined }
  }
  if (input.session?.sessionId || input.session?.sessionFile) {
    return {
      sessionId: input.session.sessionId || undefined,
      sessionFile: input.session.sessionFile || undefined
    }
  }
  return null
}

/**
 * 实例是否就是屏幕上这条会话：sessionId 或路径命中就算。
 *
 * ⚠️ 不能只比 sessionId：pi 对同一份会话文件切走再切回时可能给出新 id
 *（见 work-mode-service 的键说明），只比 id 会把「同一条会话」判成没有实例。
 * 路径命中即算，id 命中优先由调用方的 active 选择体现。
 */
function runnerMatchesSession(runner: QuestionFrequencyRunnerView, displayed: DisplayedSession): boolean {
  if (displayed.sessionId && runner.sessionId && displayed.sessionId === runner.sessionId) return true
  if (displayed.sessionFile && runner.sessionFile) {
    return normalizePath(displayed.sessionFile) === normalizePath(runner.sessionFile)
  }
  return false
}

export function sessionQuestionFrequencyTarget(input: QuestionFrequencyTargetInput): QuestionFrequencyTarget {
  const displayed = displayedSession(input)
  if (!displayed?.sessionId && !displayed?.sessionFile) return { enabled: false, reason: 'no-session' }

  const matches = input.runners.filter((runner) => runnerMatchesSession(runner, displayed))

  /*
   * 找到实例（active 或后台）才允许改。后台会话被查看时能准确对上它的
   * runner，就定向改它 —— 不为了改偏好把它切到 active，也不建隔离树。
   */
  if (!matches.length) {
    return { enabled: false, reason: input.pendingActivation ? 'pending-activation' : 'no-runner' }
  }

  const active = matches.find((runner) => (runner.runId ?? runner.id) === input.activeRunnerId)
  const chosen = active ?? matches[0]
  return {
    enabled: true,
    reason: 'ok',
    runnerId: chosen.id,
    sessionId: displayed.sessionId,
    sessionFile: displayed.sessionFile
  }
}
