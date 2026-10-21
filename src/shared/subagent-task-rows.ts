import { formatDuration } from './duration'
import type { SubagentRun } from './ipc'

export type SubagentRowState = 'starting' | 'running' | 'stopping' | 'done' | 'failed' | 'stopped' | 'unknown'
export type SubagentRowTense = 'active' | 'done' | 'failed'
export type SubagentRowLang = 'zh-CN' | 'en-US'
export type SubagentConnection = 'connected' | 'disconnected'

export interface SubagentTaskRow {
  id: string
  state: SubagentRowState
  tense: SubagentRowTense
  description: string
  label: string
  model: string | null
  tokens: number | null
  toolCalls: number
  latestActivity: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  canStop: boolean
  summaryLine: string | null
}

export function isLiveSubagentRun(run: Pick<SubagentRun, 'status'>): boolean {
  return run.status === 'starting' || run.status === 'running'
}

export function mergeSubagentRun(prev: SubagentRun | undefined, next: SubagentRun): SubagentRun {
  if (!prev) return next
  const prevLive = isLiveSubagentRun(prev)
  const nextLive = isLiveSubagentRun(next)
  if (!prevLive && nextLive) return prev
  if (prevLive && !nextLive) return next
  if (!prevLive && !nextLive) return (next.endedAt ?? 0) >= (prev.endedAt ?? 0) ? next : prev
  if (prev.status === 'running' && next.status === 'starting') return prev
  return next
}

export function dedupeSubagentRuns(runs: readonly SubagentRun[]): SubagentRun[] {
  const byId = new Map<string, SubagentRun>()
  for (const run of runs) byId.set(run.id, mergeSubagentRun(byId.get(run.id), run))
  return [...byId.values()]
}

export function subagentRunTokens(run: Pick<SubagentRun, 'usage'>): number | null {
  const usage = run.usage
  if (!usage) return null
  const parts = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const total = parts > 0 ? parts : Math.max(0, usage.totalTokens ?? 0)
  return total > 0 ? total : null
}

const DESCRIPTION_MAX = 80

function describeSubagentRun(run: Pick<SubagentRun, 'task' | 'brief'>): string {
  const raw = run.brief?.title?.trim() || run.brief?.goal?.trim() || run.task
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  const chars = [...firstLine]
  return chars.length > DESCRIPTION_MAX ? `${chars.slice(0, DESCRIPTION_MAX - 1).join('')}…` : firstLine
}

interface VerbForms {
  active: string
  done: string
  failed: string
}

interface TenseRules {
  verbs: Record<string, VerbForms>
  generic: Record<SubagentRowState, string>
  match(description: string): { verb: string; rest: string } | null
  join(prefix: string, rest: string, tense: SubagentRowTense): string
  genericJoin(prefix: string, description: string): string
}

const ZH_VERBS: Record<string, VerbForms> = Object.fromEntries(
  ['调查', '分析', '检查', '审查', '梳理', '搜索', '查找', '阅读', '研究', '实现', '修复', '重构', '编写', '测试', '验证', '整理', '总结', '对比', '排查', '迁移', '优化', '核对', '收集'].map((verb) => [
    verb,
    { active: `正在${verb}`, done: `已${verb}`, failed: `${verb}失败` }
  ])
)

const EN_VERBS: Record<string, VerbForms> = Object.fromEntries(
  [
    ['investigate', 'Investigating', 'Investigated'],
    ['analyze', 'Analyzing', 'Analyzed'],
    ['check', 'Checking', 'Checked'],
    ['review', 'Reviewing', 'Reviewed'],
    ['search', 'Searching', 'Searched'],
    ['find', 'Finding', 'Found'],
    ['read', 'Reading', 'Read'],
    ['research', 'Researching', 'Researched'],
    ['implement', 'Implementing', 'Implemented'],
    ['fix', 'Fixing', 'Fixed'],
    ['refactor', 'Refactoring', 'Refactored'],
    ['write', 'Writing', 'Wrote'],
    ['test', 'Testing', 'Tested'],
    ['verify', 'Verifying', 'Verified'],
    ['summarize', 'Summarizing', 'Summarized'],
    ['compare', 'Comparing', 'Compared'],
    ['migrate', 'Migrating', 'Migrated'],
    ['optimize', 'Optimizing', 'Optimized'],
    ['collect', 'Collecting', 'Collected']
  ].map(([verb, active, done]) => [verb, { active, done, failed: `Failed to ${verb}` }])
)

const RULES: Record<SubagentRowLang, TenseRules> = {
  'zh-CN': {
    verbs: ZH_VERBS,
    generic: { starting: '启动中', running: '进行中', stopping: '停止中', done: '已完成', failed: '已失败', stopped: '已停止', unknown: '状态未知' },
    match(description) {
      const verb = Object.keys(ZH_VERBS).find((candidate) => description.startsWith(candidate))
      return verb ? { verb, rest: description.slice(verb.length).trimStart() } : null
    },
    join: (prefix, rest, tense) => (tense === 'failed' ? `${prefix}：${rest}` : `${prefix}${rest}`),
    genericJoin: (prefix, description) => `${prefix}：${description}`
  },
  'en-US': {
    verbs: EN_VERBS,
    generic: { starting: 'Starting', running: 'Running', stopping: 'Stopping', done: 'Completed', failed: 'Failed', stopped: 'Stopped', unknown: 'Status unknown' },
    match(description) {
      const word = description.split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
      if (!word || !EN_VERBS[word]) return null
      const space = description.indexOf(' ')
      const rest = space < 0 ? '' : description.slice(space + 1).trim()
      return rest ? { verb: word, rest } : null
    },
    join: (prefix, rest) => `${prefix} ${rest}`,
    genericJoin: (prefix, description) => `${prefix}: ${description}`
  }
}

function tenseOfState(state: SubagentRowState): SubagentRowTense {
  if (state === 'done') return 'done'
  if (state === 'failed' || state === 'stopped') return 'failed'
  return 'active'
}

export function subagentRowLabel(state: SubagentRowState, description: string, lang: SubagentRowLang = 'zh-CN'): string {
  const rules = RULES[lang]
  if (!description) return rules.generic[state]
  const tense = tenseOfState(state)
  const usesVerbForms = state === 'running' || state === 'done' || state === 'failed'
  const hit = usesVerbForms ? rules.match(description) : null
  if (hit && hit.rest) return rules.join(rules.verbs[hit.verb][tense], hit.rest, tense)
  return rules.genericJoin(rules.generic[state], description)
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

export function subagentSummaryLine(
  input: { toolCalls: number; tokens: number | null; durationMs: number | null },
  lang: SubagentRowLang = 'zh-CN'
): string {
  const zh = lang === 'zh-CN'
  const parts = [zh ? `${input.toolCalls} 个工具` : `${input.toolCalls} ${input.toolCalls === 1 ? 'tool' : 'tools'}`]
  if (input.tokens !== null && input.tokens > 0) parts.push(`${compactTokens(input.tokens)} tokens`)
  if (input.durationMs !== null) parts.push(formatDuration(input.durationMs, { minSeconds: 1 }))
  return parts.join(' · ')
}

function rowState(run: SubagentRun, connection: SubagentConnection, stopping: boolean): SubagentRowState {
  if (isLiveSubagentRun(run)) {
    if (connection === 'disconnected') return 'unknown'
    if (stopping) return 'stopping'
    return run.status === 'starting' ? 'starting' : 'running'
  }
  if (run.status === 'done') return 'done'
  if (run.status === 'cancelled') return 'stopped'
  return 'failed'
}

export function buildSubagentTaskRow(
  run: SubagentRun,
  options: { now: number; lang?: SubagentRowLang; connection?: SubagentConnection; stopping?: boolean }
): SubagentTaskRow {
  const lang = options.lang ?? 'zh-CN'
  const state = rowState(run, options.connection ?? 'connected', options.stopping === true)
  const live = isLiveSubagentRun(run)
  const description = describeSubagentRun(run)
  const tokens = subagentRunTokens(run)
  const toolCalls = Math.max(0, Math.floor(run.toolCalls ?? 0))
  const endedAt = !live && typeof run.endedAt === 'number' ? run.endedAt : null
  const durationMs = state === 'unknown' ? null : Math.max(0, (endedAt ?? options.now) - run.startedAt)
  return {
    id: run.id,
    state,
    tense: tenseOfState(state),
    description,
    label: subagentRowLabel(state, description, lang),
    model: run.model?.trim() || null,
    tokens,
    toolCalls,
    latestActivity: live ? run.latestActivity?.trim() || null : null,
    startedAt: run.startedAt,
    endedAt,
    durationMs,
    canStop: state === 'starting' || state === 'running',
    summaryLine: state === 'done' ? subagentSummaryLine({ toolCalls, tokens, durationMs }, lang) : null
  }
}
