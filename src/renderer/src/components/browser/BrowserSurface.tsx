import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 浏览器主体。网页本身不是 iframe，而是主进程的 WebContentsView；
 * 这里仅负责地址栏、导航按钮和把可见区域坐标同步给主进程。
 *
 * ── UI 减负（用户反馈「浏览器栏太拥挤」）──
 * 之前所有操作挤在一行 42px 里：前进/后退/刷新 + 地址栏 + 外部浏览器 +
 * 「Chrome」文字按钮 + 加载提示 + 错误提示 + 关闭 + 「恢复 Agent」。
 * 现在拆成三层，各自只做一件事：
 *   ① 标签页    标签 + 新建
 *   ② 导航栏    前进/后退/刷新 + 地址栏 + Chrome + 「⋯」菜单 + 关闭
 *   ③ 状态行    只在加载中 / 出错时出现（不再挤占地址栏宽度）
 * 「在外部浏览器打开」「重新同步」「恢复 Agent」收进「⋯」菜单。
 */
export function BrowserSurface() {
  const t = useT()
  const state = useStore((s) => s.browserState)
  const close = useStore((s) => s.closeBrowser)
  const openExternalChrome = useStore((s) => s.openExternalChrome)
  const closeExternalChrome = useStore((s) => s.closeExternalChrome)
  const syncLocalProfile = useStore((s) => s.syncLocalProfile)
  const [syncing, setSyncing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const tabs = state.tabs ?? []
  const external = state.external
  const externalActive = state.mode === 'external' ? external : undefined
  const [address, setAddress] = useState(state.url)
  const [error, setError] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setAddress(state.url)
  }, [state.url])

  /* 菜单：点外面 / 按 Esc 收起 —— 否则它会一直悬在那儿挡地址栏 */
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement
      if (menuRef.current?.contains(el) || el.closest('.browser-actions')) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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
            <span>{tab.id.startsWith('chrome:') ? 'Chrome · ' : ''}{tab.title || tab.url || t('browser.newTab')}</span>
            <i onClick={(event) => { event.stopPropagation(); void window.yan.browser.closeTab(tab.id) }}>×</i>
          </button>
        ))}
        <button
          className="browser-new-tab"
          onClick={() => void window.yan.browser.newTab()}
          title={t('browser.newTab')}
          aria-label={t('browser.newTab')}
        >
          <Icon name="plus" size={12} />
        </button>
      </div>

      <div className="browser-toolbar">
        <button className="browser-nav" onClick={() => void window.yan.browser.back()} disabled={!state.canGoBack} title={t('browser.back')} aria-label={t('browser.back')}>
          ‹
        </button>
        <button className="browser-nav" onClick={() => void window.yan.browser.forward()} disabled={!state.canGoForward} title={t('browser.forward')} aria-label={t('browser.forward')}>
          ›
        </button>
        <button className="browser-nav" onClick={() => void window.yan.browser.reload()} title={t('browser.reload')} aria-label={t('browser.reload')}>
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

        {/*
         * 接入本机 Chrome：独立 profile + CDP。
         * 这是浏览器的一项重要能力，所以留在主栏（不塞进菜单），
         * 但收成图标大小，省宽度。
         */}
        <button
          className={`browser-nav browser-chrome ${external ? 'on' : ''}`}
          onClick={() => void (external ? closeExternalChrome() : openExternalChrome())}
          title={external ? t('browser.disconnectChrome') : t('browser.connectChrome')}
          aria-label={external ? t('browser.disconnectChrome') : t('browser.connectChrome')}
          data-testid="browser-external-chrome"
        >
          <Icon name="activity" size={14} />
        </button>

        {/* 「⋯」菜单：低频操作收在这里，地址栏因此能拿到更多宽度 */}
        <div className="browser-menu-wrap" ref={menuRef}>
          <button
            className={`browser-nav browser-more ${menuOpen ? 'on' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title={t('browser.more')}
            aria-label={t('browser.more')}
            aria-expanded={menuOpen}
            data-testid="browser-more"
          >
            <Icon name="menu" size={14} />
          </button>
        </div>

        <button className="browser-close" onClick={() => void close()} title={t('browser.close')} aria-label={t('browser.close')}>
          ×
        </button>
      </div>

      {/*
       * 第三行：状态行 / 展开的「⋯」操作行。
       *
       * ⚠️ 菜单必须是**占位的一行**，不能做浮动下拉：
       *    网页是主进程的原生 WebContentsView，永远盖在渲染层之上，
       *    浮动下拉一旦伸到网页区域就会被遮住（和报错提示同一个坑）。
       *    做成一行后它会占据 grid 第 3 行，网页区自然下移（ResizeObserver 同步坐标）。
       */}
      {menuOpen ? (
        <div className="browser-actions" data-testid="browser-menu">
          <button
            className="browser-action"
            onClick={() => {
              setMenuOpen(false)
              void window.yan.browser.openExternal(state.url || address)
            }}
            disabled={!state.url}
            data-testid="browser-open-external"
          >
            {t('browser.openExternal')}
          </button>
          <button
            className="browser-action"
            onClick={() => {
              setMenuOpen(false)
              void (external ? closeExternalChrome() : openExternalChrome())
            }}
          >
            {external ? t('browser.disconnectChrome') : t('browser.connectChrome')}
          </button>
          {state.userControl ? (
            <button
              className="browser-action"
              onClick={() => {
                setMenuOpen(false)
                void window.yan.browser.setUserControl(false)
              }}
            >
              {t('browser.recoverAgent')}
            </button>
          ) : null}
        </div>
      ) : state.loading || error || state.userControl ? (
        <div className="browser-status" data-testid="browser-status">
          {state.loading ? <span className="browser-loading">{t('browser.loading')}</span> : null}
          {state.userControl ? (
            <button
              className="browser-control"
              onClick={() => void window.yan.browser.setUserControl(false)}
              title={t('browser.recoverAgent')}
            >
              {t('browser.recoverAgent')}
            </button>
          ) : null}
          {error ? (
            <span className="browser-error" title={error}>
              {error}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="browser-viewport" ref={viewportRef}>
        {externalActive ? (
          <div className="browser-ext-note" data-testid="browser-external-note">
            <div className="browser-ext-title">{t('browser.externalActive')}</div>
            <div className="browser-ext-desc">{t('browser.externalDesc')}</div>
            {externalActive.profileDir ? <code className="browser-ext-path">{externalActive.profileDir}</code> : null}
            {externalActive.debuggingPort ? <span className="browser-ext-port">:{externalActive.debuggingPort}</span> : null}

            {/*
             * 数据同步状态 —— 用户报的「cookie 和历史没共享」就发生在这里。
             * 如实列出成功了哪些、哪些没成功以及原因，而不是一句「已连接」。
             */}
            {externalActive.sync ? (
              <div className="browser-ext-sync" data-testid="browser-ext-sync">
                {externalActive.sync.found ? (
                  <div className="browser-ext-sync-line">
                    {externalActive.sync.cookiesSynced
                      ? t('browser.syncOk')
                      : t('browser.syncNoCookies')}
                  </div>
                ) : (
                  <div className="browser-ext-sync-line">{t('browser.syncNoChrome')}</div>
                )}
                {externalActive.sync.failed.length ? (
                  <ul className="browser-ext-sync-failed" data-testid="browser-ext-sync-failed">
                    {externalActive.sync.failed.map((f) => (
                      <li key={f.item}>
                        <code>{f.item}</code> — {f.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {externalActive.sync && !externalActive.sync.cookiesSynced ? (
              <button
                className="browser-ext-resync"
                data-testid="browser-ext-resync"
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true)
                  try {
                    await syncLocalProfile()
                  } finally {
                    setSyncing(false)
                  }
                }}
              >
                {syncing ? t('browser.syncing') : t('browser.resync')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
