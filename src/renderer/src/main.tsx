import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from './i18n'
import { useStore } from './state/store'
import { useSplitView } from './state/split-view'
import { useRunsV3 } from './state/runs-v3'
import { installAudioUnlock } from './lib/sound'
import { installMotionPreferenceReporter } from './lib/motionPreference'
import { installDeepLinkNavigation } from './features/deeplink/navigation'
import { resolveUiVersion } from '../../shared/ui-version'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root')

/**
 * 把 store 挂到 window 上。
 *
 * 目的：验收测试（scripts/probe/*.js）需要直接调 store 的动作，
 * 而不是只靠模拟点击 —— 两者互补：点击测 UI 接线，store 测真实效果。
 * 仅宿主显式隔离探针或开发态探针开放；普通窗口不暴露可改写的 store。
 */
declare global {
  interface Window {
    __yanStore: typeof useStore
    __yanSplit: typeof useSplitView
    /** v3 运行镜像：探针用它注入合成运行，验证渲染而不模拟状态机。 */
    __yanRuns: typeof useRunsV3
  }
}
const probeMode = window.yan.probeMode || (import.meta.env.DEV && new URLSearchParams(window.location.search).get('probe') === '1')
if (probeMode) {
  window.__yanStore = useStore
  window.__yanSplit = useSplitView
  window.__yanRuns = useRunsV3
}

/* 声音提示：首次点击/按键时解锁 AudioContext（主进程已放开自动播放，这里兜底） */
installAudioUnlock()

/* 减少动态效果：把系统偏好上报给宿主，决定托盘状态符号是否闪动（L12）。 */
installMotionPreferenceReporter()

/* 深链接入口：主进程把 `inkstone://` 收敛成白名单意图，这里只做导航。 */
installDeepLinkNavigation()

/**
 * 选外壳：环境变量 `YAN_UI` 优先，其次设置 `uiVersion`，缺省 v2。
 *
 * 两个外壳共用同一个 store、IPC 与主进程服务，只是界面与样式不同；
 * 各自动态导入，v3 不加载任何 v2 样式，v2 也不加载 v3 样式。
 * 设置读不到时回落到上次记下的选择（localStorage），再不行就是 v2。
 */
const UI_VERSION_KEY = 'yan.uiVersion'

async function pickShell(): Promise<'v2' | 'v3'> {
  if (window.yan.uiVersionEnv) return window.yan.uiVersionEnv
  try {
    const settings = await window.yan.getSettings()
    const version = resolveUiVersion(null, settings.uiVersion)
    try { localStorage.setItem(UI_VERSION_KEY, version) } catch { /* 忽略 */ }
    return version
  } catch {
    try { return resolveUiVersion(null, localStorage.getItem(UI_VERSION_KEY)) } catch { return 'v2' }
  }
}

async function mount(): Promise<void> {
  const shell = await pickShell()
  document.documentElement.dataset.ui = shell
  let Shell: ComponentType
  if (shell === 'v3') {
    Shell = (await import('./app/ShellV3')).default
  } else {
    const [{ default: App }, { ErrorBoundary }] = await Promise.all([import('./App'), import('./components/ErrorBoundary')])
    Shell = function V2Shell() {
      return (
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      )
    }
  }
  createRoot(root!).render(
    <StrictMode>
      {/*
       * ErrorBoundary 放在 I18nProvider **里面**：兜底界面自己要显示中文，
       * 需要语言上下文。它抓的是外壳子树的渲染异常（D8）；v3 外壳自带一份。
       */}
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </StrictMode>
  )
}

void mount().catch((error: unknown) => {
  console.error('界面外壳加载失败', error)
  document.getElementById('boot')?.remove()
  const title = document.createElement('h1')
  title.textContent = '界面加载失败'
  const detail = document.createElement('pre')
  detail.textContent = error instanceof Error ? error.message : String(error)
  const hint = document.createElement('p')
  hint.textContent = window.yan.uiVersionEnv
    ? '当前版本由 YAN_UI 环境变量指定。可在下次启动时使用 YAN_UI=v2 回退；此窗口不会自动重启。'
    : '可以切回旧界面；不会删除会话或修改模型凭证。'
  root!.replaceChildren(title, detail, hint)
  if (!window.yan.uiVersionEnv) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = '切回旧界面并重新载入'
    button.onclick = async () => {
      button.disabled = true
      try {
        await window.yan.patchSettings({ uiVersion: 'v2' })
        window.location.reload()
      } catch (failure) {
        detail.textContent = failure instanceof Error ? failure.message : String(failure)
        button.disabled = false
      }
    }
    root!.append(button)
  }
})
