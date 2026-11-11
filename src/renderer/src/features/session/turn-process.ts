import type { UIMessage, UIToolCall } from '../../../../shared/ipc'
import type { AssistantTurn, TurnSegment, TurnThinking } from '../../../../shared/turns'
import { countedWorkCalls, isWebTool, normalizeToolPath, subagentStartCount, summarizeToolRun, toolCategory } from './tool-run-model'
import { callPath, collectTurnChanges, isInsideCwd, readFileDiff, readPiDiff, type TurnChanges, type TurnFileChange, type TurnFileStatus } from './turn-changes'
import { isHistoryQuestionCall } from './question-receipt'
import { searchStepOf } from './web-search/model'
import { isSubagentNotice } from '../../../../shared/subagent-notice'
import { messageIndex } from './message-index'

const LIVE_SEGMENTS = 3

interface TurnProcessSplit {
  process: TurnSegment[]
  reply: TurnSegment | null
  leadReplies: TurnSegment[]
  earlierReplies: TurnSegment[]
  tail: TurnSegment[]
}

function hasWork(segment: TurnSegment): boolean {
  return segment.commentary.length > 0 || segment.tools.length > 0
}

function hasThinking(segment: TurnSegment): boolean {
  return segment.thinking.trim().length > 0
}

function inProcess(segment: TurnSegment): boolean {
  return hasWork(segment) || hasThinking(segment)
}

function withWork(process: TurnSegment[], keepThinking: boolean): TurnSegment[] {
  return keepThinking || process.some(hasWork) ? process : []
}

function withoutResponse(segment: TurnSegment): TurnSegment {
  return { ...segment, response: null, responseParts: undefined }
}

function narrationOf(segment: TurnSegment): TurnSegment {
  return {
    ...segment,
    id: `${segment.id}:narration`,
    thinking: '',
    thinkingMs: undefined,
    thinkingLive: false,
    thinkingParts: [],
    tools: [],
    texts: [],
    commentary: segment.responseParts?.length ? segment.responseParts : segment.response ? [segment.response] : [],
    response: null,
    responseParts: undefined
  }
}

export function splitTurnProcess(segments: readonly TurnSegment[], options: { keepThinking?: boolean; foldReplies?: boolean } = {}): TurnProcessSplit {
  const keepThinking = options.keepThinking === true
  let at = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].response) {
      at = i
      break
    }
  }
  if (at < 0) {
    return { process: withWork(segments.filter(inProcess), keepThinking), reply: null, leadReplies: [], earlierReplies: [], tail: [] }
  }

  const replySource = segments[at]
  const firstWork = segments.findIndex((segment) => segment.tools.length > 0)
  const leadReplies: TurnSegment[] = []
  const earlierReplies: TurnSegment[] = []
  const candidates: TurnSegment[] = []
  const folds = options.foldReplies === true && firstWork >= 0 && firstWork <= at
  segments.slice(0, at).forEach((segment, index) => {
    const beforeWork = firstWork < 0 || index < firstWork
    const fold = !!segment.response && folds
    if (segment.response && !fold) (beforeWork ? leadReplies : earlierReplies).push(segment)
    if (inProcess(segment)) candidates.push(fold ? withoutResponse(segment) : segment)
    if (fold) candidates.push(narrationOf(segment))
  })
  if (inProcess(replySource)) {
    candidates.push(withoutResponse(replySource))
  }
  const process = withWork(candidates, keepThinking)
  const reply: TurnSegment = {
    ...replySource,
    thinking: '',
    thinkingMs: undefined,
    thinkingLive: false,
    commentary: [],
    tools: [],
    texts: [],
    responseParts: replySource.responseParts
  }
  return { process, reply, leadReplies, earlierReplies, tail: segments.slice(at + 1) }
}

function rawThinkingParts(segment: TurnSegment): TurnThinking[] {
  if (segment.thinkingParts) return segment.thinkingParts
  if (!hasThinking(segment)) return []
  return [{ text: segment.thinking, at: 0, ...(segment.thinkingMs ? { ms: segment.thinkingMs } : {}) }]
}

interface ProcessThinking extends TurnThinking {
  live: boolean
}

type ProcessNote = TurnSegment['commentary'][number]

type ProcessStep =
  | { kind: 'thinking'; key: string; thinking: ProcessThinking }
  | { kind: 'notes'; key: string; notes: ProcessNote[] }
  | { kind: 'tools'; key: string; tools: UIToolCall[] }

function segmentThinking(segment: TurnSegment): ProcessThinking[] {
  const joined: TurnThinking[] = []
  for (const part of rawThinkingParts(segment)) {
    if (!part.text.trim()) continue
    const at = Math.max(0, Math.min(part.at, segment.tools.length))
    const last = joined[joined.length - 1]
    if (last && last.at === at) {
      const ms = (last.ms ?? 0) + (part.ms ?? 0)
      joined[joined.length - 1] = { text: `${last.text}\n\n${part.text}`, at, ...(ms ? { ms } : {}), ...(part.startedAt ?? last.startedAt ? { startedAt: part.startedAt ?? last.startedAt } : {}) }
    } else {
      joined.push({ ...part, at })
    }
  }
  return joined.map((part, index) => ({ ...part, live: segment.thinkingLive && index === joined.length - 1 }))
}

function noteAt(note: ProcessNote, tools: number): number {
  return Math.max(0, Math.min(note.at ?? 0, tools))
}

export function segmentSteps(segment: TurnSegment): ProcessStep[] {
  const thinking = segmentThinking(segment)
  const total = segment.tools.length
  const positions = [...new Set([...thinking.map((part) => part.at), ...segment.commentary.map((note) => noteAt(note, total))])].sort((a, b) => a - b)
  const steps: ProcessStep[] = []
  let from = 0
  for (const at of positions) {
    if (at > from) {
      steps.push({ kind: 'tools', key: `tools:${from}`, tools: segment.tools.slice(from, at) })
      from = at
    }
    const part = thinking.find((item) => item.at === at)
    if (part) steps.push({ kind: 'thinking', key: `thinking:${at}`, thinking: part })
    const notes = segment.commentary.filter((note) => noteAt(note, total) === at)
    if (notes.length) steps.push({ kind: 'notes', key: `notes:${at}`, notes })
  }
  if (from < total) steps.push({ kind: 'tools', key: `tools:${from}`, tools: segment.tools.slice(from) })
  return steps
}

export type SpreadItem =
  | { kind: 'notes'; key: string; notes: ProcessNote[] }
  | { kind: 'group'; key: string; segments: TurnSegment[] }

interface SegmentPiece {
  work: TurnSegment
  notes: ProcessNote[]
}

const segmentPieceCache = new WeakMap<TurnSegment, SegmentPiece[]>()

function cutSegmentAtNotes(segment: TurnSegment): SegmentPiece[] {
  if (!segment.commentary.length) return [{ work: segment, notes: [] }]
  const total = segment.tools.length
  const parts = rawThinkingParts(segment).map((part) => ({ ...part, at: Math.max(0, Math.min(part.at, total)) }))
  const liveThought = segment.thinkingLive ? parts.findLast((part) => part.text.trim()) : undefined
  const cuts = [...new Set(segment.commentary.map((note) => noteAt(note, total)))].sort((a, b) => a - b)
  const pieces: SegmentPiece[] = []
  let from = 0
  let after = -1
  const workUntil = (to: number): TurnSegment => {
    const own = parts.filter((part) => part.at > after && part.at <= to)
    const thinkingMs = own.reduce((sum, part) => sum + (part.ms ?? 0), 0)
    return {
      ...segment,
      id: pieces.length ? `${segment.id}~${pieces.length}` : segment.id,
      tools: segment.tools.slice(from, to),
      thinking: own.map((part) => part.text).filter((text) => text.trim()).join('\n\n'),
      thinkingMs: thinkingMs || undefined,
      thinkingLive: !!liveThought && own.includes(liveThought),
      thinkingParts: own.map((part) => ({ ...part, at: part.at - from })),
      texts: [],
      commentary: []
    }
  }
  for (const cut of cuts) {
    pieces.push({ work: workUntil(cut), notes: segment.commentary.filter((note) => noteAt(note, total) === cut) })
    from = cut
    after = cut
  }
  pieces.push({ work: workUntil(total), notes: [] })
  return pieces
}

function segmentPieces(segment: TurnSegment): SegmentPiece[] {
  const cached = segmentPieceCache.get(segment)
  if (cached) return cached
  const pieces = cutSegmentAtNotes(segment)
  segmentPieceCache.set(segment, pieces)
  return pieces
}

function quietThinkingGroup(item: SpreadItem): boolean {
  return item.kind === 'group' && item.segments.every((segment) => !segment.tools.length && !segment.thinkingLive)
}

export function spreadProcess(process: readonly TurnSegment[], options: { foldThinking?: boolean } = {}): SpreadItem[] {
  const items: SpreadItem[] = []
  for (const segment of process) {
    for (const piece of segmentPieces(segment)) {
      if (hasSegmentContent(piece.work)) {
        const last = items[items.length - 1]
        if (last?.kind === 'group') last.segments.push(piece.work)
        else items.push({ kind: 'group', key: `group:${piece.work.id}`, segments: [piece.work] })
      }
      if (piece.notes.length) {
        const last = items[items.length - 1]
        if (last?.kind === 'notes') last.notes.push(...piece.notes)
        else items.push({ kind: 'notes', key: `notes:${piece.notes[0].id}`, notes: [...piece.notes] })
      }
    }
  }
  if (!options.foldThinking) return items
  const lastGroup = items.findLastIndex((item) => item.kind === 'group')
  const folded: SpreadItem[] = []
  let carried: TurnSegment[] = []
  items.forEach((item, index) => {
    if (item.kind !== 'group') {
      folded.push(item)
    } else if (index < lastGroup && quietThinkingGroup(item)) {
      carried.push(...item.segments)
    } else {
      folded.push(carried.length ? { ...item, segments: [...carried, ...item.segments] } : item)
      carried = []
    }
  })
  return folded
}

export function spreadEndsInGroup(process: readonly TurnSegment[]): boolean {
  return spreadProcess(process).at(-1)?.kind === 'group'
}

export function conciseSegment(segment: TurnSegment): TurnSegment {
  if (!segment.thinking && !segment.thinkingParts?.length) return segment
  const live = segment.thinkingLive ? rawThinkingParts(segment).filter((part) => part.text.trim()).at(-1) : undefined
  const kept = live ? { ...live, at: segment.tools.length } : null
  return {
    ...segment,
    thinking: kept ? kept.text : '',
    thinkingMs: kept?.ms,
    thinkingLive: !!kept,
    thinkingParts: kept ? [kept] : []
  }
}

export function withoutThinking(segment: TurnSegment): TurnSegment {
  if (!segment.thinking && !segment.thinkingParts?.length && !segment.thinkingLive) return segment
  return { ...segment, thinking: '', thinkingMs: undefined, thinkingLive: false, thinkingParts: [] }
}

export interface CompactionCut {
  messageId: string
  toolId: string | null
}

function splitSegmentAfterTool(segment: TurnSegment, toolId: string): [TurnSegment, TurnSegment] | null {
  const index = segment.tools.findIndex((tool) => tool.id === toolId)
  const cut = index + 1
  if (index < 0 || cut >= segment.tools.length) return null
  const parts = rawThinkingParts(segment)
  const headParts = parts.filter((part) => part.at < cut)
  const tailParts = parts.filter((part) => part.at >= cut).map((part) => ({ ...part, at: part.at - cut }))
  const head: TurnSegment = {
    ...segment,
    tools: segment.tools.slice(0, cut),
    thinking: headParts.map((part) => part.text).join('\n\n'),
    thinkingMs: headParts.reduce((sum, part) => sum + (part.ms ?? 0), 0) || undefined,
    thinkingLive: false,
    thinkingParts: headParts,
    texts: [],
    response: null,
    responseParts: [],
    commentary: segment.commentary.filter((note) => noteAt(note, segment.tools.length) < cut)
  }
  const tail: TurnSegment = {
    ...segment,
    id: `${segment.id}~after`,
    tools: segment.tools.slice(cut),
    thinking: tailParts.map((part) => part.text).join('\n\n'),
    thinkingMs: tailParts.reduce((sum, part) => sum + (part.ms ?? 0), 0) || undefined,
    thinkingParts: tailParts,
    commentary: segment.commentary.filter((note) => noteAt(note, segment.tools.length) >= cut).map((note) => ({ ...note, at: (note.at ?? 0) - cut }))
  }
  return [head, tail]
}

export function splitAtCompaction(process: readonly TurnSegment[], at: CompactionCut): { before: TurnSegment[]; after: TurnSegment[] } | null {
  const byTool = at.toolId ? process.findIndex((segment) => segment.tools.some((tool) => tool.id === at.toolId)) : -1
  const index = byTool >= 0 ? byTool : process.findIndex((segment) => segment.sourceMessageId === at.messageId)
  if (index < 0) return null
  const halves = byTool >= 0 && at.toolId ? splitSegmentAfterTool(process[index], at.toolId) : null
  return halves
    ? { before: [...process.slice(0, index), halves[0]], after: [halves[1], ...process.slice(index + 1)] }
    : { before: process.slice(0, index + 1), after: process.slice(index + 1) }
}

export function hasSegmentContent(segment: TurnSegment): boolean {
  return segment.tools.length > 0 || segment.commentary.length > 0 || !!segment.thinking?.trim() || !!segment.thinkingParts?.length || !!segment.thinkingLive
}

export function mergeQuietSegments(process: readonly TurnSegment[]): TurnSegment[] {
  const merged: TurnSegment[] = []
  for (const segment of process) {
    const previous = merged[merged.length - 1]
    if (previous && !segment.commentary.length && previous.tools.length && segment.tools.length) {
      const thinkingMs = (previous.thinkingMs ?? 0) + (segment.thinkingMs ?? 0)
      const offset = previous.tools.length
      merged[merged.length - 1] = {
        ...previous,
        thinking: [previous.thinking, segment.thinking].filter((part) => part.trim()).join('\n\n'),
        thinkingMs: thinkingMs || undefined,
        thinkingLive: previous.thinkingLive || segment.thinkingLive,
        thinkingParts: [...rawThinkingParts(previous), ...rawThinkingParts(segment).map((part) => ({ ...part, at: part.at + offset }))],
        tools: [...previous.tools, ...segment.tools]
      }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

export interface ProcessFileChange {
  path: string
  base: string
  added: number | null
  removed: number | null
}

export interface ProcessSummary {
  thinking: number
  actions: number
  tools: number
  failed: number
  commands: number
  code: number
  reads: number
  edits: ProcessFileChange[]
  creates: ProcessFileChange[]
  searches: number
  lists: number
  web: number
  fetches: number
  agents: number
  questions: number
  other: number
}

function textLines(text: string): string[] {
  return text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
}

export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = textLines(before)
  const b = textLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return { added: b.length - head - tail, removed: a.length - head - tail }
}

function stringField(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof source[key] === 'string') return source[key] as string
  return null
}

export function estimateCallLines(call: Pick<UIToolCall, 'args' | 'details'>): { added: number; removed: number } | null {
  const diff = readFileDiff(call.details)
  if (diff) return diff.added >= 0 && diff.removed >= 0 ? { added: diff.added, removed: diff.removed } : null
  const pi = readPiDiff(call.details)
  if (pi) return { added: pi.added, removed: pi.removed }
  const args = call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : null
  if (!args) return null
  const pairs = Array.isArray(args.edits) ? args.edits : [args]
  let added = 0
  let removed = 0
  let seen = false
  for (const raw of pairs) {
    if (!raw || typeof raw !== 'object') continue
    const edit = raw as Record<string, unknown>
    const before = stringField(edit, ['oldText', 'old_string', 'old_str'])
    const after = stringField(edit, ['newText', 'new_string', 'new_str'])
    if (before !== null && after !== null) {
      const delta = lineDelta(before, after)
      added += delta.added
      removed += delta.removed
      seen = true
    }
  }
  if (seen) return { added, removed }
  const content = stringField(args, ['content', 'contents', 'text'])
  return content === null ? null : { added: textLines(content).length, removed: 0 }
}

function baseOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function isCodeTool(call: Pick<UIToolCall, 'name'>): boolean {
  return /(^|__|\.)codemode$/i.test(call.name)
}

function addFileChange(target: Map<string, ProcessFileChange>, call: UIToolCall): void {
  const path = readFileDiff(call.details)?.path || callPath(call)
  const key = path ? normalizeToolPath(path) : call.id
  const lines = estimateCallLines(call)
  const row = target.get(key) ?? { path: path || call.name, base: path ? baseOf(path) : call.name, added: 0, removed: 0 }
  row.added = row.added === null || !lines ? null : row.added + lines.added
  row.removed = row.removed === null || !lines ? null : row.removed + lines.removed
  target.set(key, row)
}

export function processSummary(process: readonly TurnSegment[]): ProcessSummary {
  let thinking = 0
  const calls: UIToolCall[] = []
  for (const segment of mergeQuietSegments(process)) {
    thinking += segmentThinking(segment).length
    calls.push(...segment.tools)
  }
  const counted = countedWorkCalls(calls)
  let tools = 0
  let commands = 0
  let code = 0
  let searches = 0
  let lists = 0
  let web = 0
  let fetches = 0
  let agents = 0
  let other = 0
  let questions = 0
  const reads = new Set<string>()
  const edits = new Map<string, ProcessFileChange>()
  const creates = new Map<string, ProcessFileChange>()
  for (const call of counted) {
    if (isHistoryQuestionCall(call)) {
      if (call.status === 'running' || call.status === 'pending') questions += 1
      continue
    }
    const category = toolCategory(call)
    if (category !== 'command') tools += 1
    const step = searchStepOf(call)
    if (step) {
      if (step.command.action === 'fetch') fetches += 1
      else web += 1
    } else if (category === 'web') web += 1
    else if (category === 'fetch') fetches += 1
    else if (category === 'search') searches += 1
    else if (category === 'list') lists += 1
    else if (category === 'agent') agents += subagentStartCount(call)
    else if (category === 'command') {
      if (isCodeTool(call)) code += 1
      else commands += 1
    } else if (category === 'read') {
      const path = callPath(call)
      reads.add(path ? normalizeToolPath(path) : call.id)
    } else if (category === 'edit' || category === 'delete' || category === 'create') {
      if (call.status === 'error') continue
      const key = normalizeToolPath(readFileDiff(call.details)?.path || callPath(call))
      const created = creates.has(key) || (category === 'create' && !edits.has(key))
      addFileChange(created ? creates : edits, call)
    } else {
      other += 1
    }
  }
  return {
    thinking,
    actions: counted.length,
    tools,
    failed: summarizeToolRun(counted).failed,
    commands,
    code,
    reads: reads.size,
    edits: [...edits.values()],
    creates: [...creates.values()],
    searches,
    lists,
    web,
    fetches,
    agents,
    questions,
    other
  }
}

export function processFailuresAlert(turn: Pick<AssistantTurn, 'terminalReason' | 'error' | 'errorRecovered'>, streaming: boolean): boolean {
  if (streaming) return true
  if (turn.terminalReason === 'failed' || turn.terminalReason === 'stopped' || turn.terminalReason === 'interrupted') return true
  return !!turn.error && !turn.errorRecovered
}

export function stageSegmentCount(segments: readonly TurnSegment[]): number {
  let count = 0
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    count += 1
    if (segments[i].tools.length || segments[i].commentary.length) break
  }
  return Math.max(1, count)
}

export function pickLiveSegments(segments: readonly TurnSegment[], limit = LIVE_SEGMENTS, keep?: (segment: TurnSegment) => boolean): { shown: TurnSegment[]; hidden: number } {
  const recentFrom = segments.length - limit
  const shown: TurnSegment[] = []
  const dropped: TurnSegment[] = []
  segments.forEach((segment, index) => {
    const pinned = segment.tools.some((call) => isWebTool(call) || call.status === 'running' || call.status === 'pending' || (call.status === 'error' && !call.cancelled))
    if (index >= recentFrom || pinned || keep?.(segment)) shown.push(segment)
    else dropped.push(segment)
  })
  const tools = dropped.reduce((sum, segment) => sum + segment.tools.length, 0)
  return { shown, hidden: tools || dropped.length }
}

type RunMessage = Pick<UIMessage, 'id' | 'role' | 'text' | 'timestamp' | 'toolCalls' | 'generationTiming' | 'turnTiming'>

function previousUserIndex(messages: readonly Pick<UIMessage, 'role'>[], index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) if (messages[i].role === 'user') return i
  return -1
}

function activityEnd(messages: readonly RunMessage[], from: number, to: number): number {
  let end = 0
  for (let i = Math.max(0, from); i < to; i += 1) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (message.timestamp) end = Math.max(end, message.timestamp + (message.generationTiming?.durationMs ?? 0))
    if (message.turnTiming) end = Math.max(end, message.turnTiming.endedAt)
    for (const call of message.toolCalls ?? []) if (call.endedAt) end = Math.max(end, call.endedAt)
  }
  return end
}

function joinedRunAt(messages: readonly RunMessage[], userIndex: number): number | null {
  const user = messages[userIndex]
  if (!user || user.role !== 'user' || !user.timestamp || isSubagentNotice(user.text ?? '')) return null
  const before = previousUserIndex(messages, userIndex)
  let lastAssistant = -1
  for (let i = userIndex - 1; i > before; i -= 1) {
    if (messages[i].role !== 'assistant') continue
    lastAssistant = i
    break
  }
  if (lastAssistant < 0 || messages[lastAssistant].turnTiming) return null
  const end = activityEnd(messages, before + 1, userIndex)
  return user.timestamp < end ? end : null
}

export interface TurnRunPlace {
  continues: boolean
  startedAt: number | null
  runFirstId: string | null
}

const OWN_RUN: TurnRunPlace = { continues: false, startedAt: null, runFirstId: null }
const runPlaces = new WeakMap<readonly RunMessage[], WeakMap<readonly string[], TurnRunPlace>>()

export function turnRunPlace(messages: readonly RunMessage[], sourceIds: readonly string[]): TurnRunPlace {
  if (!sourceIds.length) return OWN_RUN
  let bySource = runPlaces.get(messages)
  const cached = bySource?.get(sourceIds)
  if (cached) return cached
  const place = computeTurnRunPlace(messages, sourceIds)
  if (!bySource) {
    bySource = new WeakMap<readonly string[], TurnRunPlace>()
    runPlaces.set(messages, bySource)
  }
  bySource.set(sourceIds, place)
  return place
}

function computeTurnRunPlace(messages: readonly RunMessage[], sourceIds: readonly string[]): TurnRunPlace {
  const first = messageIndex(messages).pos.get(sourceIds[0]) ?? -1
  if (first < 0) return OWN_RUN
  const lastId = sourceIds[sourceIds.length - 1]
  const last = messageIndex(messages).pos.get(lastId) ?? messages.length - 1
  let continues = false
  for (let i = last + 1; i < messages.length; i += 1) {
    if (messages[i].role !== 'user') continue
    continues = joinedRunAt(messages, i) !== null
    break
  }
  const userIndex = previousUserIndex(messages, first)
  const startedAt = userIndex >= 0 ? joinedRunAt(messages, userIndex) : null
  let runFirstId: string | null = null
  for (let user = userIndex; user >= 0 && joinedRunAt(messages, user) !== null;) {
    const before = previousUserIndex(messages, user)
    for (let i = before + 1; i < user; i += 1) {
      if (messages[i].role !== 'assistant') continue
      runFirstId = messages[i].id
      break
    }
    user = before
  }
  return continues || startedAt !== null || runFirstId !== null ? { continues, startedAt, runFirstId } : OWN_RUN
}

export function runMessagesFrom(messages: readonly UIMessage[], runFirstId: string | null, sourceIds: readonly string[]): UIMessage[] | null {
  if (!runFirstId) return null
  const index = messageIndex(messages)
  const from = index.pos.get(runFirstId) ?? -1
  const lastId = sourceIds[sourceIds.length - 1]
  const to = lastId ? index.pos.get(lastId) : undefined
  if (from < 0 || to === undefined) return null
  const run: UIMessage[] = []
  for (let i = from; i <= to; i += 1) {
    if (messages[i].role === 'assistant') run.push(messages[i])
  }
  return run
}

export function segmentSpanMs(messages: readonly RunMessage[], sourceIds: readonly string[], startedAt: number): number | undefined {
  const index = messageIndex(messages)
  const positions = sourceIds
    .map((id) => index.pos.get(id))
    .filter((pos): pos is number => pos !== undefined)
    .sort((a, b) => a - b)
  const own = positions.map((pos) => messages[pos])
  const end = activityEnd(own, 0, own.length)
  return end > startedAt ? end - startedAt : undefined
}

export function turnSpanMs(messages: readonly RunMessage[], sourceIds: readonly string[], tools: readonly Pick<UIToolCall, 'endedAt'>[]): number | undefined {
  const index = messageIndex(messages)
  const first = sourceIds.length ? index.pos.get(sourceIds[0]) ?? -1 : -1
  if (first < 0) return undefined
  const userIndex = previousUserIndex(messages, first)
  const start = userIndex >= 0 ? joinedRunAt(messages, userIndex) ?? messages[userIndex].timestamp : undefined
  if (!start) return undefined
  let end = 0
  for (const id of sourceIds) {
    const pos = index.pos.get(id)
    if (pos === undefined) continue
    const stamp = messages[pos].timestamp
    if (stamp) end = Math.max(end, stamp)
  }
  for (const call of tools) if (call.endedAt) end = Math.max(end, call.endedAt)
  return end > start ? end - start : undefined
}

export function turnChangeSet(turn: AssistantTurn, cwd?: string): TurnChanges | null {
  const collected = collectTurnChanges(turn.tools, cwd)
  if (collected || !turn.segments.length || turn.tools.some((tool) => tool.status === 'running')) return collected
  const summary = processSummary(turn.segments)
  const rows = (list: readonly ProcessFileChange[], status: TurnFileStatus): TurnFileChange[] => list
    .filter((file) => file.path !== file.base || /\.[^.]+$/.test(file.base))
    .filter((file) => isInsideCwd(file.path, cwd))
    .map((file) => ({ path: file.path, status, added: file.added ?? -1, removed: file.removed ?? -1 }))
  const files = [...rows(summary.creates, 'created'), ...rows(summary.edits, 'modified')]
  if (!files.length) return null
  const counts: Record<TurnFileStatus, number> = { created: 0, modified: 0, deleted: 0 }
  for (const file of files) counts[file.status] += 1
  const known = files.every((file) => file.added >= 0 && file.removed >= 0)
  return {
    files,
    counts,
    added: known ? files.reduce((sum, file) => sum + file.added, 0) : -1,
    removed: known ? files.reduce((sum, file) => sum + file.removed, 0) : -1
  }
}
