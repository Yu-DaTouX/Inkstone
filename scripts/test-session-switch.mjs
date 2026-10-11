/**
 * 快速切会话的选择代次（O03 回归）。
 *
 * 把渲染端 store 单独 bundle 出来，用全局桩替代 `window.yan` / localStorage /
 * requestAnimationFrame：不开 Electron、不连接 pi、不读真实会话。
 *
 * 回归本体：先点 A（peek 慢）、再点 B（peek 快）时，旧实现会让 A 的结果后到并
 * 覆盖 B —— 内容与「待激活目标」都指回 A。修复后过期的点击整段作废。
 */
export async function runSessionSwitchTests(ok) {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /* 记住原值：test-unit 是同一个进程，不能让棚渗到后面的测试里 */
  const savedGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  }

  /* ---- 渲染端全局的桩 ---- */
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  /*
   * 同步执行：store 里嵌套了两层 rAF，异步实现会在测试收尾（恢复全局）之后
   * 才触发内层调用，那时桩已经不在全局上了。
   */
  globalThis.requestAnimationFrame = (fn) => {
    fn(0)
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}

  const peekDelays = new Map()
  const selectDelays = new Map()
  const selected = []
  const yan = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'peekSession') {
          return async (path) => {
            await sleep(peekDelays.get(path) ?? 0)
            return {
              messages: [{ id: `msg-${path}`, role: 'user', text: path }],
              sessionId: path,
              truncated: 0,
              total: 1
            }
          }
        }
        if (prop === 'selectSession') {
          return async (target) => {
            selected.push(target.sessionFile ?? target.sessionId)
            await sleep(selectDelays.get(target.sessionId) ?? 0)
            return target.sessionFile
              ? { ok: true, deferred: true, sessionId: target.sessionId }
              : { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
          }
        }
        /* 其余宿主能力：返回空实现，本测试不依赖它们的具体行为 */
        return async () => undefined
      }
    }
  )
  globalThis.window = {
    yan,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }

  const temp = await mkdtemp(join(tmpdir(), 'yan-session-switch-'))
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const outfile = join(temp, 'store.mjs')
  await build({
    entryPoints: ['src/renderer/src/state/store.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      /*
       * store 里直接写裸 `requestAnimationFrame(...)`（浏览器全局）。
       * Node 里它是运行时才挂到 globalThis 的，模块内裸引用不保证能解析到；
       * 编译时把它换成显式属性访问，测试就不依赖全局标识符解析时机。
       */
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })
  const { useStore } = await import(pathToFileURL(outfile).href)

  const sessions = [
    { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' },
    { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' }
  ]

  /* ---- 1. 先点慢的 A，再点快的 B：B 必须胜出 ---- */
  {
    useStore.setState({ sessions, settings: { cwd: 'C:/proj', projects: [] }, session: null, messages: [] })
    peekDelays.set('A', 150)
    peekDelays.set('B', 20)
    selected.length = 0
    const first = useStore.getState().switchSession('A')
    await sleep(30) /* A 的 peek 还没回来 */
    const second = useStore.getState().switchSession('B')
    await Promise.all([first, second])
    ok(
      useStore.getState().messages[0]?.id === 'msg-B',
      '**后点的会话胜出**（旧请求不再覆盖新选择）',
      useStore.getState().messages[0]?.id
    )
    ok(selected.includes('B'), '新点击正常向主进程请求切换', selected.join(','))
    ok(!selected.includes('A'), '**过期的点击不再向主进程请求激活**', selected.join(','))
    const pending = useStore.getState().pendingActivation
    ok(pending?.sessionFile !== 'A', '待激活目标没有被旧点击倒置', pending?.sessionFile ?? '无')
  }

  /* ---- 2. 没有并发时单次点击照常工作（代次闸门不能误杀） ---- */
  {
    useStore.setState({ sessions, settings: { cwd: 'C:/proj', projects: [] }, session: null, messages: [] })
    selected.length = 0
    peekDelays.set('A', 20)
    await useStore.getState().switchSession('A')
    await sleep(30)
    ok(useStore.getState().messages[0]?.id === 'msg-A', '单次点击正常铺上内容', useStore.getState().messages[0]?.id)
    ok(selected.includes('A'), '单次点击正常请求激活', selected.join(','))
  }

  /* ---- 3. 三次连点：只有最后一次生效 ---- */
  {
    useStore.setState({ sessions, settings: { cwd: 'C:/proj', projects: [] }, session: null, messages: [] })
    peekDelays.set('A', 120)
    peekDelays.set('B', 60)
    selected.length = 0
    const p1 = useStore.getState().switchSession('A')
    const p2 = useStore.getState().switchSession('B')
    await sleep(10)
    const p3 = useStore.getState().switchSession('A')
    await Promise.all([p1, p2, p3])
    ok(useStore.getState().messages[0]?.id === 'msg-A', '最后一次点击最终生效', useStore.getState().messages[0]?.id)
    ok(selected.filter((path) => path === 'A').length === 1, '同一会话只请求激活一次（前两次作废）', selected.join(','))
  }

  /* 无路径托盘选择与历史点击必须共用选择代次。 */
  const resetView = () => useStore.setState({
    sessions, settings: { cwd: 'C:/proj', projects: [] }, session: null,
    messages: [], activeRunnerId: 'old-run', sessionRuntimes: {},
    peekedPath: null, peekedSessionId: null, pendingActivation: null, notices: []
  })
  const tray = (id) => useStore.getState().applyPush({
    ch: 'tray-select-session', payload: { sessionId: id, cwd: 'C:/proj' }
  })
  {
    resetView()
    selected.length = 0
    peekDelays.set('A', 100)
    const history = useStore.getState().switchSession('A')
    await sleep(10)
    tray('tray-b')
    await history
    await sleep(20)
    ok(!selected.includes('A'), '托盘的新选择使旧历史读取失效', selected.join(','))
    ok(useStore.getState().pendingActivation === null, '旧历史不能成为托盘选择后的待激活目标')
    ok(useStore.getState().activeRunnerId === 'run-tray-b', '托盘目标保持为当前运行实例')
    ok(useStore.getState().peekedSessionId !== 'sess-a', '托盘选择不保留旧历史的预览身份')
  }
  {
    resetView()
    selectDelays.set('tray-b', 100)
    peekDelays.set('A', 10)
    tray('tray-b')
    await sleep(10)
    await useStore.getState().switchSession('A')
    await sleep(110)
    ok(useStore.getState().pendingActivation?.sessionFile === 'A', '托盘旧响应不清除新历史的待激活目标')
    ok(useStore.getState().activeRunnerId !== 'run-tray-b', '托盘旧响应不覆盖新选择的运行身份')
    selectDelays.clear()
  }
  {
    resetView()
    selectDelays.set('tray-b', 100)
    tray('tray-b')
    await sleep(10)
    tray('tray-c')
    await sleep(130)
    ok(useStore.getState().activeRunnerId === 'run-tray-c', '连续无路径托盘选择只采用最后的响应')
    selectDelays.clear()
  }

  {
    resetView()
    useStore.setState({ messages: [{ id: 'old-history', role: 'user', text: 'A' }], peekedPath: 'A', peekedSessionId: 'sess-a' })
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'tray-b', runId: 'run-tray-b', projectId: 'p', generation: 1 },
      payload: [{ id: 'tray-message', role: 'assistant', text: 'B' }]
    })
    tray('tray-b')
    await sleep(30)
    ok(useStore.getState().messages[0]?.id === 'tray-message', '托盘选择投影目标缓存而不是旧历史')
    ok(useStore.getState().peekedPath === null && useStore.getState().peekNote === null, '托盘选择清除旧历史的路径和截断提示')
  }

  /* 等一层微任务/定时器，确保没有残留回调，再把全局恢复回去 */
  await sleep(50)
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
}
