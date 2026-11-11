import { useState, type ReactElement } from 'react'
import { useT } from '../../i18n'
import { useGitFolder } from '../../lib/git-folder'
import { useStore } from '../../state/store'
import { Switch } from '../../ui'
import { composerDraftKey } from '../../state/composer-recovery'
import { saveDraft } from './draft-store'

export function WorktreeToggle({ text }: { text: string }): ReactElement | null {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const runner = useStore((s) => (s.peekedSessionId ? undefined : s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)))
  const fresh = useStore(
    (s) => !s.peekedSessionId && s.messages.length === 0 && !s.session?.messageCount && !s.session?.isStreaming && !s.session?.isAgentRunning
  )
  const home = useStore((s) => {
    if (!runner) return undefined
    if (!runner.isolationBranch) return runner.cwd
    return runner.projectId ? s.settings?.projects.find((project) => project.id === runner.projectId)?.cwd : s.settings?.cwd
  })
  const branch = runner?.isolationBranch
  const git = useGitFolder(branch ? undefined : runner?.cwd, fresh)
  if (!runner || !fresh || (!branch && !git)) return null

  const change = async (on: boolean): Promise<void> => {
    if (busy || !fresh || !home) return
    const before = useStore.getState()
    const key = composerDraftKey(before)
    const attachments = before.attachments
    setBusy(true)
    try {
      const scope = runner.projectId ? 'project' : 'global'
      const res = await before.newSession({ cwd: home, projectId: runner.projectId, scope, ...(on ? { worktree: true } : {}) })
      if (!res.ok) return
      saveDraft(key, { text: '', attachments: [] })
      if (key) useStore.getState().setSessionDraft('', key)
      if (attachments.length) useStore.setState({ attachments })
      if (text.trim()) useStore.getState().insertIntoComposer(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span title={branch ? t('composer.worktree.on', { branch }) : t('composer.worktree.off')}>
      <Switch
        isSelected={!!branch}
        isDisabled={busy || !home}
        onChange={(on) => void change(on)}
        data-testid="composer-worktree"
        data-busy={busy || undefined}
      >
        {t('composer.worktree.label')}
      </Switch>
    </span>
  )
}
