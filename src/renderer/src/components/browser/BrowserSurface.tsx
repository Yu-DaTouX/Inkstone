import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 浏览器工具栏。网页本身不是 iframe，而是主进程的 WebContentsView；
 * 这里仅负责地址栏、导航按钮和把可见区域坐标同步给主进程。
 */
export function BrowserSurface() {
  const t = useT()
  const state = useStore((s) => s.browserState)
  const close = useStore((s) => s.closeBrowser)
  const openExternalChrome = useStore((s) => s.openExternalChrome)
  const closeExternalChrome = useStore((s) => s.closeExternalChrome)
  const tabs = state.tabs ?? []
  const external = state.external
  const externalActive = state.mode === 'external' ? external : undefined
  const [address, setAddress] = useState(state.url)
  const [error, setError] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setAddress(state.url)
  }, [state.url])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let frame = 0
    let disposed = false
    let lastBounds = ''
    const syncBounds = (): void => {
      const r = el.getBoundingClientRect()
      const bounds = {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height
      }
      /*
       * ResizeObserver 只保证尺寸变化，不保证位置变化（例如左栏收放、
       * 右栏列宽过渡）。逐帧比较坐标，避免 WebContentsView 留在旧列。
       * 只有实际变化才发 IPC，不会每帧重复设置原生视图。
       */
      const signature = [bounds.x, bounds.y, bounds.width, bounds.height].map((v) => Math.round(v * 2) / 2).join(',')
      if (signature !== lastBounds) {
        lastBounds = signature
        void window.yan.browser.setBounds(bounds)
      }
      if (!disposed) frame = requestAnimationFrame(syncBounds)
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(el)
    frame = requestAnimationFrame(syncBounds)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const navigate = async (): Promise<void> => {
    let value = address.trim()
    if (!value) return
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`
    const result = await window.yan.browser.navigate(value)
    if (!result.ok) setError(result.error ?? t('browser.navigateError'))
    else setError('')
  }

  return (
    <div className="browser-surface" data-testid="browser-surface">
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`browser-tab ${tab.id === state.activeTabId ? 'active' : ''} ${tab.id.startsWith('chrome:') ? 'external' : ''}`}
            role="tab"
            aria-selected={tab.id === state.activeTabId}
            onClick={() => void window.yan.browser.switchTab(tab.id)}
            title={tab.url}
          >
            <span>{tab.id.startsWith('chrome:') ? 'Chrome · ' : ''}{tab.title || tab.url || '新标签页'}</span>
            <i onClick={(event) => { event.stopPropagation(); void window.yan.browser.closeTab(tab.id) }}>×</i>
          </button>
        ))}
        <button className="browser-new-tab" onClick={() => void window.yan.browser.newTab()} title="新建标签页">+</button>
      </div>
      <div className="browser-toolbar">
        <button className="browser-nav" onClick={() => void window.yan.browser.back()} disabled={!state.canGoBack} title={t('browser.back')}>
          ‹
        </button>
        <button className="browser-nav" onClick={() => void window.yan.browser.forward()} disabled={!state.canGoForward} title={t('browser.forward')}>
          ›
        </button>
        <button className="browser-nav" onClick={() => void window.yan.browser.reload()} title={t('browser.reload')}>
          ↻
        </button>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate()
          }}
        >
          <input value={address} onChange={(event) => setAddress(event.target.value)} aria-label={t('browser.address')} />
        </form>
        <button
          className="browser-nav browser-external"
          onClick={() => void window.yan.browser.openExternal(state.url || address)}
          disabled={!state.url}
          title={t('browser.openExternal')}
          data-testid="browser-open-external"
        >
          ↗
        </button>
        {/*
         * 接入本机 Chrome：独立 profile + CDP。
         * 网页在 Chrome 自己的窗口里，面板只显示状态和工具入口。
         */}
        <button
          className={`browser-nav browser-chrome ${external ? 'on' : ''}`}
          onClick={() => void (external ? closeExternalChrome() : openExternalChrome())}
          title={external ? t('browser.disconnectChrome') : t('browser.connectChrome')}
          data-testid="browser-external-chrome"
        >
          Chrome
        </button>
        {/*
         * 加载/错误提示必须放在工具栏里，不能放进 .browser-viewport。
         * 网页是主进程的原生 WebContentsView，永远盖在渲染层之上；
         * 原来定位在 viewport 区域的提示被整段遮住，等于不存在。
         */}
        {state.loading ? <span className="browser-loading">{t('browser.loading')}</span> : null}
        {error ? (
          <span className="browser-error" title={error}>
            {error}
          </span>
        ) : null}
        <button className="browser-close" onClick={() => void close()} title={t('browser.close')}>
          ×
        </button>
        {state.userControl ? (
          <button className="browser-control" onClick={() => void window.yan.browser.setUserControl(false)} title="恢复 Agent 控制">
            恢复 Agent
          </button>
        ) : null}
      </div>
      <div className="browser-viewport" ref={viewportRef}>
        {externalActive ? (
          <div className="browser-ext-note" data-testid="browser-external-note">
            <div className="browser-ext-title">{t('browser.externalActive')}</div>
            <div className="browser-ext-desc">{t('browser.externalDesc')}</div>
            {externalActive.profileDir ? <code className="browser-ext-path">{externalActive.profileDir}</code> : null}
            {externalActive.debuggingPort ? <span className="browser-ext-port">:{externalActive.debuggingPort}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
