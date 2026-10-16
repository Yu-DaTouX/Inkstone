import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../ui'

export function GitInstallControl({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const t = useT()
  const progress = useStore((s) => s.gitInstall)
  const installGit = useStore((s) => s.installGit)
  const cancelGitInstall = useStore((s) => s.cancelGitInstall)

  const busy = progress.phase === 'downloading' || progress.phase === 'verifying' || progress.phase === 'extracting'
  if (busy) {
    const pct = progress.total ? Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100)) : 0
    const label =
      progress.phase === 'downloading'
        ? t('git.downloading', { pct })
        : progress.phase === 'verifying'
          ? t('git.verifying')
          : t('git.extracting')
    return (
      <span className="git-install" data-testid="git-install-progress" data-phase={progress.phase}>
        <span className="git-install-label" role="status">
          {label}
        </span>
        <Button size={size} type="button" onClick={() => void cancelGitInstall()} data-testid="git-install-cancel">
          {t('git.cancel')}
        </Button>
      </span>
    )
  }
  return (
    <span className="git-install">
      {progress.phase === 'error' ? (
        <span className="git-install-label err" role="alert" data-testid="git-install-error">
          {progress.message}
        </span>
      ) : null}
      <Button size={size} variant="primary" type="button" onClick={() => void installGit()} data-testid="git-install-start">
        {progress.phase === 'error' ? t('git.retry') : t('git.install')}
      </Button>
    </span>
  )
}
