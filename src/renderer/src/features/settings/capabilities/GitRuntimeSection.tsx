import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT, type TFunc } from '../../../i18n'
import { useStore } from '../../../state/store'
import type { GitInstallProgress, GitRuntimeStatus, ToolchainStatus, ToolStatus } from '../../../../../shared/ipc'
import { Button, ProgressBar } from '../../../ui'
import { useConfirm } from './confirm'
import { Actions, Group, Meta, StatusBadge, Warn } from './parts'

const BUSY_PHASES: ReadonlySet<GitInstallProgress['phase']> = new Set(['downloading', 'verifying', 'extracting'])

function toolBadge(tool: ToolStatus | undefined, name: string, t: TFunc): ReactElement {
  if (!tool) return <StatusBadge tone="neutral">{name}</StatusBadge>
  if (!tool.ok) return <StatusBadge tone="fail">{t('git.toolMissing', { name })}</StatusBadge>
  return <StatusBadge tone="ok">{tool.managed ? t('git.toolManaged', { name }) : t('git.toolSystem', { name })}</StatusBadge>
}

function InstallProgress({ progress, onCancel }: { progress: GitInstallProgress; onCancel: () => void }): ReactElement {
  const t = useT()
  const downloading = progress.phase === 'downloading'
  const pct = progress.total ? Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100)) : 0
  const label = downloading ? t('git.downloading', { pct }) : progress.phase === 'verifying' ? t('git.verifying') : t('git.extracting')
  return (
    <div className="caps-git-progress" data-testid="git-install-progress" data-phase={progress.phase}>
      <ProgressBar
        aria-label={label}
        label={<span role="status">{label}</span>}
        value={downloading ? pct : undefined}
        isIndeterminate={!downloading}
      />
      <Actions>
        <Button variant="secondary" onPress={onCancel} data-testid="git-install-cancel">
          {t('git.cancel')}
        </Button>
      </Actions>
    </div>
  )
}

export function GitRuntimeSection(): ReactElement | null {
  const t = useT()
  const confirm = useConfirm()
  const progress = useStore((s) => s.gitInstall)
  const installGit = useStore((s) => s.installGit)
  const cancelGitInstall = useStore((s) => s.cancelGitInstall)
  const [cancelled, setCancelled] = useState(false)
  const [runtime, setRuntime] = useState<GitRuntimeStatus | null>(null)
  const [tools, setTools] = useState<ToolchainStatus | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [nextRuntime, nextTools] = await Promise.all([window.yan.gitRuntimeStatus(), window.yan.toolchainStatus()])
      if (!alive.current) return
      setRuntime(nextRuntime)
      setTools(nextTools)
    } catch {
      if (alive.current) setRuntime(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (progress.phase === 'done' || progress.phase === 'error') void refresh()
  }, [progress.phase, refresh])

  if (!runtime?.supported) return null

  const busy = BUSY_PHASES.has(progress.phase) || runtime.installing
  const healthy = !!tools?.git.ok && !!tools?.bash.ok
  const sizeMb = Math.round(runtime.downloadSize / 1024 / 1024)

  const install = (): void => {
    setCancelled(false)
    void installGit()
  }

  const cancel = (): void => {
    setCancelled(true)
    void cancelGitInstall()
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('git.removeTitle'),
      body: healthy && tools?.git.managed ? t('git.removeBodyLast') : t('git.removeBody'),
      confirmLabel: t('git.remove'),
      tone: 'danger'
    })
    if (!ok) return
    setRemoving(true)
    setRemoveError('')
    try {
      await window.yan.gitRuntimeRemove()
    } catch (cause) {
      if (alive.current) setRemoveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setRemoving(false)
    }
    if (alive.current) await refresh()
  }

  return (
    <div data-testid="cap-git-runtime">
      <Group title={t('git.sectionTitle')} desc={t('git.sectionDesc')} card>
        <Actions>
          {toolBadge(tools?.git, 'Git', t)}
          {toolBadge(tools?.bash, 'bash', t)}
        </Actions>
        {runtime.managedInstalled ? (
          <Meta>{t('git.managedVersion', { v: runtime.managedVersion ?? '?' })}</Meta>
        ) : healthy ? (
          <Meta>{t('git.systemOk')}</Meta>
        ) : (
          <Meta>{t('notice.toolsMissing')}</Meta>
        )}
        {busy && BUSY_PHASES.has(progress.phase) ? <InstallProgress progress={progress} onCancel={cancel} /> : null}
        {progress.phase === 'error' && cancelled ? <Meta>{t('git.cancelled')}</Meta> : null}
        {progress.phase === 'error' && !cancelled ? (
          <Warn>
            <span data-testid="git-install-error">{progress.message}</span>
          </Warn>
        ) : null}
        {progress.phase === 'done' && runtime.managedInstalled ? <Meta>{progress.message ?? t('git.installed')}</Meta> : null}
        {removeError ? <Warn>{removeError}</Warn> : null}
        {busy ? null : (
          <Actions>
            {!healthy || runtime.managedInstalled ? (
              <Button
                variant={healthy ? 'secondary' : 'primary'}
                isDisabled={removing}
                onPress={install}
                data-testid="git-install-start"
              >
                {progress.phase === 'error' && !cancelled
                  ? t('git.retry')
                  : runtime.managedInstalled
                    ? t('git.reinstall', { mb: sizeMb })
                    : t('git.install', { mb: sizeMb })}
              </Button>
            ) : null}
            {runtime.managedInstalled ? (
              <Button
                variant="danger"
                isDisabled={removing}
                isPending={removing}
                onPress={() => void remove()}
                data-testid="git-remove"
              >
                {t('git.remove')}
              </Button>
            ) : null}
            <Button variant="secondary" isDisabled={removing} onPress={() => void refresh()}>
              {t('set.extRecheck')}
            </Button>
          </Actions>
        )}
      </Group>
    </div>
  )
}
