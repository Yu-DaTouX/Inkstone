import { useState, type ReactElement } from 'react'
import { GitBranch } from '../../ui/icons'
import { useT } from '../../i18n'
import { useGitFolder } from '../../lib/git-folder'
import { useStore } from '../../state/store'
import { Toggle } from '../../ui'
import { composerDraftForView, composerDraftKey } from '../../state/composer-recovery'
import { saveDraft } from './draft-store'
import { nav } from '../../state/slices/runtime'
import { isCreatedWorktreeView, setWorktreeIntent, useWorktreeIntended } from './worktree-intent'

export function WorktreeToggle({ text }: { text?: string } = {}): ReactElement | null {
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
  const runKey = runner ? runner.runId ?? runner.id : undefined
  const intended = useWorktreeIntended(runKey)
  if (!runner || !fresh || (!branch && !git)) return null

  const selected = !!branch || intended
  const tip = branch ? t('composer.worktree.on', { branch }) : intended ? t('composer.worktree.pending') : t('composer.worktree.off')

  const change = async (on: boolean): Promise<void> => {
    if (busy || !fresh || !home) return
    if (!branch) {
      setWorktreeIntent(on && runKey ? runKey : null)
      return
    }
    const before = useStore.getState()
    const key = composerDraftKey(before)
    const draft = text ?? composerDraftForView(before, key).text
    const attachments = before.attachments
    setBusy(true)
    try {
      const scope = runner.projectId ? 'project' : 'global'
      const creating = before.newSession({ cwd: home, projectId: runner.projectId, scope, ...(on ? { worktree: true } : {}) })
      const gate = nav.gate
      const res = await creating
      if (!res.ok || gate !== nav.gate || !isCreatedWorktreeView(res)) return
      saveDraft(key, { text: '', attachments: [] })
      if (key) useStore.getState().setSessionDraft('', key)
      if (attachments.length) useStore.setState({ attachments })
      if (draft.trim()) useStore.getState().insertIntoComposer(draft)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="v3-home-worktree" data-active={selected || undefined}>
      <Toggle
        variant="ghost"
        size="md"
        isSelected={selected}
        isDisabled={busy || !home}
        onChange={(on) => void change(on)}
        tooltip={tip}
        tooltipPlacement="top"
        aria-label={t('composer.worktree.label')}
        className="v3-home-worktree-btn"
        data-testid="composer-worktree"
        data-busy={busy || undefined}
      >
        <GitBranch size={14} className="v3-home-worktree-icon" aria-hidden />
        <span className="v3-home-worktree-label">{t('composer.worktree.label')}</span>
        <span className="v3-home-worktree-dot" aria-hidden />
      </Toggle>
    </span>
  )
}
