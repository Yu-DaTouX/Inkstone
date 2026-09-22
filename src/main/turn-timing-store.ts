/**
 * 回合计时元数据（实施-11 H-6）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════
 * `elapsedMs` 是宿主推送消息时**附上的 UI 字段**，pi 的会话 JSONL 不存它。
 * 于是切会话 / 重载之后，整轮用时只剩完成时刻 —— 用户看到的是「这一轮好像
 * 没花时间」。这里把宿主自己算出来的整轮结果留一份，读历史时挂回消息上。
 *
 * ── 三条边界（与其它数据存储一致）──
 *   ① **不生成平行历史**：消息仍以 pi 会话 JSONL 为真源，这里只装饰已有消息；
 *   ② **坏行不致命**：一条解析不了就跳过，不能因为一行脏数据让整个会话读不出来；
 *   ③ **版本化**：记录带 `v`；将来字段变了，旧记录按「未知版本」忽略而不是猜。
 *
 * 位置：`YAN_DATA_DIR/turn-timing/<sessionId>.jsonl`，只追加。
 * 为什么按会话分文件：切会话只读自己那一份，不用扫全目录。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TurnTerminalReason, TurnTimingMeta, UIMessage } from '../shared/ipc'
import type { WaitSpan } from '../shared/turns'

export const TURN_TIMING_VERSION = 1

export interface TurnTimingRecord extends TurnTimingMeta {
  v: number
  /**
   * 这一段工作的 **run** id（实施-11 H-6b）。
   *
   * 一个 `logicalTurnId` 下可能有多个 run（自动继续会开新的 pi 回合）：
   * 同一 run 的中途快照与终止快照是同一段工作（后者覆盖前者），
   * 不同 run 是串起来的另一段工作（用时相加）。旧记录没有这个字段，
   * 读回时保持「同一 ID 后者胜」的旧语义，不把历史翻倍。
   */
  runId?: string
  /** 工具等待分段（H-6b）：并行分支不重复计，求和走区间并集。 */
  waitSpans?: WaitSpan[]
  /**
   * 锚定的**用户消息 id**（`m<idx>`）。
   *
   * 为什么不用 assistant 消息 id：宿主推给界面的 assistant id 是临时生成的
   * （`a<base36>`），pi 的 JSONL 里没有它，重读历史时对不上。而用户消息的 id
   * 是两侧同一套 `normalizeMessage` 按顺序生成的 `m<idx>`，能对上。
   * 读回时找这条用户消息之后、下一条用户消息之前的最后一条助手消息。
   */
  anchorId?: string
  /** 这一轮归属的消息 id（按出现顺序）；锚不可用时才回退到它 */
  sourceIds: string[]
  /** 单调毫秒（诊断用）：能看出墙钟是否被调整过，不用于展示 */
  monotonicMs?: number
  /**
   * 写入这次快照时这一轮**是否已经收尾**（H-6b）。
   *
   * 为什么需要这个布尔：回合中途会写一次（`message_end`），终止时再写一次。
   * 如果应用在两者之间被强杀，盘上就只剩中途那条 —— 而“没有终止记录”
   * 本身就是一个结论：这一轮是被中断的，不是正常完成的。
   * 旧记录没有这个字段，按 `true`（已收尾）处理，不把历史误报成中断。
   */
  final?: boolean
}

const TERMINAL_REASONS: TurnTerminalReason[] = ['completed', 'stopped', 'failed', 'interrupted']

function isTerminalReason(value: unknown): value is TurnTerminalReason {
  return typeof value === 'string' && (TERMINAL_REASONS as string[]).includes(value)
}

/**
 * 会话 id → 文件名。
 *
 * 只保留 `[A-Za-z0-9._-]`：会话 id 来自宿主与 pi，理论上不含路径分隔符，
 * 但这是**文件名**，不做白名单就会给「用 id 做路径穿越」留口子。
 * 其它字符统一换成 `_`，空串回落到 `unknown`（宁可共用一个文件，也不写到目录外）。
 */
export function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length ? cleaned.slice(0, 120) : 'unknown'
}

export function turnTimingDir(dataDir: string): string {
  return join(dataDir, 'turn-timing')
}

/**
 * 计时日志的分桶 key。
 *
 * 用会话**文件名**而不是 `sessionId`：pi 的 `get_state` 在部分版本里不返回
 * sessionId（实测为空的会话根本不会落盘），而文件名是宿主两边 ——
 * `agent.hydrate()` 与 `peekSession` —— 都拿得到、且指向同一条会话的稳定标识。
 * 链式会话按段分桶：每段文件各有自己的日志，读哪段就取哪份。
 */
export function timingKey(sessionFile: string | undefined | null): string | null {
  if (!sessionFile) return null
  const base = String(sessionFile).split(/[\\/]/).pop() ?? ''
  const trimmed = base.replace(/\.jsonl$/i, '')
  return trimmed || null
}

export function turnTimingFile(dataDir: string, sessionId: string): string {
  return join(turnTimingDir(dataDir), `${sanitizeSessionId(sessionId)}.jsonl`)
}

/** 追加一条记录。写失败只返回 false —— 计时不是核心数据，不能因此中断回合。 */
export async function appendTurnTiming(
  dataDir: string,
  sessionId: string,
  record: TurnTimingRecord
): Promise<boolean> {
  try {
    await mkdir(turnTimingDir(dataDir), { recursive: true })
    await appendFile(turnTimingFile(dataDir, sessionId), `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function parseRecord(line: string): TurnTimingRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<TurnTimingRecord>
  if (item.v !== TURN_TIMING_VERSION) return null
  if (typeof item.logicalTurnId !== 'string' || !item.logicalTurnId) return null
  if (typeof item.startedAt !== 'number' || typeof item.endedAt !== 'number') return null
  if (typeof item.elapsedMs !== 'number' || !Number.isFinite(item.elapsedMs)) return null
  if (!isTerminalReason(item.terminalReason)) return null
  const sourceIds = Array.isArray(item.sourceIds)
    ? item.sourceIds.filter((id): id is string => typeof id === 'string' && !!id)
    : []
  return {
    v: TURN_TIMING_VERSION,
    logicalTurnId: item.logicalTurnId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    elapsedMs: Math.max(1, Math.round(item.elapsedMs)),
    terminalReason: item.terminalReason,
    ...(typeof item.anchorId === 'string' && item.anchorId ? { anchorId: item.anchorId } : {}),
    sourceIds,
    ...(typeof item.monotonicMs === 'number' && Number.isFinite(item.monotonicMs)
      ? { monotonicMs: item.monotonicMs }
      : {}),
    ...(typeof item.final === 'boolean' ? { final: item.final } : {}),
    ...(typeof item.runId === 'string' && item.runId ? { runId: item.runId } : {}),
    ...(Array.isArray(item.waitSpans) ? { waitSpans: parseWaitSpans(item.waitSpans) } : {})
  }
}

/** 等待分段容错解析：只收形状完整、且区间不反向的条目。 */
function parseWaitSpans(raw: unknown[]): WaitSpan[] {
  const spans: WaitSpan[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const s = item as Partial<WaitSpan>
    if (typeof s.id !== 'string' || !s.id) continue
    if (typeof s.name !== 'string') continue
    if (typeof s.startedAt !== 'number' || typeof s.endedAt !== 'number') continue
    if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.endedAt)) continue
    if (s.endedAt < s.startedAt) continue
    spans.push({ id: s.id, name: s.name, startedAt: s.startedAt, endedAt: s.endedAt })
  }
  return spans
}

/**
 * 同一逻辑回合的多条记录 → 一条（H-6b）。
 *
 * 两类重复必须分开处理，这是本函数存在的理由：
 *   · **同一 run**（中途快照 + 终止快照）：是同一段工作的两次快照 → 后者胜；
 *   · **不同 run**（自动继续）：是串起来的另一段真实工作 → 用时**相加**。
 *
 * 旧记录（没有 `runId`）无法区分这两种，保持原来的「后者胜」——
 * 宁可少算，也不能把旧历史的时间翻倍。
 */
export function mergeTurnRecords(id: string, list: TurnTimingRecord[]): TurnTimingRecord {
  const withRun = list.filter((r) => !!r.runId)
  if (!withRun.length) return list[list.length - 1]
  /* 同一 run 后者胜（顺序写入，Map 覆盖即得）。 */
  const byRun = new Map<string, TurnTimingRecord>()
  for (const r of withRun) byRun.set(r.runId as string, r)
  const runs = [...byRun.values()].sort((a, b) => a.startedAt - b.startedAt)
  if (runs.length === 1) return runs[0]

  const last = runs[runs.length - 1]
  const sourceIds: string[] = []
  for (const r of runs) {
    for (const sid of r.sourceIds) if (!sourceIds.includes(sid)) sourceIds.push(sid)
  }
  const waitSpans: WaitSpan[] = []
  for (const r of runs) {
    for (const s of r.waitSpans ?? []) waitSpans.push(s)
  }
  const anchorId = runs.map((r) => r.anchorId).find((a) => !!a)
  return {
    ...last,
    logicalTurnId: id,
    elapsedMs: Math.max(1, runs.reduce((n, r) => n + r.elapsedMs, 0)),
    startedAt: Math.min(...runs.map((r) => r.startedAt)),
    endedAt: Math.max(...runs.map((r) => r.endedAt)),
    sourceIds,
    ...(anchorId ? { anchorId } : {}),
    ...(waitSpans.length ? { waitSpans } : {})
  }
}

/**
 * 一条记录**最终**该报的终止原因（H-6b）。
 *
 * 只有一种改写：记录带着 `final === false`（中途快照）——那说明这一轮
 * 从来没有走到收尾，进程是在飞行中被拿掉的，所以是 `interrupted`。
 * 其余（`final === true` 或旧记录没这个字段）原样返回：宁可把中断显示成
 * 完成，也不能把正常结束的历史误报成中断。
 */
export function effectiveTerminalReason(record: TurnTimingRecord): TurnTerminalReason {
  return record.final === false ? 'interrupted' : record.terminalReason
}

/**
 * 读回一个会话的全部记录（每个**逻辑回合**一条）。
 *
 * 盘上同一 `logicalTurnId` 可能出现多条：中途快照 / 终止快照 / 自动继续。
 * 合并规则见 `mergeTurnRecords()` —— 同 run 后者胜、不同 run 用时相加。
 * 旧记录（无 `runId`）保持「后者胜」，不改变已有行为。
 */
export async function readTurnTimings(
  dataDir: string,
  sessionId: string
): Promise<TurnTimingRecord[]> {
  let text: string
  try {
    text = await readFile(turnTimingFile(dataDir, sessionId), 'utf8')
  } catch {
    return []
  }
  const byId = new Map<string, TurnTimingRecord[]>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const record = parseRecord(line)
    if (!record) continue
    const list = byId.get(record.logicalTurnId)
    if (list) list.push(record)
    else byId.set(record.logicalTurnId, [record])
  }
  return [...byId.entries()].map(([id, list]) => mergeTurnRecords(id, list))
}

/**
 * 把记录挂回消息（返回新数组，不改原对象）。
 *
 * 挂点选**这一轮的最后一条助手消息**：`groupIntoTurns` 取的就是它的
 * `elapsedMs`，挂在这里界面不需要认识新协议就能显示。
 *
 * 优先用 `anchorId`（用户消息 id）定位；它在历史里对得上时，找它之后、
 * 下一条用户消息之前的最后一条助手消息。锚不在（分叉裁掉、压缩换过历史、
 * 会话文件被替）时回退到 `sourceIds`，再对不上就**静默丢弃** ——
 * 宁可不显示用时，也不能把它挂到别的回合上。
 */
export function applyTurnTimings(messages: UIMessage[], records: TurnTimingRecord[]): UIMessage[] {
  if (!records.length || !messages.length) return messages
  const indexById = new Map<string, number>()
  messages.forEach((m, i) => indexById.set(m.id, i))

  const targetOf = (record: TurnTimingRecord): string | undefined => {
    const anchor = record.anchorId
    if (anchor) {
      const start = indexById.get(anchor)
      if (start !== undefined) {
        let target: string | undefined
        for (let i = start + 1; i < messages.length; i += 1) {
          if (messages[i].role === 'user') break
          if (messages[i].role === 'assistant') target = messages[i].id
        }
        if (target) return target
      }
    }
    for (let i = record.sourceIds.length - 1; i >= 0; i -= 1) {
      if (indexById.has(record.sourceIds[i])) return record.sourceIds[i]
    }
    return undefined
  }

  const patch = new Map<string, TurnTimingMeta>()
  for (const record of records) {
    const target = targetOf(record)
    if (!target) continue
    patch.set(target, {
      logicalTurnId: record.logicalTurnId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      elapsedMs: record.elapsedMs,
      terminalReason: effectiveTerminalReason(record)
    })
  }
  if (!patch.size) return messages
  return messages.map((m) => {
    const meta = patch.get(m.id)
    return meta ? { ...m, turnTiming: meta } : m
  })
}
