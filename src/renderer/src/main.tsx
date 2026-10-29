import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from './i18n'
import { useStore } from './state/store'
import { useSplitView } from './state/split-view'
import { useRunsV3 } from './state/runs-v3'
import { useLiveQuota } from './state/live-quota'
import { installAudioUnlock } from './lib/sound'
import { installMotionPreferenceReporter } from './lib/motionPreference'
import { installFocusModality } from './lib/focusModality'
import { installHairline } from './lib/hairline'
import { installDeepLinkNavigation } from './features/deeplink/navigation'
import { installBrowserPreloadRecovery } from './lib/preload-recovery'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root')

declare global {
  interface Window {
    __yanStore: typeof useStore
    __yanSplit: typeof useSplitView
    __yanRuns: typeof useRunsV3
    __yanLiveQuota: typeof useLiveQuota
  }
}
const probeMode = window.yan.probeMode || (import.meta.env.DEV && new URLSearchParams(window.location.search).get('probe') === '1')
if (probeMode) {
  window.__yanStore = useStore
  window.__yanSplit = useSplitView
  window.__yanRuns = useRunsV3
  window.__yanLiveQuota = useLiveQuota
}

installAudioUnlock()

installBrowserPreloadRecovery()

installMotionPreferenceReporter()

installFocusModality()

installHairline()

installDeepLinkNavigation()

async function mount(): Promise<void> {
  document.documentElement.dataset.ui = 'v3'
  const { default: Shell } = await import('./app/ShellV3')
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
  hint.textContent = '会话与设置不受影响。请重新启动砚；如果仍然失败，请把上面的错误信息反馈给开发者。'
  root!.replaceChildren(title, detail, hint)
})
