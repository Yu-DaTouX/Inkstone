import type { ToolMissingReason } from '../../../shared/ipc'
import type { TFunc } from '../i18n'

export function toolMissingText(reason: ToolMissingReason | undefined, t: TFunc): string {
  if (!reason) return ''
  switch (reason.code) {
    case 'shell-path-missing':
      return t('ob.toolShellPathMissing', { path: reason.path })
    case 'bash-missing':
      return reason.shell === 'pwsh' ? t('ob.toolBashMissingPwsh') : t('ob.toolBashMissingPs')
    case 'git-missing':
      return t('ob.toolGitMissing')
  }
}
