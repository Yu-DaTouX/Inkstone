#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0, groups: [] }
let currentGroup = null

function group(name) {
  currentGroup = { name, lines: [] }
  report.groups.push(currentGroup)
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const mark = pass ? '  ✓' : '  ✗'
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${mark} ${label}${extra}\n`)
  currentGroup?.lines.push({ pass, label })
  return pass
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function flush() {
  await sleep(0)
  await sleep(0)
}
async function waitFor(fn, timeout = 1000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) return false
    await sleep(1)
  }
  return true
}

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    try {
      fn(0)
    } catch {
    }
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { style: {}, clientWidth: 0, clientHeight: 0 },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
}

function defer() {
  let resolveFn
  const promise = new Promise((r) => {
    resolveFn = r
  })
  return { promise, resolve: resolveFn }
}

const SESSIONS = [
  { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' },
  { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' },
  { path: 'C', id: 'sess-c', cwd: 'C:/proj', scope: 'global', title: 'C' }
]

function makeYan() {
  const calls = { send: [], runBash: [], selectSession: [], peekSession: [], verifyFiles: [] }
  const pending = { send: null, verifyFiles: null, select: null, peek: null }
  const real = {
    send: async (text, images, mode) => {
      calls.send.push({ text, images, mode })
      if (pending.send) return await pending.send.promise
      return { ok: true }
    },
    runBash: async (command) => {
      calls.runBash.push(command)
      return { ok: true }
    },
    peekSession: async (path) => {
      calls.peekSession.push(path)
      if (pending.peek) await pending.peek.promise
      return { messages: [{ id: `msg-${path}`, role: 'user', text: path }], sessionId: `sess-${String(path).toLowerCase()}`, truncated: 0, total: 1 }
    },
    selectSession: async (target) => {
      calls.selectSession.push(target)
      if (pending.select) return await pending.select.promise
      return { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
    },
    sources: {
      verifyFiles: async (args) => {
        calls.verifyFiles.push(args)
        if (pending.verifyFiles) return await pending.verifyFiles.promise
        return []
      },
      addImage: async () => undefined
    },
    listRunners: async () => [],
    agentStatus: async () => ({ state: 'idle', detail: '' })
  }
  const yan = new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return async () => undefined
    }
  })
  return { yan, calls, pending }
}

function installWindow(yan) {
  globalThis.window = {
    yan,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }
}

async function buildBundles(outdir) {
  const storeEntry = join(outdir, 'store-entry.ts')
  await writeFile(
    storeEntry,
    `export { useStore } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'
export * as activation from '${posix(resolve(ROOT, 'src/renderer/src/state/session-activation'))}'
export { viewingSubmitSessionId, attachmentsAfterSubmit, runLocalCommandGuarded, localCommandNeedsActivatedTarget } from '${posix(resolve(ROOT, 'src/renderer/src/lib/v3-submit-ownership'))}'
export { submitComposerInput } from '${posix(resolve(ROOT, 'src/renderer/src/lib/composer-submit'))}'
`
  )
  const define = {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'process.env.NODE_ENV': '"production"'
  }
  const storeOut = join(outdir, 'store-bundle.mjs')
  await build({
    entryPoints: [storeEntry],
    outfile: storeOut,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: {
      ...define,
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })

  return { storeOut }
}

function resetStore(store, activation, overrides = {}) {
  store.setState({
    sessions: SESSIONS,
    settings: { cwd: 'C:/proj', projects: [] },
    session: null,
    messages: [],
    attachments: [],
    commands: [],
    conn: 'ready',
    peekedPath: null,
    peekedSessionId: null,
    pendingActivation: null,
    activeRunnerId: null,
    runners: [],
    sessionRuntimes: {},
    notices: [],
    pendingSourceLinks: [],
    editorInject: null,
    composerInsert: null,
    queueRestore: null,
    ...overrides
  })
}

async function main() {
  installGlobals()
  const { yan } = makeYan()
  installWindow(yan)

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-ownership-'))
  let storeBundle
  try {
    const built = await buildBundles(outdir)
    storeBundle = await import(pathToFileURL(built.storeOut).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { useStore, activation } = storeBundle

  if (!process.argv.includes('--session-actions-only')) {
  group('D4 切换在途：ensureActivated 拒绝发送，Composer 保留草稿')
  {
    const { yan: y1, calls, pending } = makeYan()
    globalThis.window.yan = y1
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }]
    })
    pending.peek = defer()
    const switching = useStore.getState().switchSession('A')
    ok(activation.isSessionSwitchInFlight(), 'switchSession 在首 await 前登记了「切换在途」')
    let allowedSettled = false
    const allowedPromise = useStore.getState().ensureActivated().then((value) => { allowedSettled = true; return value })
    const sendPromise = useStore.getState().send('会落错会话吗', undefined)
    await flush()
    ok(!allowedSettled, '切换在途 ensureActivated 等待切换结束，不提前放行')
    ok(calls.send.length === 0, '切换在途 yan.send 未被调用', calls.send.length)
    pending.peek.resolve()
    await switching
    await flush()
    await allowedPromise
    await sendPromise
    await flush()
    ok(!activation.isSessionSwitchInFlight(), '切换结束后闸门释放')
    ok((await useStore.getState().ensureActivated()) === true, '切换完成后正路径 ensureActivated 放行')
    pending.peek = null
  }

  group('D3 切换失败：视图回到 B，待激活目标仍是 B，不落到失败的 C')
  {
    const { yan: y2, calls, pending } = makeYan()
    globalThis.window.yan = y2
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }]
    })
    pending.select = defer()
    const openB = useStore.getState().switchSession('B')
    await flush()
    pending.select.resolve({ ok: true, deferred: true, sessionId: 'sess-b' })
    await openB
    await flush()
    ok(useStore.getState().pendingActivation?.sessionFile === 'B', 'B 只读打开后登记待激活目标', useStore.getState().pendingActivation)

    calls.selectSession.length = 0
    pending.select = defer()
    const openC = useStore.getState().switchSession('C')
    await flush()
    pending.select.resolve({ ok: false, error: 'cwd 校验失败' })
    await openC
    await flush()
    ok(useStore.getState().pendingActivation?.sessionFile === 'B', '切换失败后视图回到 B，待激活目标仍是 B', useStore.getState().pendingActivation)
    ok(useStore.getState().peekedSessionId === 'sess-b', '切换失败后视图身份是正在看的 B', useStore.getState().peekedSessionId)

    calls.selectSession.length = 0
    pending.select = defer()
    const activating = useStore.getState().ensureActivated()
    await flush()
    pending.select.resolve({ ok: true, sessionId: 'sess-b', runId: 'run-b' })
    ok((await activating) === true, '激活正在看的 B')
    ok(
      calls.selectSession.length === 1 && calls.selectSession[0].sessionFile === 'B' && !calls.selectSession.some((t) => t.sessionFile === 'C'),
      '激活落到 B，不落到切换失败的 C',
      calls.selectSession
    )
    pending.select = null
  }

  group('D6 collectSourceIds 等待期间切会话：不发消息、不登记错误 sourceLink')
  {
    const { yan: y5, calls, pending } = makeYan()
    globalThis.window.yan = y5
    const fileAttachment = { id: 'f1', name: 'x.txt', mimeType: '', size: 1, data: '', preview: '', kind: 'file', path: 'C:/x.txt' }

    resetStore(useStore, activation, {
      session: { sessionId: 'sess-b', cwd: 'C:/proj' },
      peekedSessionId: 'sess-b',
      activeRunnerId: null,
      attachments: [fileAttachment]
    })
    pending.verifyFiles = defer()
    const positive = useStore.getState().send('先发一条')
    await waitFor(() => calls.verifyFiles.length === 1)
    pending.verifyFiles.resolve([{ sourceId: 'file:C:/x.txt:1' }])
    const positiveOk = await positive
    await flush()
    ok(positiveOk === true, '正路径确实发出去了（不是「全都没发」）')
    ok(calls.send.length === 1, '正路径 yan.send 被真实调用一次', calls.send.length)
    ok(
      useStore.getState().pendingSourceLinks[0]?.sessionId === 'sess-b',
      '来源按「正在看的」会话 sess-b 登记，而不是旧 session',
      useStore.getState().pendingSourceLinks
    )
    ok(
      useStore.getState().pendingSourceLinks[0]?.sourceIds?.includes('file:C:/x.txt:1'),
      '来源 id 是本次附件复核出来的那个'
    )

    resetStore(useStore, activation, {
      session: { sessionId: 'sess-b', cwd: 'C:/proj' },
      peekedSessionId: 'sess-b',
      activeRunnerId: null,
      attachments: [fileAttachment]
    })
    calls.send.length = 0
    calls.verifyFiles.length = 0
    calls.selectSession.length = 0
    pending.verifyFiles = defer()
    const raced = useStore.getState().send('等待来源时切走')
    await waitFor(() => calls.verifyFiles.length === 1)
    useStore.setState({ peekedSessionId: 'sess-c' })
    pending.verifyFiles.resolve([{ sourceId: 'file:C:/x.txt:1' }])
    const racedOk = await raced
    await flush()
    ok(racedOk === false, '来源等待期间切走后 send 返回 false')
    ok(calls.send.length === 0, '切走后 yan.send 未被调用', calls.send.length)
    ok(useStore.getState().pendingSourceLinks.length === 0, '没有登记任何（错误会话的）sourceLink', useStore.getState().pendingSourceLinks)
    pending.verifyFiles = null
  }

  group('D5 setSessionDraft 显式键：读写的键由调用方指定，不再猜当前激活会话')
  {
    const { yan: y4 } = makeYan()
    globalThis.window.yan = y4
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }],
      sessionRuntimes: {
        'sess-a': { runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 }, messages: [] }
      }
    })
    useStore.getState().setSessionDraft('B 的草稿', 'sess-b')
    ok(useStore.getState().sessionRuntimes['sess-b']?.draft === 'B 的草稿', '显式键写入目标会话', useStore.getState().sessionRuntimes['sess-b'])
    ok(useStore.getState().sessionRuntimes['sess-a']?.draft === undefined, '不会误写到当前激活会话')
    useStore.getState().setSessionDraft('A 的草稿')
    ok(useStore.getState().sessionRuntimes['sess-a']?.draft === 'A 的草稿', '省略键时仍按 v2 语义写当前激活会话')
  }

  group('D2 runLocalCommandGuarded：激活失败不执行、不清文字；成功才执行')
  {
    const { yan: y6, calls } = makeYan()
    globalThis.window.yan = y6
    const { runLocalCommandGuarded, localCommandNeedsActivatedTarget } = storeBundle
    ok(localCommandNeedsActivatedTarget('!git status'), '`!` 被判定为需要先激活实例')
    ok(localCommandNeedsActivatedTarget('/model gpt'), '`/model` 被判定为需要先激活实例')
    ok(!localCommandNeedsActivatedTarget('/settings'), '`/settings` 不受切换状态阻塞')

    let ran = 0
    let blocked = 0
    const outcome = await runLocalCommandGuarded({
      raw: '!git status',
      ensureActivated: async () => false,
      run: async () => {
        ran += 1
      },
      notifyBlocked: () => {
        blocked += 1
      }
    })
    ok(outcome === 'blocked' && ran === 0 && blocked === 1, '激活失败：不调用 run，并给出阻断提示', { outcome, ran, blocked })

    const outcome2 = await runLocalCommandGuarded({
      raw: '/settings',
      ensureActivated: async () => false,
      run: async () => {
        ran += 1
      },
      notifyBlocked: () => {
        blocked += 1
      }
    })
    ok(outcome2 === 'ran' && ran === 1, '纯界面命令不受激活状态影响，照常执行', { outcome2, ran })
  }

  }

  group('R04/R05 预览会话设置和导出捕获目标，等待期间切走则取消')
  {
    const { yan: scoped } = makeYan()
    globalThis.window.yan = scoped
    const writes = []
    const b = { id: 'run-b', runId: 'run-b', sessionId: 'sess-b', generation: 5, sessionFile: 'B', cwd: 'C:/proj', isActive: true }
    scoped.runnerStatuses = async () => [b]
    scoped.listModels = async () => []
    scoped.listCommands = async () => []
    scoped.selectSession = async () => ({ ok: true, ...b })
    for (const name of ['setModel', 'setThinking', 'setUltracode', 'exportHtml', 'cycleModel', 'cycleModelBack', 'cycleThinking']) scoped[name] = async (...args) => { writes.push({ name, args }); return { ok: true, path: 'B.html' } }
    let preferences = 0
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' }, peekedPath: 'B', peekedSessionId: 'sess-b', activeRunnerId: 'run-a',
      runners: [{ id: 'run-a', runId: 'run-a', sessionId: 'sess-a', generation: 2 }],
      pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj' },
      patchSettings: async () => { preferences++ }
    })
    const firstModel = await useStore.getState().setModel('fixture', 'model-b')
    await useStore.getState().setThinking('high')
    await useStore.getState().setUltracode(true)
    await useStore.getState().exportHtml('B.html')
    await useStore.getState().cycleModel()
    await useStore.getState().cycleModelBack()
    await useStore.getState().cycleThinking()
    ok(writes.length === 7, '模型、思考、深度模式、导出和快捷键正路径都执行', { writes, firstModel, identity: useStore.getState().peekedSessionId, pending: useStore.getState().pendingActivation })
    ok(writes.every(item => { const owner = item.args.at(-1); return owner.sessionId === 'sess-b' && owner.runId === 'run-b' && owner.generation === 5 }), '所有 IPC 携带 B 的运行身份与代次', writes)
    ok(preferences === 1, '成功的模型选择保存偏好一次', preferences)

    for (const name of ['setModel', 'setThinking', 'setUltracode', 'exportHtml', 'cycleModel', 'cycleModelBack', 'cycleThinking']) {
      writes.length = 0
      useStore.setState({ peekedSessionId: 'sess-b', peekedPath: 'B', pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj' } })
      scoped.selectSession = async () => ({ ok: true, deferred: true, sessionId: 'sess-b' })
      const args = name === 'setModel' ? ['fixture', 'model-b'] : name === 'setThinking' ? ['high'] : name === 'setUltracode' ? [true] : name === 'exportHtml' ? ['B.html'] : []
      await useStore.getState()[name](...args)
      ok(writes.length === 0, `${name} 激活未完成时不会写 A`)
    }

    scoped.selectSession = async () => ({ ok: true, ...b })
    useStore.setState({ pendingActivation: null, peekedSessionId: 'sess-b', peekedPath: 'B' })
    const waiting = defer()
    let listing = false
    scoped.runnerStatuses = async () => { listing = true; return waiting.promise }
    const raced = useStore.getState().exportHtml('B.html')
    await waitFor(() => listing)
    useStore.setState({ peekedSessionId: 'sess-c', peekedPath: 'C' })
    waiting.resolve([b])
    await raced
    ok(writes.length === 0, '等待运行列表期间切走不会导出 A 或 C')

    scoped.runnerStatuses = async () => [b]
    useStore.setState({ peekedSessionId: 'sess-b', peekedPath: 'B' })
    const modelWait = defer()
    let changing = false
    scoped.setModel = async () => { changing = true; return modelWait.promise }
    const changingModel = useStore.getState().setModel('fixture', 'later')
    await waitFor(() => changing)
    useStore.setState({ peekedSessionId: 'sess-c', peekedPath: 'C' })
    modelWait.resolve({ ok: true })
    const changed = await changingModel
    ok(changed.ok === false && preferences === 1, '模型响应返回前切走，不把旧结果保存为新视图的默认偏好')

    let exportRan = false
    await storeBundle.runLocalCommandGuarded({ raw: '/export B.html', ensureActivated: async () => false, run: () => { exportRan = true }, notifyBlocked() {} })
    ok(!exportRan, '/export 本地命令受目标激活检查保护')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
