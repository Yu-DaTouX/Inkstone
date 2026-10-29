import type { UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, toolCallForest, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { mcpTarget } from '../../../../shared/mcp-approval'
import { searchStepOf } from './web-search/model'
import { callPath, collectTurnChanges, isInsideCwd, readFileDiff, readPiDiff } from './turn-changes'
import type { SessionTextKey } from './text'
import { isDeniedCall } from './tool-title'

const TOOL_GROUP_MIN = 2
export const RUN_LABEL_HOLD_MS = 650

export function liveToolGlowId(tools: readonly UIToolCall[]): string | null {
  const active = tools.filter((call) => call.status === 'running' || call.status === 'pending')
  for (let i = active.length - 1; i >= 0; i--) {
    if (!active.some((call) => call.parentToolCallId === active[i].id)) return active[i].id
  }
  return active.at(-1)?.id ?? null
}

type ToolCategory =
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'search'
  | 'list'
  | 'fetch'
  | 'web'
  | 'command'
  | 'agent'
  | 'todo'
  | 'other'

type FileCategory = 'read' | 'edit' | 'create' | 'delete'

export type ToolRunState = 'blocked' | 'running' | 'denied' | 'error' | 'cancelled' | 'ok'

export type ToolRunSegment =
  | { kind: 'category'; category: ToolCategory; name?: string; count: number; failed: number }
  | { kind: 'file'; path: string; base: string; verbs: FileCategory[]; reads: number; failed: number }

export interface ToolRunSummary {
  state: ToolRunState
  segments: ToolRunSegment[]
  added: number | null
  removed: number | null
  changedFiles: number
  failed: number
  needsApproval: boolean
  running: UIToolCall | null
  path: string | null
}

export type ToolRow =
  | { kind: 'single'; id: string; node: ToolCallNode; standalone: boolean; blocked: boolean }
  | { kind: 'group'; id: string; firstId: string; nodes: ToolCallNode[]; summary: ToolRunSummary }

interface CoalescedNode {
  node: ToolCallNode
  repeat: number
  ids: string[]
}

const READ = new Set(['read', 'view', 'cat', 'open', 'read_file'])
const SEARCH = new Set(['grep', 'glob', 'find', 'search', 'rg', 'ripgrep', 'search_files'])
const LIST = new Set(['ls', 'list', 'list_dir', 'list_directory', 'list_files'])
const FETCH = new Set(['fetch', 'web_fetch', 'webfetch', 'browse'])
const WEB = new Set(['web_search', 'websearch'])
const COMMAND = new Set(['bash', 'powershell', 'pwsh', 'shell', 'sh', 'cmd', 'run', 'exec', 'codemode'])
const EDIT = new Set(['edit', 'multi_edit', 'multiedit', 'apply_patch', 'patch', 'str_replace', 'notebook_edit'])
const WRITE = new Set(['write', 'create_file'])
const DELETE = new Set(['delete_file'])
const TODO = new Set(['todo', 'todos', 'todo_write', 'update_todos'])
const STANDALONE = new Set(['question', 'ask', 'ask_user', 'ask_question', 'ask_user_question'])

const SUBAGENT_COMMAND = /(^|[\s;&|(])yan(\.cmd|\.exe)?\s+subagent\s+start\b/
const WEB_COMMAND = /(^|[\s;&|(])yan(\.cmd|\.exe)?\s+(search|fetch|web)\b/

const EMPTY_IDS: ReadonlySet<string> = new Set()

function bareName(name: string): string {
  const tail = name.split(/__|[./:]/).filter(Boolean).pop() ?? name
  return tail.toLowerCase().replace(/-/g, '_')
}

function commandOf(call: Pick<UIToolCall, 'args'>): string {
  const a = call.args
  if (!a || typeof a !== 'object') return ''
  const { command, cmd, script, code } = a as Record<string, unknown>
  const text = command ?? cmd ?? script ?? code
  return typeof text === 'string' ? text : ''
}

export function isStandaloneTool(call: Pick<UIToolCall, 'name'>): boolean {
  return !call.name.startsWith('mcp__') && STANDALONE.has(bareName(call.name))
}

export function toolCategory(call: Pick<UIToolCall, 'name' | 'args' | 'details'>): ToolCategory {
  if (call.name.startsWith('mcp__')) return 'other'
  const bare = bareName(call.name)
  if (READ.has(bare)) return 'read'
  if (SEARCH.has(bare)) return 'search'
  if (LIST.has(bare)) return 'list'
  if (FETCH.has(bare)) return 'fetch'
  if (WEB.has(bare)) return 'web'
  if (TODO.has(bare)) return 'todo'
  if (COMMAND.has(bare)) {
    const command = commandOf(call)
    if (SUBAGENT_COMMAND.test(command)) return 'agent'
    if (WEB_COMMAND.test(command)) return 'web'
    return 'command'
  }
  if (EDIT.has(bare) || WRITE.has(bare) || DELETE.has(bare)) {
    const diff = readFileDiff(call.details)
    if (diff?.status === 'created') return 'create'
    if (WRITE.has(bare)) return diff?.status === 'modified' ? 'edit' : 'create'
    if (diff?.status === 'deleted' || DELETE.has(bare)) return 'delete'
    return 'edit'
  }
  return 'other'
}

function isFileCategory(category: ToolCategory): category is FileCategory {
  return category === 'read' || category === 'edit' || category === 'create' || category === 'delete'
}

export function normalizeToolPath(path: string): string {
  const slashed = path.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return path.startsWith('/') ? slashed : slashed.toLowerCase()
}

function pathOf(call: UIToolCall): string {
  return readFileDiff(call.details)?.path || callPath(call)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function isLive(call: Pick<UIToolCall, 'status'>): boolean {
  return call.status === 'running' || call.status === 'pending'
}

function isFailure(call: Pick<UIToolCall, 'status' | 'cancelled' | 'denied' | 'output'>): boolean {
  return call.status === 'error' && !call.cancelled && !isDeniedCall(call)
}

function memberKey(call: UIToolCall, category: ToolCategory): string {
  const path = isFileCategory(category) ? pathOf(call) : ''
  return path ? `${category}:${normalizeToolPath(path)}` : `id:${call.id}`
}

function latestFailures(calls: readonly UIToolCall[]): Set<string> {
  const latest = new Map<string, UIToolCall>()
  for (const call of calls) latest.set(memberKey(call, toolCategory(call)), call)
  const failed = new Set<string>()
  for (const call of latest.values()) if (isFailure(call)) failed.add(call.id)
  return failed
}

export function approvalCallIds(
  approvals: readonly { sessionId?: string; subagentId?: string; tool?: string; toolCallId?: unknown }[],
  tools: readonly UIToolCall[],
  sessionId?: string | null
): ReadonlySet<string> {
  if (!approvals.length || !tools.length) return EMPTY_IDS
  const ids = new Set<string>()
  for (const approval of approvals) {
    if (approval.subagentId) continue
    if (sessionId && approval.sessionId && approval.sessionId !== sessionId) continue
    if (typeof approval.toolCallId === 'string' && approval.toolCallId) {
      ids.add(approval.toolCallId)
      continue
    }
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      const call = tools[i]
      if (isLive(call) && !ids.has(call.id) && (!approval.tool || bareName(approval.tool) === bareName(call.name))) {
        ids.add(call.id)
        break
      }
    }
  }
  return ids.size ? ids : EMPTY_IDS
}

function runState(calls: readonly UIToolCall[], approvalIds: ReadonlySet<string>): ToolRunState {
  if (calls.some((call) => isLive(call) && approvalIds.has(call.id))) return 'blocked'
  if (calls.some(isLive)) return 'running'
  const last = calls[calls.length - 1]
  if (!last) return 'ok'
  if (isFailure(last)) return 'error'
  if (isDeniedCall(last)) return 'denied'
  if (last.cancelled) return 'cancelled'
  return 'ok'
}

function sharedPath(calls: readonly UIToolCall[]): string | null {
  let shared: string | null = null
  let shown = ''
  for (const call of calls) {
    if (!isFileCategory(toolCategory(call))) return null
    const path = pathOf(call)
    if (!path) return null
    const key = normalizeToolPath(path)
    if (shared === null) {
      shared = key
      shown = path
    } else if (shared !== key) {
      return null
    }
  }
  return shared === null ? null : shown
}

function buildSegments(calls: readonly UIToolCall[], failedIds: ReadonlySet<string>, path: string | null): ToolRunSegment[] {
  if (path) {
    const verbs: FileCategory[] = []
    let reads = 0
    let failed = 0
    for (const call of calls) {
      const category = toolCategory(call) as FileCategory
      if (!verbs.includes(category)) verbs.push(category)
      if (category === 'read') reads += 1
      if (failedIds.has(call.id)) failed += 1
    }
    return [{ kind: 'file', path, base: baseName(path), verbs, reads, failed }]
  }

  const order: string[] = []
  const buckets = new Map<string, { category: ToolCategory; name?: string; keys: Set<string>; calls: number; failed: number }>()
  for (const call of calls) {
    const category = toolCategory(call)
    const bucketKey = category === 'other' ? `other:${call.name}` : category
    let bucket = buckets.get(bucketKey)
    if (!bucket) {
      bucket = { category, ...(category === 'other' ? { name: call.name } : null), keys: new Set(), calls: 0, failed: 0 }
      buckets.set(bucketKey, bucket)
      order.push(bucketKey)
    }
    bucket.keys.add(memberKey(call, category))
    bucket.calls += 1
    if (failedIds.has(call.id)) bucket.failed += 1
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!
    const count = isFileCategory(bucket.category) ? bucket.keys.size : bucket.calls
    return {
      kind: 'category' as const,
      category: bucket.category,
      ...(bucket.name ? { name: bucket.name } : null),
      count,
      failed: bucket.failed
    }
  })
}

function runChanges(calls: readonly UIToolCall[], cwd?: string): { added: number | null; removed: number | null; files: number } | null {
  const changes = collectTurnChanges(calls, cwd)
  const files = new Set((changes?.files ?? []).map((file) => normalizeToolPath(file.path)))
  let added = changes ? changes.added : 0
  let removed = changes ? changes.removed : 0
  let seen = !!changes
  for (const call of calls) {
    if (readFileDiff(call.details)) continue
    const category = toolCategory(call)
    if (category !== 'edit' && category !== 'create' && category !== 'delete') continue
    const pi = readPiDiff(call.details)
    if (!pi) continue
    const path = callPath(call)
    if (path && !isInsideCwd(path, cwd)) continue
    seen = true
    files.add(normalizeToolPath(path || call.id))
    if (added >= 0) added += pi.added
    if (removed >= 0) removed += pi.removed
  }
  if (!seen) return null
  return { added: added >= 0 ? added : null, removed: removed >= 0 ? removed : null, files: files.size }
}

export function summarizeToolRun(
  calls: readonly UIToolCall[],
  approvalIds: ReadonlySet<string> = EMPTY_IDS,
  cwd?: string
): ToolRunSummary {
  const failedIds = latestFailures(calls)
  const path = sharedPath(calls)
  const changes = runChanges(calls.filter((call) => call.status === 'ok' && !call.cancelled), cwd)
  let running: UIToolCall | null = null
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (isLive(calls[i])) {
      running = calls[i]
      break
    }
  }
  return {
    state: runState(calls, approvalIds),
    segments: buildSegments(calls, failedIds, path),
    added: changes ? changes.added : null,
    removed: changes ? changes.removed : null,
    changedFiles: changes?.files ?? 0,
    failed: failedIds.size,
    needsApproval: calls.some((call) => isLive(call) && approvalIds.has(call.id)),
    running,
    path
  }
}

function isStandaloneNode(node: ToolCallNode): boolean {
  return isStandaloneTool(node.call) || isWebTool(node.call) || !!node.call.approval
}

function isHiddenTodoCall(call: Pick<UIToolCall, 'name' | 'status' | 'cancelled' | 'denied' | 'output'>): boolean {
  return TODO.has(bareName(call.name)) && !isFailure(call)
}

export function countedProcessCalls(calls: readonly UIToolCall[]): UIToolCall[] {
  return calls.filter((call) => !call.parentToolCallId && !isHiddenTodoCall(call))
}

export function countedWorkCalls(calls: readonly UIToolCall[]): UIToolCall[] {
  const parents = new Set(calls.flatMap((call) => call.parentToolCallId ? [call.parentToolCallId] : []))
  return calls.filter((call) => {
    if (isHiddenTodoCall(call)) return false
    if (call.parentToolCallId || !parents.has(call.id)) return true
    return isLive(call) || isFailure(call)
  })
}

export interface ToolTallyPart {
  key: string
  category: ToolCategory
  name: string
  count: number
  failed: number
}

export function toolTally(calls: readonly UIToolCall[]): ToolTallyPart[] {
  const failedIds = latestFailures(calls)
  const parts = new Map<string, ToolTallyPart>()
  for (const call of calls) {
    const category = toolCategory(call)
    const key = category === 'other' ? `other:${call.name}` : category
    const part = parts.get(key) ?? { key, category, name: mcpDisplayName(call.name), count: 0, failed: 0 }
    part.count += 1
    if (failedIds.has(call.id)) part.failed += 1
    parts.set(key, part)
  }
  return [...parts.values()]
}

const TALLY_TEXT: Record<Exclude<ToolCategory, 'other'>, SessionTextKey> = {
  command: 'tallyCommand',
  read: 'tallyRead',
  edit: 'tallyEdit',
  create: 'tallyCreate',
  delete: 'tallyDelete',
  search: 'tallySearch',
  list: 'tallyList',
  fetch: 'tallyFetch',
  web: 'tallyWeb',
  agent: 'tallyAgent',
  todo: 'tallyTodo'
}

export function toolTallyText(part: ToolTallyPart, tt: RunTextFn): string {
  const label = part.category === 'other' ? part.name : tt(TALLY_TEXT[part.category])
  return `${label} ${tt('runRepeat', { n: part.count })}`
}

export function groupTally(nodes: readonly ToolCallNode[]): ToolTallyPart[] {
  return toolTally(countedRunCalls(nodes))
}

export function isWebTool(call: UIToolCall): boolean {
  const category = toolCategory(call)
  return !!searchStepOf(call) || category === 'web' || category === 'fetch'
}

function withVisibleWebNodes(nodes: ToolCallNode[]): ToolCallNode[] {
  return nodes.flatMap((root) => {
    const promoted: ToolCallNode[] = []
    const detach = (node: ToolCallNode): ToolCallNode => ({ ...node, children: node.children.flatMap((child) => {
      const kept = detach(child)
      if (isWebTool(child.call)) { promoted.push(kept); return [] }
      return [kept]
    }) })
    const node = detach(root)
    return [node, ...promoted]
  })
}

function countedRunCalls(nodes: readonly ToolCallNode[]): UIToolCall[] {
  return nodes.flatMap((node) => {
    if (!node.children.length) return [node.call]
    const own = isLive(node.call) || isFailure(node.call) ? [node.call] : []
    return [...own, ...flattenToolNodes(node.children).map((child) => child.call)]
  })
}

export function toolNodesEqual(a: readonly ToolCallNode[], b: readonly ToolCallNode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue
    if (a[i].call !== b[i].call || !toolNodesEqual(a[i].children, b[i].children)) return false
  }
  return true
}

export function buildToolRows(
  tools: readonly UIToolCall[],
  approvalIds: ReadonlySet<string> = EMPTY_IDS,
  options: { cwd?: string; min?: number; previous?: readonly ToolRow[] } = {}
): ToolRow[] {
  const min = Math.max(2, options.min ?? TOOL_GROUP_MIN)
  const previous = new Map<string, ToolRow>()
  for (const row of options.previous ?? []) previous.set(row.id, row)
  const rows: ToolRow[] = []
  let run: ToolCallNode[] = []
  const single = (node: ToolCallNode, standalone: boolean): ToolRow => {
    const blocked = isLive(node.call) && approvalIds.has(node.call.id)
    const before = previous.get(node.call.id)
    if (before && before.kind === 'single' && before.standalone === standalone && before.blocked === blocked && toolNodesEqual([before.node], [node])) return before
    return { kind: 'single', id: node.call.id, node, standalone, blocked }
  }
  const flush = (): void => {
    if (run.length >= min) {
      const first = run[0].call.id
      const id = `group:${first}`
      const counted = countedRunCalls(run)
      const before = previous.get(id)
      const needsApproval = counted.some((call) => isLive(call) && approvalIds.has(call.id))
      if (before && before.kind === 'group' && before.summary.needsApproval === needsApproval && toolNodesEqual(before.nodes, run)) {
        rows.push(before)
      } else {
        rows.push({
          kind: 'group',
          id,
          firstId: first,
          nodes: run,
          summary: summarizeToolRun(counted, approvalIds, options.cwd)
        })
      }
    } else {
      for (const node of run) rows.push(single(node, false))
    }
    run = []
  }
  for (const node of withVisibleWebNodes(toolCallForest(tools.filter((call) => !isHiddenTodoCall(call))))) {
    if (isStandaloneNode(node)) {
      flush()
      rows.push(single(node, true))
    } else {
      run.push(node)
    }
  }
  flush()
  return rows
}

export interface ToolRowsCache {
  tools: readonly UIToolCall[]
  approvalIds: ReadonlySet<string>
  rows: ToolRow[]
}

function sameCalls(a: readonly UIToolCall[], b: readonly UIToolCall[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

export function cachedToolRows(cache: ToolRowsCache | null, tools: readonly UIToolCall[], approvalIds: ReadonlySet<string>): ToolRowsCache {
  if (cache && sameCalls(cache.tools, tools) && sameIds(cache.approvalIds, approvalIds)) return cache
  return { tools, approvalIds, rows: buildToolRows(tools, approvalIds, { previous: cache?.rows }) }
}

function coalesceKey(node: ToolCallNode): string | null {
  const call = node.call
  if (node.children.length || isLive(call)) return null
  const category = toolCategory(call)
  if (!isFileCategory(category)) return null
  const path = pathOf(call)
  if (!path) return null
  const outcome = isFailure(call) ? 'error' : isDeniedCall(call) ? 'denied' : call.cancelled ? 'cancelled' : 'ok'
  return `${category}:${normalizeToolPath(path)}:${outcome}`
}

export function coalesceNodes(nodes: readonly ToolCallNode[]): CoalescedNode[] {
  const out: CoalescedNode[] = []
  let lastKey: string | null = null
  for (const node of nodes) {
    const key = coalesceKey(node)
    const previous = out[out.length - 1]
    if (key !== null && key === lastKey && previous) {
      previous.node = node
      previous.repeat += 1
      previous.ids.push(node.call.id)
    } else {
      out.push({ node, repeat: 1, ids: [node.call.id] })
    }
    lastKey = key
  }
  return out
}

type RunTextFn = (key: SessionTextKey, vars?: Record<string, string | number>) => string

const CATEGORY_TEXT: Record<Exclude<ToolCategory, 'other' | 'todo'>, [SessionTextKey, SessionTextKey]> = {
  read: ['runRead1', 'runRead'],
  edit: ['runEdit1', 'runEdit'],
  create: ['runCreate1', 'runCreate'],
  delete: ['runDelete1', 'runDelete'],
  search: ['runSearch1', 'runSearch'],
  list: ['runList1', 'runList'],
  fetch: ['runFetch1', 'runFetch'],
  web: ['runWeb1', 'runWeb'],
  command: ['runCommand1', 'runCommand'],
  agent: ['runAgent1', 'runAgent']
}

const FILE_VERB: Record<FileCategory, SessionTextKey> = {
  read: 'runFileRead',
  edit: 'runFileEdit',
  create: 'runFileCreate',
  delete: 'runFileDelete'
}

function joinVerbs(verbs: readonly string[], tt: RunTextFn): string {
  if (verbs.length <= 1) return verbs[0] ?? ''
  const head = verbs.slice(0, -1).join(tt('runSep'))
  return tt('runAnd', { a: head, b: verbs[verbs.length - 1] })
}

export function mcpDisplayName(name: string): string {
  return name.startsWith('mcp__') ? mcpTarget(name).tool || name : name
}

function toolRunSegmentText(segment: ToolRunSegment, tt: RunTextFn): string {
  if (segment.kind === 'file') {
    const verbs = joinVerbs(segment.verbs.map((verb) => tt(FILE_VERB[verb])), tt)
    const onlyReads = segment.verbs.length === 1 && segment.verbs[0] === 'read'
    return onlyReads && segment.reads > 1
      ? tt('runFileReads', { verbs, file: segment.base, n: segment.reads })
      : tt('runFile', { verbs, file: segment.base })
  }
  if (segment.category === 'todo') return tt('runTodo', { n: segment.count })
  if (segment.category === 'other') {
    const name = mcpDisplayName(segment.name ?? '')
    return segment.count === 1 ? tt('runOther1', { name }) : tt('runOther', { name, n: segment.count })
  }
  const [one, many] = CATEGORY_TEXT[segment.category]
  return segment.count === 1 ? tt(one, { n: 1 }) : tt(many, { n: segment.count })
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

interface ToolRunPart {
  text: string
  failed: boolean
}

export function toolRunParts(summary: Pick<ToolRunSummary, 'segments'>, tt: RunTextFn): ToolRunPart[] {
  const parts: ToolRunPart[] = summary.segments.map((segment, index) => ({
    text: (index ? tt('runJoin') : '') + toolRunSegmentText(segment, tt),
    failed: segment.failed > 0
  }))
  if (parts.length) parts[0] = { ...parts[0], text: capitalize(parts[0].text) }
  return parts
}

export function formatToolRun(summary: Pick<ToolRunSummary, 'segments'>, tt: RunTextFn): string {
  const parts = summary.segments.map((segment, index) => {
    const text = toolRunSegmentText(segment, tt)
    return (index ? tt('runJoin') : '') + (segment.failed > 0 ? text + tt('runFailed', { n: segment.failed }) : text)
  })
  return parts.length ? capitalize(parts[0]) + parts.slice(1).join('') : ''
}

export interface HeldRunLabel {
  key: string | null
  label: string
  since: number
}

export function holdRunLabel(
  previous: HeldRunLabel | null,
  next: { key: string | null; label: string },
  now: number,
  holdMs = RUN_LABEL_HOLD_MS
): { held: HeldRunLabel; wakeAt: number | null } {
  if (!previous) return { held: { ...next, since: now }, wakeAt: null }
  if (previous.key === next.key) return { held: { ...previous, label: next.label }, wakeAt: null }
  if (previous.key === null) return { held: { ...next, since: now }, wakeAt: null }
  const until = previous.since + holdMs
  if (now >= until) return { held: { ...next, since: now }, wakeAt: null }
  return { held: previous, wakeAt: until }
}
