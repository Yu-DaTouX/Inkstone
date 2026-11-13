import { toolMissingText } from '../../lib/toolchain-text'
import { uiText } from '../../i18n/ui-text'
import type { Store } from '../store'
import { pushNotice, type SliceContext } from './shared'

export type NoticesSlice = Pick<Store, 'logs' | 'gitInstall' | 'notices' | 'nativeMcpStatus' | 'installGit' | 'cancelGitInstall' | 'dismissNotice' | 'notify' | 'checkToolchainNotice' | 'log'>

export function createNoticesSlice({ set, get }: SliceContext): NoticesSlice {
  return {
  logs: [],
  gitInstall: { phase: 'idle' },
  notices: [],
  nativeMcpStatus: null,
  installGit: async () => {
    set({ gitInstall: { phase: 'downloading', received: 0, message: '' } })
    try {
      const res = await window.yan.gitRuntimeInstall()
      if (!res.ok) set({ gitInstall: { phase: 'error', message: res.error ?? uiText('state.error.installFailed') } })
    } catch (error) {
      set({ gitInstall: { phase: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  },
  cancelGitInstall: async () => {
    await window.yan.gitRuntimeCancel().catch(() => undefined)
  },
  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  notify: (type, text) => set({ notices: pushNotice(get().notices, type, text) }),
  checkToolchainNotice: () => {
    void window.yan
      .toolchainStatus()
      .then((tools) => {
        const missing = [tools.bash, tools.git].filter((tool) => !tool.ok && tool.reason)
        if (!missing.length) return
        if (tools.platform === 'win32') {
          set({
            notices: [
              ...get().notices.filter((n) => n.id !== 'git-install'),
              { id: 'git-install', type: 'warning', text: uiText('notice.toolsMissing'), at: Date.now(), action: 'git-install' }
            ]
          })
        } else {
          for (const tool of missing) get().notify('warning', toolMissingText(tool.reason, uiText))
        }
      })
      .catch(() => undefined)
  },
  log: (line) => set({ logs: [...get().logs, line].slice(-200) })
  }
}
