import type { ToolMissingReason } from '../../../shared/ipc'
import type { TFunc } from '../i18n'

/**
 * 把「外部命令缺失」的原因码渲染成一句短文案。
 *
 * 主进程只回报码与参数（`ToolStatus.reason`），句子在这里按当前语言拼——
 * 引导页的「命令行工具」一行和启动时的缺失通知共用它，两处文案不会漂移。
 *
 * 长度约束见 DESIGN_SYSTEM §5「首次引导」：一条一行，不写下载地址，
 * 「怎么办」交给旁边的「一键安装 Git」按钮。
 */
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
