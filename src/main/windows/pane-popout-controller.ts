import { BrowserWindow } from 'electron'
import {
  PANE_ALLOWED_ACTIONS,
  PANE_POPOUT_CHANNELS,
  PANE_TRANSFER_MATRIX,
  PANE_NATIVE_TRANSFER_FOLLOW_UP,
  isPanePopoutTab,
  type PaneActionEvent,
  type PaneActionRequest,
  type PaneActionResult,
  type PaneBrowserStateView,
  type PaneNativeTransferRequest,
  type PanePopoutAnyTabId,
  type PanePopoutOpenRequest,
  type PanePopoutOpenResult,
  type PanePopoutOwner,
  type PanePopoutTabId,
  type PaneProjection,
  type PaneProjectionEnvelope,
  type PaneStateView
} from '../../shared/pane-popout'
import type { WebContents } from 'electron'
import { PANE_POPOUT_SIZE, computePanePopoutBounds } from './pane-popout-geometry'
import type {
  PanePopoutController,
  PanePopoutControllerOptions,
  PanePopoutHost,
  PanePopoutWindow,
  PanePopoutWindowDeps
} from './pane-popout-types'

interface PaneSession {
  tab: PanePopoutTabId
  owner: PanePopoutOwner
  epoch: number
  projection: PaneProjection | null
  invalidated: boolean
  invalidReason?: string
  window: PanePopoutWindow
}

interface BrowserSession {
  owner: PanePopoutOwner
  epoch: number
  tabId: string
  targetWebContentsId: number
  invalidated: boolean
  invalidReason?: string
  window: PanePopoutWindow
}

const TAB_TITLES: Record<PanePopoutTabId, { 'zh-CN': string; 'en-US': string }> = {
  files: { 'zh-CN': '文件 · 独立窗口', 'en-US': 'Files · Window' },
  changes: { 'zh-CN': '改动 · 独立窗口', 'en-US': 'Changes · Window' },
  context: { 'zh-CN': '上下文 · 独立窗口', 'en-US': 'Context · Window' },
  branch: { 'zh-CN': '分支 · 独立窗口', 'en-US': 'Branches · Window' }
}

const BROWSER_TITLE: { 'zh-CN': string; 'en-US': string } = {
  'zh-CN': '浏览器 · 独立窗口',
  'en-US': 'Browser · Window'
}

export function createPanePopoutController(
  host: PanePopoutHost,
  options: PanePopoutControllerOptions = {}
): PanePopoutController {
  const sessions = new Map<PanePopoutTabId, PaneSession>()
  const browserSessions = new Map<'browser', BrowserSession>()
  const createWindow = options.createWindow ?? createPanePopoutWindow
  const browserTransfer = options.browserTransfer
  const terminalTransfer = options.terminalTransfer
  let epochCounter = 0

  const findSession = (contents: WebContents): PaneSession | null => {
    for (const session of sessions.values()) {
      if (session.window.webContents() === contents) return session
    }
    return null
  }

  const browserSessionFor = (contents: WebContents): BrowserSession | null => {
    const session = browserSessions.get('browser')
    return session && session.window.webContents() === contents ? session : null
  }

  const buildState = (session: PaneSession): PaneStateView => {
    const actions = session.invalidated ? [] : PANE_ALLOWED_ACTIONS[session.tab]
    return {
      locale: host.locale(),
      tab: session.tab,
      owner: session.owner,
      epoch: session.epoch,
      transfer: PANE_TRANSFER_MATRIX[session.tab].kind,
      readOnly: actions.length === 0,
      invalidated: session.invalidated,
      ...(session.invalidReason ? { invalidReason: session.invalidReason } : {}),
      actions,
      projection: session.invalidated ? null : session.projection
    }
  }

  const buildBrowserState = (session: BrowserSession): PaneBrowserStateView => ({
    locale: host.locale(),
    tab: 'browser',
    owner: session.owner,
    epoch: session.epoch,
    tabId: session.tabId,
    webContentsId: session.targetWebContentsId,
    url: browserTransfer?.navigationState({ webContentsId: session.targetWebContentsId })?.url ?? '',
    canGoBack: browserTransfer?.navigationState({ webContentsId: session.targetWebContentsId })?.canGoBack ?? false,
    canGoForward: browserTransfer?.navigationState({ webContentsId: session.targetWebContentsId })?.canGoForward ?? false,
    zoomFactor: host.zoomFactor(),
    invalidated: session.invalidated,
    ...(session.invalidReason ? { invalidReason: session.invalidReason } : {})
  })

  const pushState = (session: PaneSession): void => {
    session.window.send(PANE_POPOUT_CHANNELS.push, buildState(session))
  }

  const closeBrowserSession = (session: BrowserSession, returnView: boolean): void => {
    browserSessions.delete('browser')
    if (returnView && browserTransfer) {
      browserTransfer.returnToHost({ webContentsId: session.targetWebContentsId })
    }
    session.window.destroy()
  }

  const openBrowser = (request: PanePopoutOpenRequest): PanePopoutOpenResult => {
    if (!browserTransfer) {
      return {
        ok: false,
        code: 'unsupported',
        reason: '未注入浏览器原生视图转移端口',
        followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
      }
    }
    const tabId = typeof request.viewId === 'string' ? request.viewId.trim() : ''
    if (!tabId) return { ok: false, code: 'rejected', reason: '缺少浏览器页签 id' }
    if (!request.owner || typeof request.owner.key !== 'string') {
      return { ok: false, code: 'rejected', reason: '缺少归属或页签不合法' }
    }
    const existing = browserSessions.get('browser')
    if (existing && !existing.invalidated && existing.tabId === tabId && existing.owner.key === request.owner.key) {
      existing.window.setTitle(BROWSER_TITLE[host.locale()])
      existing.window.show()
      return { ok: true, code: 'ok', epoch: existing.epoch }
    }
    if (existing) closeBrowserSession(existing, true)

    const session: BrowserSession = {
      owner: request.owner,
      epoch: ++epochCounter,
      tabId,
      targetWebContentsId: 0,
      invalidated: false,
      window: undefined as unknown as PanePopoutWindow
    }
    const win = createWindow({
      preloadPath: host.preloadPath(),
      load: (target) => host.loadEntry(target, 'pane'),
      anchorBounds: () => host.anchorBounds(),
      workArea: (bounds) => host.workArea(bounds),
      zoomFactor: () => host.zoomFactor(),
      onClosed: () => {
        if (browserSessions.get('browser') !== session) return
        browserSessions.delete('browser')
        browserTransfer.returnToHost({ webContentsId: session.targetWebContentsId })
      }
    })
    session.window = win
    const target = win.browserWindow()
    const targetId = target?.webContents?.id
    if (!target || typeof targetId !== 'number') {
      win.destroy()
      return { ok: false, code: 'unsupported', reason: '目标窗口不可用' }
    }
    const begin = browserTransfer.begin({
      tabId,
      ownerKey: request.owner.key,
      generation: request.owner.generation ?? 0,
      target
    })
    if (!begin.ok) {
      win.destroy()
      return {
        ok: false,
        code: begin.code === 'owner-conflict' ? 'rejected' : 'unsupported',
        reason: begin.message,
        followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
      }
    }
    session.targetWebContentsId = targetId
    browserSessions.set('browser', session)
    win.setTitle(BROWSER_TITLE[host.locale()])
    win.show()
    return { ok: true, code: 'ok', epoch: session.epoch }
  }

  const openTerminal = (request: PanePopoutOpenRequest): PanePopoutOpenResult => {
    if (!terminalTransfer) {
      return {
        ok: false,
        code: 'unsupported',
        reason: '未注入终端 transfer 端口',
        followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
      }
    }
    if (!request.owner || typeof request.owner.key !== 'string') {
      return { ok: false, code: 'rejected', reason: '缺少归属或页签不合法' }
    }
    const terminalId = typeof request.terminalId === 'string' ? request.terminalId.trim() : ''
    const nativeRequest: PaneNativeTransferRequest = {
      tab: 'terminal',
      owner: request.owner,
      ...(terminalId ? { terminalId } : {})
    }
    if (!terminalTransfer.canTransfer(nativeRequest)) {
      return { ok: false, code: 'unsupported', reason: '当前终端不可转移', followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP }
    }
    const result = terminalTransfer.transfer(nativeRequest)
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'rejected' ? 'rejected' : 'unsupported',
        reason: result.message,
        followUp: result.followUp
      }
    }
    return { ok: true, code: 'ok' }
  }

  return {
    open(request: PanePopoutOpenRequest): PanePopoutOpenResult {
      if (request.tab === 'browser') return openBrowser(request)
      if (request.tab === 'terminal') return openTerminal(request)
      const descriptor = PANE_TRANSFER_MATRIX[request.tab]
      if (!descriptor || descriptor.support === 'unsupported') {
        return {
          ok: false,
          code: 'unsupported',
          ...(descriptor?.reason ? { reason: descriptor.reason } : {}),
          followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
        }
      }
      if (!isPanePopoutTab(request.tab) || !request.owner || typeof request.owner.key !== 'string') {
        return { ok: false, code: 'rejected', reason: '缺少归属或页签不合法' }
      }
      const tab = request.tab
      const owner = request.owner
      let session = sessions.get(tab)
      if (session) {
        if (session.owner.key !== owner.key) {
          session.epoch = ++epochCounter
          session.projection = null
          session.invalidated = false
          delete session.invalidReason
        }
        session.owner = owner
        session.window.setTitle(TAB_TITLES[tab][host.locale()])
        session.window.show()
        pushState(session)
        return { ok: true, code: 'ok', epoch: session.epoch }
      }
      const created: PaneSession = {
        tab,
        owner,
        epoch: ++epochCounter,
        projection: null,
        invalidated: false,
        window: undefined as unknown as PanePopoutWindow
      }
      const win = createWindow({
        preloadPath: host.preloadPath(),
        load: (target) => host.loadEntry(target, 'pane'),
        anchorBounds: () => host.anchorBounds(),
        workArea: (bounds) => host.workArea(bounds),
        zoomFactor: () => host.zoomFactor(),
        onClosed: () => {
          const current = sessions.get(tab)
          if (current === created) sessions.delete(tab)
        }
      })
      created.window = win
      win.setTitle(TAB_TITLES[tab][host.locale()])
      sessions.set(tab, created)
      win.show()
      pushState(created)
      return { ok: true, code: 'ok', epoch: created.epoch }
    },

    updateProjection(envelope: PaneProjectionEnvelope): boolean {
      if (!envelope || !isPanePopoutTab(envelope.tab)) return false
      const session = sessions.get(envelope.tab)
      if (!session || session.invalidated) return false
      if (session.owner.key !== envelope.ownerKey) return false
      if (session.epoch !== envelope.epoch) return false
      session.projection = envelope.projection
      pushState(session)
      return true
    },

    invalidate(ownerKey: string, reason?: string): void {
      for (const session of sessions.values()) {
        if (session.owner.key !== ownerKey) continue
        session.invalidated = true
        session.projection = null
        if (reason) session.invalidReason = reason
        else delete session.invalidReason
        pushState(session)
      }
      const browser = browserSessions.get('browser')
      if (browser && browser.owner.key === ownerKey && !browser.invalidated) {
        browser.invalidated = true
        if (reason) browser.invalidReason = reason
        else delete browser.invalidReason
        browserTransfer?.invalidateOwner(ownerKey, 'owner-stale')
      }
      terminalTransfer?.invalidate?.(ownerKey, 'owner-stale')
    },

    invalidateAll(reason?: string): void {
      for (const session of sessions.values()) {
        session.invalidated = true
        session.projection = null
        if (reason) session.invalidReason = reason
        else delete session.invalidReason
        pushState(session)
      }
      const browser = browserSessions.get('browser')
      if (browser && !browser.invalidated) {
        browser.invalidated = true
        if (reason) browser.invalidReason = reason
        else delete browser.invalidReason
        browserTransfer?.invalidateAll('owner-stale')
      }
      terminalTransfer?.invalidateAll?.('owner-stale')
    },

    close(tab: PanePopoutAnyTabId): void {
      if (tab === 'browser') {
        const session = browserSessions.get('browser')
        if (session) closeBrowserSession(session, true)
        return
      }
      if (!isPanePopoutTab(tab)) return
      const session = sessions.get(tab)
      if (!session) return
      sessions.delete(tab)
      session.window.destroy()
    },

    closeByContents(contents: WebContents): boolean {
      const browser = browserSessionFor(contents)
      if (browser) {
        closeBrowserSession(browser, true)
        return true
      }
      const session = findSession(contents)
      if (!session) return false
      sessions.delete(session.tab)
      session.window.destroy()
      return true
    },

    closeAll(): void {
      for (const session of [...sessions.values()]) {
        sessions.delete(session.tab)
        session.window.destroy()
      }
      const browser = browserSessions.get('browser')
      if (browser) closeBrowserSession(browser, true)
    },

    isOpen: (tab) =>
      tab === 'browser' ? browserSessions.has('browser') : isPanePopoutTab(tab) && sessions.has(tab),
    openTabs: () => [...sessions.keys()],
    ownerKeyOf: (tab) => sessions.get(tab)?.owner.key ?? null,
    epochOf: (tab) => sessions.get(tab)?.epoch ?? null,
    stateFor: (contents) => {
      const session = findSession(contents)
      return session ? buildState(session) : null
    },

    handleAction(contents: WebContents, action: PaneActionRequest): PaneActionResult {
      const session = findSession(contents)
      if (!session) return { ok: false, code: 'rejected', message: '来源不是弹出窗' }
      if (session.invalidated) return { ok: false, code: 'invalid-owner', message: '归属已失效' }
      if (!action || !PANE_ALLOWED_ACTIONS[session.tab].includes(action.type)) {
        return { ok: false, code: 'rejected', message: '该页签不允许此动作' }
      }
      if ((action.type === 'files.preview' || action.type === 'files.attach') && !action.path) {
        return { ok: false, code: 'rejected', message: '缺少路径' }
      }
      const event: PaneActionEvent = {
        tab: session.tab,
        ownerKey: session.owner.key,
        epoch: session.epoch,
        action
      }
      if (options.authorize && !options.authorize(event, action)) {
        return { ok: false, code: 'rejected', message: '宿主拒绝' }
      }
      options.onAction?.(event)
      return { ok: true, code: 'ok' }
    },

    owns: (contents) => findSession(contents) !== null || browserSessionFor(contents) !== null,

    browserStateFor: (contents) => {
      const session = browserSessionFor(contents)
      return session ? buildBrowserState(session) : null
    },

    ownsBrowser: (contents) => browserSessionFor(contents) !== null,

    dispose(): void {
      for (const session of [...sessions.values()]) {
        sessions.delete(session.tab)
        session.window.destroy()
      }
      const browser = browserSessions.get('browser')
      if (browser) closeBrowserSession(browser, true)
    }
  }
}

export function createPanePopoutWindow(deps: PanePopoutWindowDeps): PanePopoutWindow {
  let destroyed = false
  const win = new BrowserWindow({
    ...PANE_POPOUT_SIZE,
    show: false,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    backgroundColor: '#151515',
    webPreferences: {
      preload: deps.preloadPath,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  const place = (): void => {
    const anchor = deps.anchorBounds()
    const area = deps.workArea(anchor ?? { x: 0, y: 0, width: 0, height: 0 })
    win.setBounds(computePanePopoutBounds({ ...(anchor ? { anchor } : {}), area, size: PANE_POPOUT_SIZE }))
    const factor = deps.zoomFactor()
    if (Number.isFinite(factor) && factor > 0) win.webContents.setZoomFactor(factor)
  }

  win.on('closed', () => {
    if (destroyed) return
    destroyed = true
    deps.onClosed?.()
  })

  deps.load(win)

  return {
    show() {
      if (destroyed) return
      place()
      win.show()
      win.focus()
    },
    hide() {
      if (!destroyed && win.isVisible()) win.hide()
    },
    isVisible: () => !destroyed && win.isVisible(),
    browserWindow: () => (destroyed ? null : win),
    webContents: () => (destroyed ? null : win.webContents),
    send(channel, payload) {
      if (!destroyed && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
    },
    setTitle(title) {
      if (!destroyed) win.setTitle(title)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      win.destroy()
    }
  }
}
