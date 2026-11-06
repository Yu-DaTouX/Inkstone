import { useEffect, useMemo, useState } from 'react'
import { useRunsV3 } from '../../../state/runs-v3'
import { useStore } from '../../../state/store'
import { sessionActivityAt } from '../../../features/sidebar/sidebar-model'
import type { RunSnapshot } from '../../../../../shared/runs'
import type { SessionSummary, SubagentRun } from '../../../../../shared/ipc'
import { scopedKeyOf, type SidebarThreadView, type ThreadRef } from './types'
import { buildSidebarSections, type SidebarSections } from './sections'

let clockMounts = 0
let clockNow = 0

export function sidebarClockNow(): number {
  return clockMounts > 0 && clockNow > 0 ? clockNow : Date.now()
}

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => {
    clockNow = Date.now()
    return clockNow
  })
  useEffect(() => {
    clockMounts += 1
    const id = window.setInterval(() => {
      clockNow = Date.now()
      setNow(clockNow)
    }, 60_000)
    return () => {
      window.clearInterval(id)
      clockMounts -= 1
    }
  }, [])
  return now
}

const runSignatures = new WeakMap<RunSnapshot, string>()

function sidebarRunSignature(run: RunSnapshot): string {
  const cached = runSignatures.get(run)
  if (cached !== undefined) return cached
  const phase = run.phase
  const parts: unknown[] = [run.runId, run.sessionId, run.sessionPath ?? '', run.startedAt, phase.kind, run.model?.provider ?? '', run.model?.id ?? '', run.model?.label ?? '']
  if (phase.kind === 'needs-you') parts.push(phase.request.type)
  if (phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'stopped') parts.push(phase.at)
  if (phase.kind === 'done' || phase.kind === 'failed') parts.push(phase.seen)
  if (phase.kind === 'failed') parts.push(phase.errorKind ?? '', phase.message)
  const signature = JSON.stringify(parts)
  runSignatures.set(run, signature)
  return signature
}

let sidebarRunsSignature = ''
let sidebarRunsValue: readonly RunSnapshot[] = []

export function selectSidebarRuns(runs: readonly RunSnapshot[]): readonly RunSnapshot[] {
  if (runs === sidebarRunsValue) return runs
  const signature = runs.map(sidebarRunSignature).join('\n')
  if (signature !== sidebarRunsSignature) {
    sidebarRunsSignature = signature
    sidebarRunsValue = runs
  }
  return sidebarRunsValue
}

export function useSidebarRuns(): readonly RunSnapshot[] {
  return useRunsV3((s) => selectSidebarRuns(s.runs))
}

function liveSubagentSignature(runs: readonly SubagentRun[]): string {
  const since = new Map<string, number>()
  for (const run of runs) {
    if (!run.parentSessionId || (run.status !== 'starting' && run.status !== 'running')) continue
    const previous = since.get(run.parentSessionId)
    if (previous === undefined || run.startedAt < previous) since.set(run.parentSessionId, run.startedAt)
  }
  return [...since].sort(([a], [b]) => a.localeCompare(b)).map(([id, at]) => `${id}\t${at}`).join('\n')
}

function subagentsSinceOf(signature: string): ReadonlyMap<string, number> {
  const since = new Map<string, number>()
  for (const line of signature ? signature.split('\n') : []) {
    const [id, at] = line.split('\t')
    since.set(id, Number(at))
  }
  return since
}

function firstUserLine(messages: ReadonlyArray<{ role: string; text?: string }>): string {
  const text = messages.find((message) => message.role === 'user' && message.text?.trim())?.text ?? ''
  return text.trim().split('\n')[0].slice(0, 80)
}

const unlistedMemory = new Map<string, { name: string; cwd: string }>()

export function withUnlistedRuns(sessions: readonly SessionSummary[], runs: readonly RunSnapshot[], current?: { sessionId: string; name: string; cwd?: string }): readonly SessionSummary[] {
  const ids = new Set(sessions.map((session) => session.id))
  const paths = new Set(sessions.map((session) => session.path))
  for (const id of ids) unlistedMemory.delete(id)
  const pending: SessionSummary[] = []
  for (const run of runs) {
    const live = run.phase.kind === 'running' || run.phase.kind === 'needs-you' || run.phase.kind === 'stalled' || run.phase.kind === 'queued'
    if (run.kind !== 'session' || !run.sessionPath || !live || ids.has(run.sessionId) || paths.has(run.sessionPath)) continue
    ids.add(run.sessionId)
    paths.add(run.sessionPath)
    if (current?.sessionId === run.sessionId) unlistedMemory.set(run.sessionId, { name: current.name, cwd: current.cwd ?? '' })
    const known = unlistedMemory.get(run.sessionId)
    pending.push({
      id: run.sessionId,
      path: run.sessionPath,
      cwd: known?.cwd ?? '',
      title: run.title || known?.name || '',
      named: false,
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
      lastActivityAt: run.startedAt,
      messageCount: 0,
      ...(run.projectId ? { projectId: run.projectId } : {})
    })
  }
  return pending.length === 0 ? sessions : [...sessions, ...pending]
}

export function useSidebarSections(): SidebarSections {
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const runs = useSidebarRuns()
  const currentId = useStore((s) => s.session?.sessionId)
  const currentName = useStore((s) => s.session?.sessionName || firstUserLine(s.messages))
  const currentCwd = useStore((s) => s.session?.cwd)
  const subagentSignature = useStore((s) => liveSubagentSignature(s.subagents))
  const now = useMinuteClock()
  return useMemo(
    () =>
      buildSidebarSections({
        sessions: withUnlistedRuns(sessions, runs, currentId && currentName ? { sessionId: currentId, name: currentName, cwd: currentCwd } : undefined),
        runs,
        projects: projects ?? [],
        projectNames: projectNames ?? {},
        titles,
        manualTitles,
        now,
        subagentsSince: subagentsSinceOf(subagentSignature)
      }),
    [sessions, runs, currentId, currentName, currentCwd, projects, projectNames, titles, manualTitles, now, subagentSignature]
  )
}

export function useThreadView(ref: ThreadRef): SidebarThreadView | null {
  const session = useStore((s) => s.sessions.find((item) => item.id === ref.threadId) ?? null)
  const title = useStore((s) => (session ? (s.manualTitles[session.id] ?? s.titles[session.id] ?? session.title) : ''))
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const now = useMinuteClock()
  return useMemo(() => {
    if (!session) return null
    const sections = buildSidebarSections({
      sessions: [session],
      runs: useRunsV3.getState().runs,
      projects: projects ?? [],
      projectNames: projectNames ?? {},
      titles: {},
      manualTitles: {},
      now
    })
    const view = [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled][0]
    return view ? { ...view, title } : null
  }, [session, projects, projectNames, now, title])
}

export function useActiveThreadKey(): string | null {
  const sessionId = useStore((s) => s.session?.sessionId)
  return sessionId ? scopedKeyOf(sessionId) : null
}

export function useThreadsActivitySignature(): string {
  const sessions = useStore((s) => s.sessions)
  return useMemo(
    () => sessions.map((session) => `${session.id}:${sessionActivityAt(session)}:${session.archivedAt ?? ''}:${session.pinned ? 1 : 0}:${session.snoozedUntil ?? ''}`).join('|'),
    [sessions]
  )
}
