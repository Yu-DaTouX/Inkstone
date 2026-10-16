/**
 * `inkstone://` 深链接 → 界面导航入口。
 *
 * 主进程已把外部 URL 解析、校验成白名单意图（`src/main/deeplink/protocol.ts`），
 * 这里只把意图落到既有 store / v3 路由上：打开会话、新建会话并预填草稿、打开设置
 * 分区、打开运行总览。**永远只导航**：不发送消息、不批准、不改会话内容；预填文本
 * 只进输入框草稿。
 */
import type { DeepLinkIntent } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'

export function applyDeepLink(intent: DeepLinkIntent): void {
  const ui = useUiV3.getState()
  const store = useStore.getState()
  switch (intent.action) {
    case 'session': {
      ui.navigate({ name: 'chat' })
      /* `entry` 已由主进程校验，但 v3 暂无按 entry 定位能力：先打开会话本身。 */
      const local = store.sessions.find((s) => s.id === intent.sessionId)?.path
      if (local) {
        void store.switchSession(local)
        return
      }
      /* 会话不一定在当前列表（更早 / 别的项目）：向宿主查一次，查不到就停在对话页。 */
      void window.yan
        .listSessions()
        .then((list) => {
          const hit = list.find((s) => s.id === intent.sessionId)
          if (hit) void useStore.getState().switchSession(hit.path)
        })
        .catch(() => {
          /* 查询失败不导航、不猜路径 */
        })
      return
    }
    case 'new-session': {
      ui.navigate({ name: 'chat' })
      void store.newSession({ scope: 'global' }).then((res) => {
        /* 只写进输入框草稿，绝不自动发送（深链接只导航）。 */
        if (res.ok && intent.text) useStore.getState().injectComposerText(intent.text)
      })
      return
    }
    case 'settings': {
      ui.navigate({ name: 'settings' })
      /* 复用旧 `openSettings(name)`：v3 设置订阅把它映射到分区。 */
      store.openSettings(intent.section)
      return
    }
    case 'runs': {
      ui.navigate({ name: 'runs' })
      return
    }
  }
}

/** 订阅主进程推送；返回退订函数。挂在 main.tsx，两个外壳都生效。 */
export function installDeepLinkNavigation(): () => void {
  return window.yan.onDeepLink((intent) => applyDeepLink(intent))
}
