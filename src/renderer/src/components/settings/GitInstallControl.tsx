import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../ui'

/**
 * 一键安装受管 Git 的按钮与进度。
 *
 * 引导页的「命令行工具」一行和启动时的缺失通知共用它：状态在 store 里（主进程推 `git-install`），
 * 两处看到的是同一份进度。点按钮才开始下载，这是用户的确认；进度里写清来源与大小。
 */
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
