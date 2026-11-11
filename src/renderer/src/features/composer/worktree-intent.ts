import { create } from 'zustand'
import type { HostT } from '../../lib/host-actions'
import { composerDraftKey } from '../../state/composer-recovery'
import { useStore } from '../../state/store'
import { saveDraft } from './draft-store'

const useIntent = create<{ runId: string | null }>(() => ({ runId: null }))

export function useWorktreeIntended(runId: string | undefined): boolean {
  return useIntent((s) => !!runId && s.runId === runId)
}

export function setWorktreeIntent(runId: string | null): void {
  useIntent.setState({ runId })
}

export async function materializeWorktreeIntent(t: HostT): Promise<'none' | 'created' | 'failed'> {
  const wanted = useIntent.getState().runId
  if (!wanted) return 'none'
  const before = useStore.getState()
  const runner = before.peekedSessionId ? undefined : before.runners.find((item) => (item.runId ?? item.id) === before.activeRunnerId)
  if (!runner || (runner.runId ?? runner.id) !== wanted) return 'none'
  setWorktreeIntent(null)
  const fresh = before.messages.length === 0 && !before.session?.messageCount && !before.session?.isStreaming && !before.session?.isAgentRunning
  if (!fresh || runner.isolationBranch) return 'none'
  const key = composerDraftKey(before)
  const attachments = before.attachments
  const created = await before.newSession({ cwd: runner.cwd, projectId: runner.projectId, scope: runner.projectId ? 'project' : 'global', worktree: true })
  if (!created.ok) return 'failed'
  saveDraft(key, { text: '', attachments: [] })
  if (key) useStore.getState().setSessionDraft('', key)
  if (attachments.length) useStore.setState({ attachments })
  void announce(t, created.runId)
  return 'created'
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
