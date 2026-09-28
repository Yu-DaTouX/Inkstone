/**
 * 整理后的自动续跑与重启恢复。
 *
 * 自动整理提交后，原请求停在预算边界上；这里在空闲窗口过后发一条续跑消息，
 * 让模型接着处理最后一个待办的用户请求。每条续跑都有回执（operation.resumeReceipt）：
 *   intent:<id>     已领取、正在发送
 *   sent:<id>       确认已落地
 *   failed:<id>     确认没发出去（可安全重领）
 *   uncertain:<id>  发送抛错且无法核实 —— 不自动重发，交给用户处理（防止重复执行）
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
const MAX_OPERATION_FILES = 2_000

let resumeActivity = 0
let resumeScheduleToken = 0
let resumeSender = null

/** 有新的用户任务或工具调用时调用：空闲窗口里排队的续跑作废 */
export function noteAgentActivity() {
  resumeActivity += 1
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

/** 学习练习正在等用户作答时不自动续跑（续跑会替用户把练习做掉） */
function waitingForLearner() {
  const runnerId = (process.env.YAN_SESSION_ID?.trim() || 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  const gate = safeJson(join(dataDir(), 'study-gate', `${runnerId || 'session'}.json`), 1024 * 1024)
  return gate?.waiting === true
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

function updateResumeReceipt(sessionId, operationId, resumeId, receipt, failureCode = null) {
  withDiskLock(sessionId, () => {
    const path = operationPath(sessionId, operationId)
    const live = path && safeJson(path)
    if (!live || live.resumeId !== resumeId || !LIVE_STATES.includes(live.state)) return
    writeJsonAtomic(path, {
      ...live,
      revision: randomUUID(),
      resumeReceipt: receipt,
      ...(failureCode ? { state: 'needs_action', failureCode, failedStage: 'resuming', retryable: false } : {}),
      updatedAt: Date.now()
    })
  })
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
      if (waitingForLearner()) return
      const sessionId = sessionIdOf(ctx)
      const latest = sessionId ? latestPendingAutoOperation(sessionId, ctx) : null
      if (!latest || latest.identity?.sessionId !== sessionId || latest.requestKind !== 'automatic' ||
          !LIVE_STATES.includes(latest.state) || !retryableReceipt(latest.resumeReceipt)) return
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
        else updateResumeReceipt(sessionId, operationId, resumeId, `uncertain:${resumeId}`, 'resume_send_uncertain')
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
      if (!operation || operation.requestKind !== 'automatic' || operation.identity?.runnerId !== runnerId || operation.resumeReceipt !== null ||
          ![...IN_FLIGHT_STATES, ...LIVE_STATES].includes(operation.state)) return
      writeJsonAtomic(path, {
        ...operation,
        revision: randomUUID(),
        state: LIVE_STATES.includes(operation.state) ? 'superseded' : 'cancelled',
        failureCode: String(reason).slice(0, 160),
        updatedAt: Date.now()
      })
    })
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
      const uncertainResume = LIVE_STATES.includes(live.state) && live.resumeReceipt?.startsWith('intent:')
      if (!uncertainResume && !IN_FLIGHT_STATES.includes(live.state)) return
      writeJsonAtomic(path, {
        ...live,
        revision: randomUUID(),
        state: 'needs_action',
        failureCode: uncertainResume ? 'resume_send_uncertain' : 'runner_restarted_before_commit',
        failedStage: uncertainResume ? 'resuming' : live.state,
        retryable: !uncertainResume,
        updatedAt: Date.now()
      })
    })
  }
}
