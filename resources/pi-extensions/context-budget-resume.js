/**
 * 整理后的自动续跑与重启恢复。
 *
 * 自动整理提交后，原请求停在预算边界上；这里在空闲窗口过后发一条续跑消息，
 * 让模型接着处理最后一个待办的用户请求。每条续跑都有回执（operation.resumeReceipt）：
 *   intent:<id>     已领取、正在发送
 *   sent:<id>       确认已落地
 *   failed:<id>     确认没发出去（窗口内可安全重领）
 *   uncertain:<id>  发送抛错且无法核实 —— 不自动重发，交给用户处理（防止重复执行）
 *   skipped:<why>   不再续跑：用户已接手、会话重新打开、超出窗口或连续续跑到上限
 *
 * 续跑只属于「刚提交的那次整理」：超过 RESUME_WINDOW_MS 就不再发，会话重新打开时
 * 也不补发 —— 否则用户什么都没做，打开应用就会按整段上下文付一次全价。
 * 回执只描述续跑，**不改操作状态**：整理结果（投影）在续跑被跳过后仍然有效。
 */
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readContextBudgetPolicyV1 } from './context-budget-policy.js'
import {
  capabilityRevision,
  contextBudgetFiles,
  dataDir,
  IN_FLIGHT_STATES,
  LIVE_STATES,
  operationPath,
  runnerIdentity,
  safeJson,
  sessionIdOf,
  withDiskLock,
  writeJsonAtomic
} from './context-budget-store.js'

const AUTO_RESUME_DELAY_MS = 1_800
/** 整理提交后多久内还允许自动续跑 */
const RESUME_WINDOW_MS = 120_000
/** 没有用户输入时最多连续自动续跑几次（续跑后仍撞线会再整理、再续跑） */
const MAX_CONSECUTIVE_AUTO_RESUMES = 3
const MAX_OPERATION_FILES = 2_000

let resumeActivity = 0
let autoResumeStreak = 0
let resumeScheduleToken = 0
let resumeSender = null

/** 有新的用户任务或工具调用时调用：空闲窗口里排队的续跑作废 */
export function noteAgentActivity() {
  resumeActivity += 1
}

/** 用户自己开口：连续自动续跑的计数归零 */
export function noteUserPrompt() {
  autoResumeStreak = 0
}

export function rememberResumeSender(pi, ctx) {
  if (typeof ctx?.sendMessage === 'function') resumeSender = ctx
  else if (!resumeSender && typeof pi?.sendMessage === 'function') resumeSender = pi
}

function operationFiles(sessionId) {
  const dir = contextBudgetFiles(sessionId).operations
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).slice(0, MAX_OPERATION_FILES).map((name) => join(dir, name))
  } catch {
    return []
  }
}

function retryableReceipt(receipt) {
  return receipt === null || receipt === undefined || String(receipt).startsWith('failed:')
}

function withinResumeWindow(operation, now = Date.now()) {
  const at = Number(operation?.updatedAt)
  return Number.isFinite(at) && now - at <= RESUME_WINDOW_MS
}

function persistResumeIntent(operation, resumeId) {
  return withDiskLock(operation.identity.sessionId, () => {
    const path = operationPath(operation.identity.sessionId, operation.identity.operationId)
    const live = path && safeJson(path)
    if (!live || live.revision !== operation.revision || !LIVE_STATES.includes(live.state) || !retryableReceipt(live.resumeReceipt)) return null
    const next = { ...live, revision: randomUUID(), resumeId, resumeReceipt: `intent:${resumeId}`, updatedAt: Date.now() }
    writeJsonAtomic(path, next)
    return next
  })
}

/** 续跑消息到底落地没有：`landed` / `absent`（确认没发出去） / `unknown`（拿不到分支） */
function probeResumeMessage(ctx, resumeId) {
  try {
    const branch = ctx?.sessionManager?.getBranch?.()
    if (!Array.isArray(branch)) return 'unknown'
    const marker = `[Context continuation ${resumeId}]`
    for (const entry of branch) {
      const content = entry?.message?.content ?? entry?.content
      if (typeof content === 'string' && content.includes(marker)) return 'landed'
      if (Array.isArray(content) && content.some((part) => typeof part?.text === 'string' && part.text.includes(marker))) {
        return 'landed'
      }
    }
    return 'absent'
  } catch {
    return 'unknown'
  }
}

function updateResumeReceipt(sessionId, operationId, resumeId, receipt) {
  withDiskLock(sessionId, () => {
    const path = operationPath(sessionId, operationId)
    const live = path && safeJson(path)
    if (!live || live.resumeId !== resumeId || !LIVE_STATES.includes(live.state)) return
    writeJsonAtomic(path, { ...live, revision: randomUUID(), resumeReceipt: receipt, updatedAt: Date.now() })
  })
}

/** 不再续跑：只写回执，操作保持已提交，投影继续生效 */
function skipResume(sessionId, operation, reason) {
  try {
    withDiskLock(sessionId, () => {
      const path = operationPath(sessionId, operation.identity.operationId)
      const live = path && safeJson(path)
      if (!live || !LIVE_STATES.includes(live.state) || !retryableReceipt(live.resumeReceipt)) return
      writeJsonAtomic(path, { ...live, revision: randomUUID(), resumeReceipt: `skipped:${String(reason).slice(0, 120)}`, updatedAt: Date.now() })
    })
  } catch { /* 写不上时下一次检查仍会按窗口判定 */ }
}

export function latestPendingAutoOperation(sessionId, ctx) {
  const { runnerId } = runnerIdentity()
  const livePolicy = readContextBudgetPolicyV1(sessionId)
  const liveCapability = capabilityRevision(ctx?.model)
  return operationFiles(sessionId).map((path) => safeJson(path)).filter((operation) =>
    operation?.requestKind === 'automatic' && operation.identity?.sessionId === sessionId &&
    operation.identity?.runnerId === runnerId &&
    LIVE_STATES.includes(operation.state) && retryableReceipt(operation.resumeReceipt) &&
    operation.base?.policyRevision === livePolicy.policyRevision && operation.base?.capabilityRevision === liveCapability
  ).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
}

export function scheduleAutomaticResume(pi, ctx) {
  rememberResumeSender(pi, ctx)
  const token = ++resumeScheduleToken
  const activity = resumeActivity
  const timer = setTimeout(() => {
    void (async () => {
      if (token !== resumeScheduleToken || activity !== resumeActivity) return
      const sessionId = sessionIdOf(ctx)
      const latest = sessionId ? latestPendingAutoOperation(sessionId, ctx) : null
      if (!latest || latest.identity?.sessionId !== sessionId || latest.requestKind !== 'automatic' ||
          !LIVE_STATES.includes(latest.state) || !retryableReceipt(latest.resumeReceipt)) return
      if (!withinResumeWindow(latest)) {
        skipResume(sessionId, latest, 'resume_window_elapsed')
        return
      }
      if (autoResumeStreak >= MAX_CONSECUTIVE_AUTO_RESUMES) {
        skipResume(sessionId, latest, 'auto_resume_limit')
        try {
          pi?.appendEntry?.('yan-context-resume', { operationId: latest.identity.operationId, stage: 'skipped', reason: 'auto_resume_limit', at: Date.now() })
        } catch { /* The receipt is authoritative. */ }
        return
      }
      const livePolicy = readContextBudgetPolicyV1(sessionId)
      if (livePolicy.inactive || livePolicy.unavailable || livePolicy.policyRevision !== latest.base?.policyRevision ||
          capabilityRevision(ctx?.model) !== latest.base?.capabilityRevision) return
      const active = safeJson(contextBudgetFiles(sessionId).active)
      if (!active || active.operationId !== latest.identity.operationId) return
      /* 事件里的 ctx 可能在定时器触发前因切会话 / 重载而失效；当前扩展的 pi 门面才是活的发送端 */
      const sender = typeof pi?.sendMessage === 'function' ? pi : resumeSender
      if (!sender) return
      const resumeId = latest.resumeId || randomUUID()
      const claimed = persistResumeIntent(latest, resumeId)
      if (!claimed) return
      autoResumeStreak += 1
      const operationId = latest.identity.operationId
      try {
        pi?.appendEntry?.('yan-context-resume', { operationId, resumeId, stage: 'sending', at: Date.now() })
        const current = safeJson(operationPath(sessionId, operationId))
        if (!current || !LIVE_STATES.includes(current.state) || current.resumeId !== resumeId ||
            current.resumeReceipt !== `intent:${resumeId}`) return
        await sender.sendMessage({
          customType: 'yan-context-resume',
          content: [{
            type: 'text',
            text: `[Context continuation ${resumeId}] The previous model request reached the context budget boundary. The active context now contains source-bound working notes for earlier assistant and tool messages; the originals remain retrievable through \`yan context find\` and \`yan context recall\`. Continue the latest pending user request without repeating completed actions or tool calls. If it is already complete, stop.`
          }],
          display: true
        }, { triggerTurn: true })
        updateResumeReceipt(sessionId, operationId, resumeId, `sent:${resumeId}`)
      } catch (error) {
        /*
         * 发送抛错时去分支里核实，不一律当「不确定」：
         * 否则重启时会被当成「可能已发送」锁成 needs_action，整理链就断在那里。
         */
        const probe = probeResumeMessage(ctx, resumeId)
        try {
          pi?.appendEntry?.('yan-context-resume-error', {
            operationId,
            resumeId,
            probe,
            error: String(error instanceof Error ? error.message : error).slice(0, 300),
            at: Date.now()
          })
        } catch { /* The receipt below remains authoritative. */ }
        if (probe === 'landed') updateResumeReceipt(sessionId, operationId, resumeId, `sent:${resumeId}`)
        else if (probe === 'absent') updateResumeReceipt(sessionId, operationId, resumeId, `failed:${resumeId}`)
        else updateResumeReceipt(sessionId, operationId, resumeId, `uncertain:${resumeId}`)
      }
    })()
  }, AUTO_RESUME_DELAY_MS)
  timer.unref?.()
}

/** 新任务在空闲窗口里到来：还没续跑的自动整理作废，免得续跑消息插在新任务前面 */
export function cancelPendingAutomaticResume(ctx, reason) {
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  const { runnerId } = runnerIdentity()
  for (const path of operationFiles(sessionId)) {
    withDiskLock(sessionId, () => {
      const operation = safeJson(path)
      if (!operation || operation.requestKind !== 'automatic' || operation.identity?.runnerId !== runnerId) return
      /* 已提交的整理照常生效，只是不再替用户续跑 */
      if (LIVE_STATES.includes(operation.state)) {
        if (!retryableReceipt(operation.resumeReceipt)) return
        writeJsonAtomic(path, {
          ...operation,
          revision: randomUUID(),
          resumeReceipt: `skipped:${String(reason).slice(0, 120)}`,
          updatedAt: Date.now()
        })
        return
      }
      if (operation.resumeReceipt !== null || !IN_FLIGHT_STATES.includes(operation.state)) return
      writeJsonAtomic(path, {
        ...operation,
        revision: randomUUID(),
        state: 'cancelled',
        failureCode: String(reason).slice(0, 160),
        updatedAt: Date.now()
      })
    })
  }
}

/**
 * 会话（重新）打开时：还没续跑的整理一律不再续跑。
 * 续跑只属于提交后的那个空闲窗口；打开会话时补发等于替用户开口。
 */
export function retirePendingAutomaticResumes(ctx, reason = 'session_start') {
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  for (const path of operationFiles(sessionId)) {
    const operation = safeJson(path)
    if (!operation || operation.requestKind !== 'automatic' || operation.identity?.sessionId !== sessionId ||
        !LIVE_STATES.includes(operation.state) || !retryableReceipt(operation.resumeReceipt)) continue
    skipResume(sessionId, operation, reason)
  }
}

/**
 * runner 重启后：上一代留下的半截事务。
 * 已有候选投影的先尝试提交（commit 由调用方注入，避免循环依赖）；
 * 仍停在进行中状态的、或续跑只到 intent 的，标为需要处理并注明原因。
 */
export function recoverInterruptedOperations(ctx, commitCandidate) {
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  const { runnerId, runnerEpoch } = runnerIdentity()
  for (const path of operationFiles(sessionId)) {
    let operation = safeJson(path)
    if (!operation || operation.identity?.sessionId !== sessionId || operation.identity?.runnerId !== runnerId ||
        operation.identity?.runnerEpoch === runnerEpoch) continue
    if (operation.state === 'validating' && operation.candidateRef) {
      try { operation = commitCandidate(sessionId, operation.identity.operationId, ctx) } catch { /* recovery UI can retry a persisted candidate */ }
    }
    const uncertain = LIVE_STATES.includes(operation.state) && operation.resumeReceipt?.startsWith('intent:')
    if (!IN_FLIGHT_STATES.includes(operation.state) && !uncertain) continue
    withDiskLock(sessionId, () => {
      const live = safeJson(path)
      if (!live || live.identity?.runnerEpoch === runnerEpoch) return
      /* 续跑只到 intent：不知道发没发出去，记成不确定；整理本身仍然有效 */
      if (LIVE_STATES.includes(live.state) && live.resumeReceipt?.startsWith('intent:')) {
        writeJsonAtomic(path, {
          ...live,
          revision: randomUUID(),
          resumeReceipt: `uncertain:${live.resumeId ?? live.resumeReceipt.slice('intent:'.length)}`,
          updatedAt: Date.now()
        })
        return
      }
      if (!IN_FLIGHT_STATES.includes(live.state)) return
      writeJsonAtomic(path, {
        ...live,
        revision: randomUUID(),
        state: 'needs_action',
        failureCode: 'runner_restarted_before_commit',
        failedStage: live.state,
        retryable: true,
        updatedAt: Date.now()
      })
    })
  }
}
