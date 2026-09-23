/**
 * 交接 / 上下文整理的**非阻塞状态**判定（实施-14 F5 / H5）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 用户报的是「两次完整压缩之后交接没有提示、偶尔报错」。F0 已经把每个阶段
 * 落成事件了，但事件流本身不是给用户看的 —— 这一层把「现在该不该说、
 * 说什么、能不能重试」判成一个纯函数，界面只负责渲染。
 *
 * ── 三条口径 ──
 *   ① **无感不等于静默**：正在整理时说「任务继续中」，不暴露会话迁移操作；
 *   ② **成功短暂、失败留住**：成功态只在时间窗内显示（过期自动收起），
 *      失败态一直留到用户处理（重试 / 停止）或下一次成功；
 *   ③ **不循环弹技术错误**：原因翻成人话，明细留在 `getHandoff().events`。
 *
 * ── 第四条（2026-09-23 用户现场补上）──
 *   ④ **常态不算失败**：资格不够（`below-threshold` / `no-goal` / `not-autonomous` / `busy`）、
 *      安全边界拒绝（`source-watermark-moved` 这类）、以及用户自己打断的中止都不弹提示。
 *      每次回合结束都会评估一次资格，**每个新会话第一眼就会有一条** `below-threshold` ——
 *      把它当失败，用户会在一条什么都没发生的会话里看到「整理未完成」
 *      （原文案甚至会说「这个片段还没有压够次数」）。想查「为什么没交接」去 events。
 *
 * ⚠️ 判据只用 `HandoffView` 里已有的字段（`pending` / `events`），
 * 不引入第二份状态 —— 否则事件与显示迟早会不一致。
 */

import type { HandoffView } from './handoff'

export type HandoffNoticeTone = 'working' | 'done' | 'failed'

export interface HandoffNotice {
  tone: HandoffNoticeTone
  /** 机器可读的失败原因（界面翻成人话；成功 / 进行中为 null） */
  reason: string | null
  /** 失败时是否给「重试」入口（成功 / 进行中不给） */
  canRetry: boolean
}

/** 「这件事成了」的结论性事件。 */
const SUCCESS_OUTCOMES = new Set(['package-ready', 'ok', 'resume-confirmed', 'state-inherited'])

/**
 * 「这件事没成 / 被打断」的结论性事件。
 *
 * ⚠️ 不含 `result-mismatch`：那只是说明磁盘上有一份**别的**操作的结果文件，
 * 本次操作还在正常等待 —— 把它当失败会在每秒轮询里刷出一个假故障。
 *
 * ⚠️ 也**不含 `rejected`**（2026-09-23 改）：资格拒绝（`below-threshold` / `no-goal` /
 * `not-autonomous` / `busy` / `goal-not-active`）与安全边界拒绝（`source-watermark-moved` /
 * `goal-changed` / `mode-changed`）全是**常态**，不是故障 —— “这次不交接，因为还没到时候”。
 * 它们每个回合结束都会记一条（诊断日志本来就是干这个的），但界面照它弹提示，
 * 就会出现“每个对话都说整理未完成”（用户现场原文）。
 */
const FAILED_OUTCOMES = new Set([
  'request-write-failed',
  'arm-threw',
  'failed',
  'unparsable',
  'incomplete',
  'persist-failed',
  'abandoned',
  'halted',
  'threw',
  'unconfirmed',
  'repeat-guard-failed'
])

/**
 * `abandoned` 要看原因：只有「等超时」是故障。
 *
 * 用户发言 / 停止 / 点重试（`user-message` / `user-stop` / `manual-retry`）
 * 导致的中止是**用户自己的动作**，并且他会看到自己刚做的事 —— 再弹一行红只会添乱。
 */
const FAILED_ABANDON_REASONS = new Set(['timeout'])

/** 这条事件算不算「失败」（`abandoned` 要连原因一起看）。 */
function isFailureEvent(event: { outcome: string; reason?: string | null }): boolean {
  if (!FAILED_OUTCOMES.has(event.outcome)) return false
  if (event.outcome === 'abandoned') return FAILED_ABANDON_REASONS.has(String(event.reason ?? ''))
  return true
}

/** 成功态保留多久（过期后这一行收起 —— 成功不需要一直占地方）。 */
export const HANDOFF_DONE_WINDOW_MS = 60_000

/**
 * 现在该显示什么（`null` = 什么都不显示）。
 *
 * 判定顺序：进行中 > 失败（且比最近一次成功更晚）> 近期成功 > 不显示。
 */
export function handoffNoticeOf(
  view: HandoffView | null | undefined,
  now: number,
  doneWindowMs = HANDOFF_DONE_WINDOW_MS
): HandoffNotice | null {
  if (!view) return null
  if (view.pending) return { tone: 'working', reason: null, canRetry: false }

  const events = view.events ?? []
  let lastFailureAt: number | null = null
  let lastFailureReason: string | null = null
  let lastSuccessAt: number | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (lastSuccessAt === null && SUCCESS_OUTCOMES.has(event.outcome)) lastSuccessAt = event.at
    if (lastFailureAt === null && isFailureEvent(event)) {
      lastFailureAt = event.at
      lastFailureReason = event.reason ?? event.outcome
    }
    if (lastFailureAt !== null && lastSuccessAt !== null) break
  }

  if (lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt)) {
    return { tone: 'failed', reason: lastFailureReason, canRetry: true }
  }
  if (lastSuccessAt !== null && now - lastSuccessAt <= doneWindowMs) {
    return { tone: 'done', reason: null, canRetry: false }
  }
  return null
}

/**
 * 失败原因 → 一句人话。
 *
 * 未登记的原因原样回传（宁可显示机器码，也不要把真实原因藏起来 ——
 * 用户报障时要能对上诊断日志）。
 */
const REASON_TEXT: Record<string, string> = {
  'below-threshold': '这个片段还没有压够次数',
  'no-goal': '这条会话还没有在推进的目标',
  'goal-not-active': '目标已经不在推进阶段',
  'not-autonomous': '当前不是自主档',
  busy: '还有后台工作没结束',
  'request-write-failed': '生成请求没能写下去',
  timeout: '整理超时（已放弃这一次，会话没有受影响）',
  'arm-threw': '整理过程出错',
  failed: '模型没能写出交接包',
  unparsable: '交接包格式不对，已丢弃',
  incomplete: '交接包缺必填内容，已丢弃',
  'persist-failed': '交接包没能落盘',
  'operation-replaced': '已经有更新的一次整理在进行',
  'runner-gone': '原来的运行实例已经不在了',
  'not-idle': '实例又开始工作了（等它停下来再继续）',
  'source-session-changed': '期间切到了别的会话',
  'goal-changed': '期间目标变了',
  'mode-changed': '期间档位改了',
  'source-watermark-moved': '期间你说了话（沿用你最新的输入，没有换片段）',
  'repeat-guard-failed': '重复动作计数没能记上',
  unconfirmed: '续接消息发出去了，但还没在会话里确认',
  'manual-retry': '你点了重试',
  halted: '交接事务停在中途（已保留原会话）'
}

export function handoffReasonText(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || !reason.trim()) return null
  const key = reason.trim()
  return REASON_TEXT[key] ?? key
}
