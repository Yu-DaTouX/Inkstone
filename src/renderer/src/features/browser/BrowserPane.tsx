/**
 * v3 内置浏览器面板（R3）。
 *
 * 网页不是 iframe：真正的页面是主进程里的 `WebContentsView`，这里只画
 * 地址栏、前进/后退/刷新、标签栏与加载/错误状态，并把占位区的坐标同步给
 * 主进程。换的是 v3 界面，宿主 URL 校验、权限门禁与网络边界一律不动
 * （那是主进程 `browser.ts` / `browser-ipc.ts` 的事）。
 *
 * 边界：
 *   · 只有 `owner.active` 且浏览器资源确实归这把 key 时才驱动原生层；
 *     `active=false` 显示「先激活」，绝不复用别的会话的浏览器。
 *   · 未打开时只给明确的「打开浏览器」按钮，由用户点击才调用宿主；不自动
 *     打开、不自动导航。打开跨 await，代次 / 当前视图守卫在 `browser-open.ts`。
 *   · 显隐、遮挡、坐标分别走既有协调入口（`setBrowserSurfaceActive` /
 *     `acquireOverlayBlocker` / `window.yan.browser.setBounds`），不另开状态机。
 *   · 不自动聚焦地址栏（不偷焦点）；导航结果是异步的，用序号丢弃过期结果。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Plus, RotateCw } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Input, IconButton, Tab, TabList, Tabs, TextField } from '../../ui'
import { claimResource, resourceOwner } from '../../state/resource-owners'
import { nextAddressInput } from '../../../../shared/browser-navigation'
import type { BrowserPaneProps } from '../workbench/types'
import { browserText } from './browser-text'
import { browserControlAllowed } from './ownership'
import { useBrowserBoundsSync, useBrowserOverlayBlocker, useBrowserSurfaceActive } from './use-browser-surface'
import './browser.css'

export type { BrowserPaneProps }

/**
 * 把「裸域名 / localhost」补成可加载的 URL。
 *
 * 只做显示层的补全；真正的 scheme 校验在主进程（只允许 http(s)），
 * 这里不是安全边界。
 */
function withScheme(value: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `http://${value}`
  }
  return `https://${value}`
}

function Gate({ text, testId }: { text: string; testId: string }): ReactElement {
  return (
    <div className="v3-browser v3-browser--gate" data-testid={testId}>
      <p className="v3-browser__gate-text" role="status">
        {text}
      </p>
    </div>
  )
}

export function BrowserPane({ owner, visible = true }: BrowserPaneProps): ReactElement {
  const t = useT()
  const { lang } = useI18n()
  const text = browserText(lang)
  const state = useStore((s) => s.browserState)
  const openBrowser = useStore((s) => s.openBrowser)
  const viewportRef = useRef<HTMLDivElement>(null)

  const browserOwnerKey = resourceOwner('browser')
  /*
   * 没有登记过主人的浏览器（旧版本留下的 / 宿主直接开的）归给**活动**会话，
   * 与 `resource-owners` 的既有约定一致；别的列不会来抢。
   */
  const adoptable = owner.active && state.open && browserOwnerKey === undefined
  useEffect(() => {
    if (adoptable) claimResource('browser', owner.key)
  }, [adoptable, owner.key])

  const owns = adoptable || browserOwnerKey === owner.key
  const control = browserControlAllowed({
    owner,
    visible,
    browserOpen: state.open,
    browserOwnerKey: owns ? owner.key : browserOwnerKey
  })
  const controlRef = useRef(control)
  controlRef.current = control

  const inView = useBrowserBoundsSync(control, viewportRef)
  /* 占位区被完全滚出裁剪区时，原生层也要一起不可见。 */
  const surfaceActive = control && inView
  /* 显隐沿用既有协调器：这里只改输入，藏/归还由 store 统一做。 */
  useBrowserSurfaceActive(surfaceActive, owner.key)
  useBrowserOverlayBlocker(surfaceActive)

  /* ---- 地址栏：草稿优先，后台导航不冲掉正在输入的内容 ---- */
  const shownUrl = state.url === 'about:blank' ? '' : state.url
  const [draft, setDraft] = useState(shownUrl)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const navSeq = useRef(0)

  useEffect(() => {
    setDraft((prev) => nextAddressInput(shownUrl, prev, dirty))
  }, [shownUrl, dirty])

  /* 归属换了：上一块会话的地址草稿与错误不跟过来 */
  useEffect(() => {
    setDirty(false)
    setError('')
  }, [owner.key])

  const navigate = async (target?: string): Promise<void> => {
    if (!controlRef.current) return
    const value = withScheme((target ?? draft).trim())
    if (!value) return
    /*
     * 导航序号：连续回车或页面自身跳转时，只让**最后一次**的结果说话，
     * 旧结果不能把新地址的新错误/新状态盖回去。
     */
    const seq = ++navSeq.current
    let ok = false
    let message: string | undefined
    try {
      const result = await window.yan.browser.navigate(value)
      ok = result.ok
      message = result.error
    } catch (cause) {
      if (seq === navSeq.current && controlRef.current) {
        setError(cause instanceof Error ? cause.message : t('browser.navigateError'))
      }
      return
    }
    if (seq !== navSeq.current || !controlRef.current) return
    setDirty(false)
    setError(ok ? '' : (message ?? t('browser.navigateError')))
  }

  /*
   * 明确的用户入口：只在这里、由用户点击调用宿主打开，不做任何自动打开或
   * 自动导航。带上本面板的 owner key，store 会在 await 回来后复核当前视图；
   * 切会话后的旧回包不会重新 show 旧 view，也不会误领到新会话名下。
   * 打开中禁用按钮，避免连点并发导航同一个全局浏览器。
   */
  const openHere = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    try {
      await openBrowser(undefined, { key: owner.key })
    } finally {
      setOpening(false)
    }
  }

  if (!owner.active) return <Gate text={text.inactive} testId="browser-pane-inactive" />
  if (!control) {
    /*
     * R0 只把当前页签露出来；非当前页签挂载但 hidden，不显示误导文案。
     *
     * 资源无主、或已记在本会话名下但还没打开时，给出明确的「打开浏览器」
     * 入口。别的会话正开着 / 正在打开时（owner key 是别人的）不显示按钮，
     * 走下面的 foreignOwner 提示，不在这里抢占。
     */
    if (!state.open && (!browserOwnerKey || browserOwnerKey === owner.key)) {
      return (
        <div className="v3-browser v3-browser--gate" data-testid="browser-pane-not-open">
          <p className="v3-browser__gate-text" role="status">
            {text.notOpen}
          </p>
          {/* 面板 CSS 不在本次改动范围，间距用最小内联布局，不新增控件外观 */}
          <Button
            variant="secondary"
            size="sm"
            data-testid="browser-pane-open"
            isPending={opening}
            style={{ marginTop: 'var(--s-8)' }}
            onPress={() => void openHere()}
          >
            {opening ? text.opening : text.open}
          </Button>
        </div>
      )
    }
    if (!owns) return <Gate text={text.foreignOwner} testId="browser-pane-foreign" />
    return <div className="v3-browser" data-testid="browser-pane-hidden" hidden />
  }

  const tabs = state.tabs ?? []

  return (
    <div className="v3-browser" data-testid="browser-pane" data-active={surfaceActive ? '1' : '0'}>
      <div className="v3-browser__tabsrow">
        <Tabs
          selectedKey={state.activeTabId}
          onSelectionChange={(key) => {
            if (typeof key === 'string' && control && key !== state.activeTabId) {
              void window.yan.browser.switchTab(key)
            }
          }}
        >
          <TabList className="v3-browser__tablist" aria-label={text.tabLabel}>
            {tabs.map((tab) => (
              <Tab
                key={tab.id}
                id={tab.id}
                className="v3-browser__tab"
                closeLabel={t('browser.closeTab')}
                onClose={() => {
                  if (controlRef.current) void window.yan.browser.closeTab(tab.id)
                }}
              >
                {tab.title || tab.url || t('browser.newTab')}
              </Tab>
            ))}
          </TabList>
        </Tabs>
        <IconButton
          aria-label={t('browser.newTab')}
          className="v3-browser__newtab"
          data-testid="browser-pane-new-tab"
          onPress={() => {
            if (controlRef.current) void window.yan.browser.newTab()
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="v3-browser__toolbar">
        <IconButton
          aria-label={t('browser.back')}
          data-testid="browser-pane-back"
          isDisabled={!state.canGoBack}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.back()
          }}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.forward')}
          data-testid="browser-pane-forward"
          isDisabled={!state.canGoForward}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.forward()
          }}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t('browser.reload')}
          data-testid="browser-pane-reload"
          onPress={() => {
            if (controlRef.current) void window.yan.browser.reload()
          }}
        >
          <RotateCw size={14} aria-hidden="true" />
        </IconButton>

        <form
          className="v3-browser__address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate()
          }}
        >
          <TextField
            className="v3-browser__address-field"
            aria-label={t('browser.address')}
            value={draft}
            onChange={(value) => {
              setDraft(value)
              setDirty(true)
            }}
          >
            <Input
              className="ui-input v3-browser__input"
              aria-label={t('browser.address')}
              data-testid="browser-pane-address"
              spellCheck={false}
              autoComplete="off"
            />
          </TextField>
        </form>

        <IconButton
          aria-label={t('browser.openExternal')}
          data-testid="browser-pane-open-external"
          isDisabled={!shownUrl}
          onPress={() => {
            if (controlRef.current) void window.yan.browser.openExternal(state.url || draft)
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {state.loading || state.loadError || error ? (
        <div className="v3-browser__status" data-testid="browser-pane-status" role="status">
          {state.loading ? <span className="v3-browser__loading">{t('browser.loading')}</span> : null}
          {state.loadError ? (
            <div className="v3-browser__loaderror" data-testid="browser-pane-load-error" role="alert">
              <span className="v3-browser__error" title={state.loadError.description}>
                {t('browser.pageFailed')}
              </span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="browser-pane-retry"
                onPress={() => void navigate(state.loadError?.url)}
              >
                {t('browser.retry')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="browser-pane-error-external"
                onPress={() => {
                  if (controlRef.current) {
                    void window.yan.browser.openExternal(state.loadError?.url ?? state.url)
                  }
                }}
              >
                {t('browser.openExternal')}
              </Button>
              <span className="v3-browser__error-url" title={state.loadError.url} data-testid="browser-pane-error-url">
                {state.loadError.url}
              </span>
            </div>
          ) : null}
          {error ? (
            <span className="v3-browser__error" title={error}>
              {error}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 原生 WebContentsView 就盖在这块占位区上；这里不放任何内容，也不聚焦 */}
      <div
        className="v3-browser__viewport"
        ref={viewportRef}
        aria-label={text.viewportLabel}
        data-testid="browser-pane-viewport"
      />
    </div>
  )
}
