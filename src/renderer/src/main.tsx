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

declare global {
  interface Window {
    __yanStore: typeof useStore
    __yanSplit: typeof useSplitView
    __yanRuns: typeof useRunsV3
  }
}
const probeMode = window.yan.probeMode || (import.meta.env.DEV && new URLSearchParams(window.location.search).get('probe') === '1')
if (probeMode) {
  window.__yanStore = useStore
  window.__yanSplit = useSplitView
  window.__yanRuns = useRunsV3
}

installAudioUnlock()

installMotionPreferenceReporter()

installDeepLinkNavigation()

const UI_VERSION_KEY = 'yan.uiVersion'

async function pickShell(): Promise<'v2' | 'v3'> {
  if (window.yan.uiVersionEnv) return window.yan.uiVersionEnv
  try {
    const settings = await window.yan.getSettings()
    const version = resolveUiVersion(null, settings.uiVersion)
    try { localStorage.setItem(UI_VERSION_KEY, version) } catch { }
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
