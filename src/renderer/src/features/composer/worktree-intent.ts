import { create } from 'zustand'
import { ANTIGRAVITY_PROVIDER } from '../../../../shared/antigravity'
import type { ExpectedRuntimeOwner, SessionState } from '../../../../shared/ipc'
import { pick } from '../../../../shared/ui-lang'
import type { HostT } from '../../lib/host-actions'
import { composerDraftForView, composerDraftKey } from '../../state/composer-recovery'
import { nav, sessionActionTarget } from '../../state/slices/runtime'
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

async function applySelection(view: WorktreeView, selection: InheritedSelection, gate: number): Promise<boolean> {
  const visible = () => gate === nav.gate && isCreatedWorktreeView(view)
  const report = (error?: string) => {
    if (visible()) useStore.getState().notify('error', [pick(
      '工作树已创建，但未能继承 Antigravity 设置。草稿已保留，再次发送会重试继承。',
      'Worktree created, but Antigravity settings could not be inherited. Your draft was kept; sending again retries setup.'
    ), error].filter(Boolean).join(' '))
    return false
  }
  try {
    const target = await sessionActionTarget(useStore.getState)
    if (!target || !visible()) return report()
    const call = (action: (expected: ExpectedRuntimeOwner) => Promise<CapabilityResult>) => action(target.expected)
    const result = await inheritAntigravitySelection(selection, {
      current: () => visible() && target.current(),
      snapshot: () => useStore.getState().session,
      select: (id) => call((expected) => window.yan.setModel(ANTIGRAVITY_PROVIDER, id, expected)),
      setMode: (mode) => call((expected) => window.yan.antigravity.setMode(mode, expected)),
      setThinking: (effort) => call((expected) => window.yan.setThinking(effort, expected))
    })
    return result.ok || report(result.error)
  } catch {
    return report()
  }
}

export async function materializeWorktreeIntent(t: HostT): Promise<'none' | 'created' | 'failed'> {
  const before = useStore.getState()
  const active = before.activeRunnerId
  const pending = active && pendingSelections.get(active)
  if (active && pending && isCreatedWorktreeView(pending.view)) {
    if (!(await applySelection(pending.view, pending.selection, nav.gate))) return 'failed'
    pendingSelections.delete(active)
    return 'none'
  }
  const wanted = useIntent.getState().runId
  if (!wanted || active !== wanted || before.peekedPath || before.peekedSessionId) return 'none'
  const runner = before.runners.find((item) => (item.runId ?? item.id) === active)
  if (!runner) return 'none'
  setWorktreeIntent(null)
  const fresh = before.messages.length === 0 && !before.session?.messageCount && !before.session?.isStreaming && !before.session?.isAgentRunning
  if (!fresh || runner.isolationBranch) return 'none'
  const key = composerDraftKey(before)
  const draft = restoreDraft(before.sessionRuntimes[key], loadDraft(key)).text
  const attachments = before.attachments
  const model = before.session?.model
  const creating = before.newSession({ cwd: runner.cwd, projectId: runner.projectId, scope: runner.projectId ? 'project' : 'global', worktree: true })
  const gate = nav.gate
  const created = await creating
  if (!created.ok || !created.runId) return 'failed'
  if (model?.provider === ANTIGRAVITY_PROVIDER) {
    const selection = { modelId: model.id, mode: before.session?.antigravity?.mode, effort: before.session?.antigravity?.thinking?.current }
    const live = new Set(useStore.getState().runners.map((item) => item.runId ?? item.id))
    for (const id of pendingSelections.keys()) if (!live.has(id) && id !== useStore.getState().activeRunnerId) pendingSelections.delete(id)
    pendingSelections.set(created.runId, { view: created, selection })
    if (gate !== nav.gate || !isCreatedWorktreeView(created)) return 'failed'
    const nextKey = composerDraftKey(useStore.getState())
    if (nextKey && nextKey !== key) {
      saveDraft(nextKey, { text: draft, attachments })
      useStore.getState().setSessionDraft(draft, nextKey)
    }
    if (attachments.length) useStore.setState({ attachments })
    if (!(await applySelection(created, selection, gate))) {
      if (gate === nav.gate && isCreatedWorktreeView(created)) {
        const current = useStore.getState()
        const currentKey = composerDraftKey(current)
        const edited = composerDraftForView(current, currentKey).text
        if (draft && (!edited || edited === draft)) useStore.setState({ editorInject: { text: draft, mode: 'replace' } })
        if (attachments.length && !current.attachments.length) useStore.setState({ attachments })
      }
      return 'failed'
    }
    pendingSelections.delete(created.runId)
  }
  if (gate !== nav.gate || !isCreatedWorktreeView(created)) return 'failed'
  saveDraft(key, { text: '', attachments: [] })
  if (key) useStore.getState().setSessionDraft('', key)
  if (attachments.length && model?.provider !== ANTIGRAVITY_PROVIDER) useStore.setState({ attachments })
  void announce(t, created.runId)
  return 'created'
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
