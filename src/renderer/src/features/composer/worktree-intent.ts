import { create } from 'zustand'
import { ANTIGRAVITY_PROVIDER } from '../../../../shared/antigravity'
import type { ExpectedRuntimeOwner, SessionState } from '../../../../shared/ipc'
import { pick } from '../../../../shared/ui-lang'
import type { HostT } from '../../lib/host-actions'
import { composerDraftForView, composerDraftKey, composerSubmitIdentity, type ComposerSubmitIdentity } from '../../state/composer-recovery'
import { expectedRuntimeFor } from '../../state/slices/runtime'
import { useStore } from '../../state/store'
import { loadDraft, restoreDraft, saveDraft } from './draft-store'

const useIntent = create<{ runId: string | null }>(() => ({ runId: null }))
type WorktreeView = { runId?: string; sessionId?: string }
type InheritedSelection = { modelId: string; mode?: string; effort?: string }
type CapabilityResult = { ok: boolean; error?: string }
const pendingSelections = new Map<string, { view: WorktreeView; selection: InheritedSelection }>()

export function useWorktreeIntended(runId: string | undefined): boolean {
  return useIntent((s) => !!runId && s.runId === runId)
}

export function setWorktreeIntent(runId: string | null): void {
  useIntent.setState({ runId })
}

export async function inheritAntigravitySelection(selection: InheritedSelection, ports: {
  current: () => boolean
  snapshot: () => SessionState | null
  select: (modelId: string) => Promise<CapabilityResult>
  setMode: (mode: string) => Promise<CapabilityResult>
  setThinking: (effort: string) => Promise<CapabilityResult>
}): Promise<CapabilityResult> {
  const matchesModel = (state: SessionState | null) => state?.model?.provider === ANTIGRAVITY_PROVIDER && state.model.id === selection.modelId
  if (!ports.current()) return { ok: false }
  if (!matchesModel(ports.snapshot())) {
    const result = await ports.select(selection.modelId)
    if (!result.ok || !ports.current()) return { ok: false, error: result.error }
  }
  if (selection.mode && ports.snapshot()?.antigravity?.mode !== selection.mode) {
    const result = await ports.setMode(selection.mode)
    if (!result.ok || !ports.current()) return { ok: false, error: result.error }
  }
  if (selection.effort && ports.snapshot()?.antigravity?.thinking?.current !== selection.effort) {
    const result = await ports.setThinking(selection.effort)
    if (!result.ok || !ports.current()) return { ok: false, error: result.error }
  }
  const final = ports.snapshot()
  return { ok: ports.current() && matchesModel(final) &&
    (!selection.mode || final?.antigravity?.mode === selection.mode) &&
    (!selection.effort || final?.antigravity?.thinking?.current === selection.effort) }
}

export type WorktreeOutcome =
  | { kind: 'none' }
  | { kind: 'failed' }
  | { kind: 'created'; identity: ComposerSubmitIdentity; expected: ExpectedRuntimeOwner; shown: () => boolean; origin: ComposerSubmitIdentity; originRunId: string | null }

const NONE: WorktreeOutcome = { kind: 'none' }
const FAILED: WorktreeOutcome = { kind: 'failed' }

async function ownerOf(runId: string, generation?: number): Promise<ExpectedRuntimeOwner | null> {
  await useStore.getState().syncRunners()
  const owner = expectedRuntimeFor(useStore.getState(), { draftKey: '', runId })
  if (!owner || owner.runId !== runId || owner.generation === undefined) return null
  return generation === undefined || owner.generation === generation ? owner : null
}

function runtimeSession(runId: string): SessionState | null {
  const s = useStore.getState()
  if (!s.peekedPath && !s.peekedSessionId && s.activeRunnerId === runId && s.session) return s.session
  return Object.values(s.sessionRuntimes).find((entry) => entry.runtime.runId === runId)?.session ?? null
}

function runtimeAlive(owner: ExpectedRuntimeOwner): boolean {
  return useStore.getState().runners.some((item) => (item.runId ?? item.id) === owner.runId && (item.generation === undefined || item.generation === owner.generation))
}

async function applySelection(owner: ExpectedRuntimeOwner, selection: InheritedSelection, shown: () => boolean): Promise<boolean> {
  const report = (error?: string) => {
    useStore.getState().notify('error', [shown()
      ? pick(
          '工作树已创建，但未能继承 Antigravity 设置。草稿已保留，再次发送会重试继承。',
          'Worktree created, but Antigravity settings could not be inherited. Your draft was kept; sending again retries setup.'
        )
      : pick(
          '工作树会话没能完成 Antigravity 设置，消息没有发出，草稿留在原会话。',
          'The worktree session could not finish Antigravity setup. The message was not sent; your draft stays in the original session.'
        ), error].filter(Boolean).join(' '))
    return false
  }
  const call = (action: (expected: ExpectedRuntimeOwner) => Promise<CapabilityResult>) => action({ runId: owner.runId, generation: owner.generation })
  try {
    const result = await inheritAntigravitySelection(selection, {
      current: () => runtimeAlive(owner),
      snapshot: () => runtimeSession(owner.runId),
      select: (id) => call((expected) => window.yan.setModel(ANTIGRAVITY_PROVIDER, id, expected)),
      setMode: (mode) => call((expected) => window.yan.antigravity.setMode(mode, expected)),
      setThinking: (effort) => call((expected) => window.yan.setThinking(effort, expected))
    })
    return result.ok || report(result.error)
  } catch {
    return report()
  }
}

export async function materializeWorktreeIntent(t: HostT): Promise<WorktreeOutcome> {
  const before = useStore.getState()
  const active = before.activeRunnerId
  const pending = active && pendingSelections.get(active)
  if (active && pending && isCreatedWorktreeView(pending.view)) {
    const owner = await ownerOf(active)
    if (!owner || !(await applySelection(owner, pending.selection, () => isCreatedWorktreeView(pending.view)))) return FAILED
    pendingSelections.delete(active)
    return NONE
  }
  const wanted = useIntent.getState().runId
  if (!wanted || active !== wanted || before.peekedPath || before.peekedSessionId) return NONE
  const runner = before.runners.find((item) => (item.runId ?? item.id) === active)
  if (!runner) return NONE
  setWorktreeIntent(null)
  const fresh = before.messages.length === 0 && !before.session?.messageCount && !before.session?.isStreaming && !before.session?.isAgentRunning
  if (!fresh || runner.isolationBranch) return NONE
  const origin = composerSubmitIdentity(before)
  const key = origin.draftKey
  const draft = restoreDraft(before.sessionRuntimes[key], loadDraft(key)).text
  const attachments = before.attachments
  const model = before.session?.model
  const giveUp = (): WorktreeOutcome => {
    if (!useIntent.getState().runId) setWorktreeIntent(active)
    return FAILED
  }
  const created = await before.newSession({ cwd: runner.cwd, projectId: runner.projectId, scope: runner.projectId ? 'project' : 'global', worktree: true })
  if (!created.ok || !created.runId) return giveUp()
  const runId = created.runId
  const shown = () => isCreatedWorktreeView(created)
  const first = await ownerOf(runId)
  if (!first) return giveUp()
  let nextKey = ''
  if (model?.provider === ANTIGRAVITY_PROVIDER) {
    const selection = { modelId: model.id, mode: before.session?.antigravity?.mode, effort: before.session?.antigravity?.thinking?.current }
    const live = new Set(useStore.getState().runners.map((item) => item.runId ?? item.id))
    for (const id of pendingSelections.keys()) if (!live.has(id) && id !== useStore.getState().activeRunnerId) pendingSelections.delete(id)
    pendingSelections.set(runId, { view: created, selection })
    if (shown()) {
      nextKey = composerDraftKey(useStore.getState())
      if (nextKey && nextKey !== key) {
        saveDraft(nextKey, { text: draft, attachments })
        useStore.getState().setSessionDraft(draft, nextKey)
      }
      if (attachments.length) useStore.setState({ attachments })
    }
    if (!(await applySelection(first, selection, shown))) {
      if (shown()) {
        const current = useStore.getState()
        const currentKey = composerDraftKey(current)
        const edited = composerDraftForView(current, currentKey).text
        if (draft && (!edited || edited === draft)) useStore.setState({ editorInject: { text: draft, mode: 'replace' } })
        if (attachments.length && !current.attachments.length) useStore.setState({ attachments })
        return FAILED
      }
      pendingSelections.delete(runId)
      if (nextKey && nextKey !== key) {
        saveDraft(nextKey, { text: '', attachments: [] })
        useStore.getState().setSessionDraft('', nextKey)
      }
      return giveUp()
    }
    pendingSelections.delete(runId)
  }
  const expected = await ownerOf(runId, first.generation)
  if (!expected) return giveUp()
  saveDraft(key, { text: '', attachments: [] })
  if (key) useStore.getState().setSessionDraft('', key)
  if (shown()) {
    if (attachments.length && model?.provider !== ANTIGRAVITY_PROVIDER) useStore.setState({ attachments })
  } else if (nextKey && nextKey !== key) {
    saveDraft(nextKey, { text: '', attachments: [] })
    useStore.getState().setSessionDraft('', nextKey)
  }
  void announce(t, runId)
  const draftKey = expected.sessionId || `run:${runId}`
  return {
    kind: 'created',
    identity: { draftKey, sessionId: expected.sessionId, runId, generation: expected.generation },
    expected,
    shown,
    origin,
    originRunId: active
  }
}

export function isCreatedWorktreeView(created: { runId?: string; sessionId?: string }): boolean {
  const s = useStore.getState()
  return !s.peekedPath && !s.peekedSessionId && !!created.runId && s.activeRunnerId === created.runId &&
    (!s.session?.sessionId || !created.sessionId || s.session.sessionId === created.sessionId)
}

async function announce(t: HostT, runId: string | undefined): Promise<void> {
  let branch = ''
  for (let attempt = 0; attempt < 20 && !branch; attempt++) {
    await useStore.getState().syncRunners()
    const state = useStore.getState()
    const target = runId ?? state.activeRunnerId
    branch = state.runners.find((item) => (item.runId ?? item.id) === target)?.isolationBranch ?? ''
    if (!branch) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  useStore.getState().notify('info', t('composer.worktree.created', { branch }).trim())
}
