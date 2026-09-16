import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { I18nProvider } from './i18n'
import { useStore } from './state/store'
import { installAudioUnlock } from './lib/sound'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root')

/**
 * 把 store 挂到 window 上。
 *
 * 目的：验收测试（scripts/probe/*.js）需要直接调 store 的动作，
 * 而不是只靠模拟点击 —— 两者互补：点击测 UI 接线，store 测真实效果。
 * 不会加载任何远程内容（CSP 锁死），所以没有注入风险。
 */
declare global {
  interface Window {
    __yanStore: typeof useStore
  }
}
window.__yanStore = useStore

/* 声音提示：首次点击/按键时解锁 AudioContext（主进程已放开自动播放，这里兜底） */
installAudioUnlock()

createRoot(root).render(
  <StrictMode>
    {/*
     * ErrorBoundary 放在 I18nProvider **里面**：兜底界面自己要显示中文，
     * 需要语言上下文。它抓的是 App 子树的渲染异常（D8）。
     */}
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>
)
