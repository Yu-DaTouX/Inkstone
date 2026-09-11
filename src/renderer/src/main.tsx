import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import { useStore } from './state/store'

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

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
)
