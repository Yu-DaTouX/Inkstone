/**
 * 会话级提问频率覆盖（四态 inherit / sparse / balanced / eager）的定向单测。
 *
 * 钉住五件事：
 *   ① 真实 `WorkModeStore` 的持久化：显式值落盘并在重载后保留，`inherit` 对新会话
 *      不落盘；`setMode` 不抹频率、`setQuestionFrequency` 不抹模式，并发提交不互相覆盖；
 *      旧记录缺字段 / 脏值归 `inherit`；`pending` → 稳定键迁移整条搬走；revision CAS。
 *   ② 逐轮快照：`writeWorkModeSnapshot` 写频率，`inherit` 也写（擦掉上一轮显式残留）。
 *   ③ 内置扩展 `question.js`：显式会话偏好覆盖全局、`inherit` 每轮回落全局、
 *      快照缺失回落全局、工作模式（自主）优先、轮间热更新。
 *   ④ 真实 IPC 适配 `question-frequency-ipc.ts`：身份（runner + sessionId）+ revision
 *      校验；持久化前后核对归属，切会话期间的迟到请求不写 B。
 *   ⑤ 扩展与 shared 的四态列表 / 归一化一致。
 *
 * 用隔离的 `YAN_DATA_DIR` 临时 fixture，不碰真实数据目录，不需要构建、Electron 或真实模型。
 * 可直接运行 `node scripts/test-question-frequency-session.mjs`，也导出
 * `runQuestionFrequencySessionTests(ok)` 供后续接线；import 本模块不产生副作用。
 */
/* ------------------------------------------------------------------ 最小 React hook harness */

function qfDepsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

/** 只实现 picker 用到的那几个 hook，按调用顺序存 slot；无 jsdom、无 Electron。 */
function createQfHarness(component, initialStore) {
  const slots = []
  let cursor = 0
  let scheduled = false
  let tree = null

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      /* 测试换掉 harness 后，迟到的重渲染不能再读已删除的全局 store */
      if (globalThis.__qfPickerHarness !== runtime) return
      renderNow()
    })
  }

  function renderNow() {
    cursor = 0
    tree = component()
    for (const slot of slots) {
      if (!slot || slot.kind !== 'effect' || !slot.pending) continue
      slot.pending = false
      if (typeof slot.cleanup === 'function') {
        try { slot.cleanup() } catch { /* ignore */ }
      }
      const cleanup = slot.effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  const runtime = {
    store: initialStore,
    setStore(next) {
      runtime.store = typeof next === 'function' ? next(runtime.store) : next
      schedule()
    },
    renderNow,
    get tree() { return tree },
    useState(init) {
      const i = cursor++
      let slot = slots[i]
      if (!slot || slot.kind !== 'state') { slot = { kind: 'state', value: typeof init === 'function' ? init() : init }; slots[i] = slot }
      return [slot.value, (v) => {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (Object.is(next, slot.value)) return
        slot.value = next
        schedule()
      }]
    },
    useRef(init) {
      const i = cursor++
      let slot = slots[i]
      if (!slot || slot.kind !== 'ref') { slot = { kind: 'ref', ref: { current: init } }; slots[i] = slot }
      return slot.ref
    },
    useCallback(fn, deps) {
      const i = cursor++
      let slot = slots[i]
      if (!slot || slot.kind !== 'callback' || !qfDepsEqual(slot.deps, deps)) { slot = { kind: 'callback', fn, deps }; slots[i] = slot }
      return slot.fn
    },
    useMemo(fn, deps) {
      const i = cursor++
      let slot = slots[i]
      if (!slot || slot.kind !== 'memo' || !qfDepsEqual(slot.deps, deps)) { slot = { kind: 'memo', value: fn(), deps }; slots[i] = slot }
      return slot.value
    },
    useEffect(fn, deps) {
      const i = cursor++
      const slot = slots[i]
      if (!slot || slot.kind !== 'effect') { slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: undefined } }
      else if (!qfDepsEqual(slot.deps, deps)) { slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: slot.cleanup } }
      else { slot.pending = false }
    },
    createElement(type, props, key) {
      const merged = { ...(props || {}) }
      if (key !== undefined) merged.key = key
      /* JSX 自动运行时传的是组件函数；存下名字便于断言按 type 查找 */
      const name = typeof type === 'function' ? (type.displayName ?? type.name ?? 'Anonymous') : type
      return { __el: true, type: name, props: merged }
    }
  }
  return runtime
}

/** 展开 hook harness 产出的最小元素树。 */
function qfElements(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const n of node) qfElements(n, out); return out }
  if (typeof node === 'object' && node.__el) {
    out.push(node)
    qfElements(node.props?.children, out)
  }
  return out
}

const QF_COMPONENT_FIXTURES = {
  react: `
const rt = () => globalThis.__qfPickerHarness
export const useState = (...a) => rt().useState(...a)
export const useRef = (...a) => rt().useRef(...a)
export const useCallback = (...a) => rt().useCallback(...a)
export const useEffect = (...a) => rt().useEffect(...a)
export const useMemo = (...a) => rt().useMemo(...a)
export const useLayoutEffect = (...a) => rt().useEffect(...a)
`,
  'jsx-runtime': `
const rt = () => globalThis.__qfPickerHarness
export const Fragment = Symbol.for('qf.Fragment')
export const jsx = (type, props, key) => rt().createElement(type, props, key)
export const jsxs = jsx
export const jsxDEV = jsx
`,
  store: `export const useStore = (selector) => selector(globalThis.__qfPickerHarness.store)`,
  i18n: `export const useT = () => (key) => key`,
  ui: `export const Segmented = (props) => ({ __el: true, type: 'Segmented', props: props || {} })`
}

/** 真跑 `SessionQuestionFrequencyPicker`：把 React / store / i18n / ui 替身塞进组件 bundle。 */
async function loadQuestionFrequencyComponent(build, buildDir, pathToFileURL, join) {
  const outfile = join(buildDir, 'session-question-frequency-picker.mjs')
  await build({
    entryPoints: ['src/renderer/src/components/SessionQuestionFrequencyPicker.tsx'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [{
      name: 'qf-component-fixtures',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'qf-component' }))
        b.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'qf-component' }))
        for (const [filter, name] of [
          [/state\/store$/, 'store'],
          [/\/i18n$/, 'i18n'],
          [/\/ui$/, 'ui']
        ]) b.onResolve({ filter }, () => ({ path: name, namespace: 'qf-component' }))
        b.onLoad({ filter: /.*/, namespace: 'qf-component' }, (args) => ({ contents: QF_COMPONENT_FIXTURES[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

export async function runQuestionFrequencySessionTests(ok) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const { transform, build } = await import('esbuild')

  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'yan-qf-session-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'yan-qf-session-build-'))
  const previous = {
    YAN_DATA_DIR: process.env.YAN_DATA_DIR,
    YAN_PI_DIR: process.env.YAN_PI_DIR,
    YAN_SESSION_ID: process.env.YAN_SESSION_ID
  }
  process.env.YAN_DATA_DIR = root
  process.env.YAN_PI_DIR = join(root, 'pi')
  process.env.YAN_SESSION_ID = 'qf-runner-A'
  mkdirSync(process.env.YAN_PI_DIR, { recursive: true })

  const restoreEnv = () => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }

  try {
    /* ---- 与 shared 的四态纯逻辑对照（同一份列表与归一化） ---- */
    const sharedSource = await readFile(new URL('../src/shared/question-frequency.ts', import.meta.url), 'utf8')
    const transformed = await transform(sharedSource, { loader: 'ts', format: 'esm' })
    const shared = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`)

    const ext = await import('../resources/pi-extensions/question.js')
    const { default: extension, QUESTION_FREQUENCIES, SESSION_QUESTION_FREQUENCIES, DEFAULT_SESSION_QUESTION_FREQUENCY, normalizeSessionQuestionFrequency, resolveQuestionFrequency } = ext
    const workModeExt = await import('../resources/pi-extensions/work-mode.js')

    ok(
      JSON.stringify(SESSION_QUESTION_FREQUENCIES) === JSON.stringify(shared.SESSION_QUESTION_FREQUENCIES),
      'ext/shared：会话四态列表一致',
      JSON.stringify(SESSION_QUESTION_FREQUENCIES)
    )
    ok(
      DEFAULT_SESSION_QUESTION_FREQUENCY === shared.DEFAULT_SESSION_QUESTION_FREQUENCY &&
        DEFAULT_SESSION_QUESTION_FREQUENCY === 'inherit',
      'ext/shared：会话默认都是 inherit'
    )
    for (const value of [undefined, null, 0, '', 'inherit', 'sparse', 'balanced', 'eager', 'loud', {}, []]) {
      const a = normalizeSessionQuestionFrequency(value)
      const b = shared.normalizeSessionQuestionFrequency(value)
      ok(a === b, `ext/shared：会话值归一化一致（${JSON.stringify(value)}）`, `${a} vs ${b}`)
    }
    for (const [session, global, expected] of [
      ['inherit', 'sparse', 'sparse'],
      ['inherit', 'eager', 'eager'],
      ['inherit', 'loud', 'balanced'],
      ['balanced', 'eager', 'balanced'],
      ['eager', 'sparse', 'eager'],
      [undefined, undefined, 'balanced'],
      ['loud', 'eager', 'eager']
    ]) {
      const a = resolveQuestionFrequency(session, global)
      const b = shared.resolveQuestionFrequency(session, global)
      ok(
        a === b && a === expected,
        `ext/shared：resolve(${JSON.stringify(session)}, ${JSON.stringify(global)}) 一致`,
        `${a} vs ${b}`
      )
    }

    /* ---- 打包真实 store + IPC 适配 + goal-coordinator producer（同一条 import 图） ---- */
    const entry = join(buildDir, 'entry.ts')
    const storePath = fileURLToPath(new URL('../src/main/work-mode-service.ts', import.meta.url)).replace(/\\/g, '/')
    const ipcPath = fileURLToPath(new URL('../src/main/ipc/question-frequency-ipc.ts', import.meta.url)).replace(/\\/g, '/')
    const goalPath = fileURLToPath(new URL('../src/main/goal-coordinator.ts', import.meta.url)).replace(/\\/g, '/')
    const targetPath = fileURLToPath(new URL('../src/renderer/src/state/question-frequency-target.ts', import.meta.url)).replace(/\\/g, '/')
    const goalIpcPath = fileURLToPath(new URL('../src/main/ipc/goal-ipc.ts', import.meta.url)).replace(/\\/g, '/')
    const handoffPath = fileURLToPath(new URL('../src/main/handoff-coordinator.ts', import.meta.url)).replace(/\\/g, '/')
    writeFileSync(entry, `export * from ${JSON.stringify(storePath)}\nexport * from ${JSON.stringify(ipcPath)}\nexport * from ${JSON.stringify(goalPath)}\nexport * from ${JSON.stringify(targetPath)}\nexport * from ${JSON.stringify(goalIpcPath)}\nexport * from ${JSON.stringify(handoffPath)}\n`)
    const outfile = join(buildDir, 'bundle.mjs')
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      /*
       * 给 `work-mode-service` 的模块绑定包一层钩子：生产 writer（question-frequency-ipc、
       * goal-ipc、goal-coordinator、handoff-coordinator）都从这里取快照读写，测试无法从
       * 外部替换；这层包裹只在 await 前后调用可选钩子，用来模拟「读取期间 / 写入关键段 /
       * 保存后实例被复用」。`resolveDir` 指向 `src/main`，stub 自己的 import 跳过钩子。
       */
      plugins: [{
        name: 'qf-snapshot-hooks',
        setup(b) {
          b.onResolve({ filter: /(^|\/)\.\.?\/work-mode-service$/ }, (args) => {
            if (args.namespace === 'qf-hook') return undefined
            return { path: 'hook', namespace: 'qf-hook' }
          })
          b.onLoad({ filter: /.*/, namespace: 'qf-hook' }, () => ({
            resolveDir: dirname(storePath),
            contents: `
export * from './work-mode-service'
export async function readWorkModeSnapshot(...args) {
  const hooks = globalThis.__qfHooks
  if (hooks && hooks.beforeRead) await hooks.beforeRead()
  const out = await real.readWorkModeSnapshot(...args)
  if (hooks && hooks.afterRead) await hooks.afterRead()
  return out
}
export async function writeWorkModeSnapshot(...args) {
  const hooks = globalThis.__qfHooks
  if (hooks && hooks.beforeWrite) await hooks.beforeWrite()
  const out = await real.writeWorkModeSnapshot(...args)
  if (hooks && hooks.afterWrite) await hooks.afterWrite()
  return out
}
import * as real from './work-mode-service'
`,
            loader: 'js'
          }))
        }
      }, {
        /* handoff-coordinator 经 settings.ts 静态 import 'electron'；测试里给一个最小 app 桩。 */
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qf-electron' }))
          b.onLoad({ filter: /.*/, namespace: 'qf-electron' }, () => ({
            contents: "export const app = { getLocale: () => 'en-US', getPath: () => '' }",
            loader: 'js'
          }))
        }
      }]
    })
    const bundle = await import(pathToFileURL(outfile).href)
    const {
      WorkModeStore,
      workModeDocumentPath,
      normalizeSessionFileKey,
      writeWorkModeSnapshot,
      readWorkModeSnapshot,
      registerQuestionFrequencyIpc,
      registerGoalIpc,
      configureGoalCoordinator,
      configureHandoffCoordinator,
      inheritForHandoff,
      pushWorkMode,
      sessionQuestionFrequencyTarget
    } = bundle
    ok(typeof WorkModeStore === 'function' && typeof registerQuestionFrequencyIpc === 'function', '打包：store 与 IPC 适配可用')
    ok(typeof pushWorkMode === 'function' && typeof configureGoalCoordinator === 'function', '打包：goal-coordinator producer 可用')
    ok(typeof registerGoalIpc === 'function' && typeof inheritForHandoff === 'function', '打包：goal-ipc 与 handoff 目的段 writer 可用')
    ok(typeof sessionQuestionFrequencyTarget === 'function', '打包：会话频率目标选择器可用')

    /* 真实 store + IPC 的隔离夹具（快照走 YAN_DIR，store 走独立临时目录）。 */
    const makeIpcFixture = async (runnerId = 'runner-A') => {
      const ipcRoot = mkdtempSync(join(tmpdir(), 'yan-qf-ipc-'))
      const store = new WorkModeStore({ root: ipcRoot })
      await store.load()
      const runnerState = { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }
      const registry = {
        activeRunner: () => ({ id: runnerId }),
        agentOf: (id) => (id === runnerId ? { getState: () => ({ ...runnerState }) } : undefined),
        runtimeOf: (id) => (id === runnerId ? { sessionId: runnerState.sessionId, runId: runnerId, generation: 1 } : null)
      }
      const workModeKeyFor = (id) => normalizeSessionFileKey(registry.agentOf(id)?.getState()?.sessionFile) ?? `pending:${id}`
      const pushes = []
      let globalFn = async () => 'balanced'
      const handlers = {}
      registerQuestionFrequencyIpc(
        { handle: (channel, fn) => (handlers[channel] = fn), rawHandle: () => {} },
        {
          registry: () => registry,
          workModes: store,
          workModeKeyFor,
          globalQuestionFrequency: () => globalFn(),
          pushFrom: (id, msg) => pushes.push({ id, ...msg })
        }
      )
      return {
        runnerId,
        ipcRoot,
        store,
        runnerState,
        registry,
        workModeKeyFor,
        pushes,
        setGlobal: (fn) => {
          globalFn = fn
        },
        get: handlers['yan:getSessionQuestionFrequency'],
        set: handlers['yan:setSessionQuestionFrequency'],
        rm: () => rmSync(ipcRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }

    /*
     * 生产路径同图：同一个 store + registry 同时接 IPC 与 goal-coordinator producer。
     * 用来验证「pending → 稳定文件」的迁移是真的接了生产，而不是只测 store.adopt。
     */
    const makeProducerFixture = async (runnerId, initialSession, globalFrequency = 'balanced') => {
      const prodRoot = mkdtempSync(join(tmpdir(), 'yan-qf-prod-'))
      const store = new WorkModeStore({ root: prodRoot })
      await store.load()
      const session = { ...initialSession }
      const registry = {
        activeRunner: () => ({ id: runnerId }),
        agentOf: (id) => (id === runnerId ? { getState: () => ({ ...session }) } : undefined),
        runtimeOf: (id) => (id === runnerId ? { sessionId: session.sessionId, runId: runnerId, generation: 1 } : null)
      }
      const workModeKeyFor = (id) => normalizeSessionFileKey(registry.agentOf(id)?.getState()?.sessionFile) ?? `pending:${id}`
      const pushes = []
      const handlers = {}
      registerQuestionFrequencyIpc(
        { handle: (channel, fn) => (handlers[channel] = fn), rawHandle: () => {} },
        {
          registry: () => registry,
          workModes: store,
          workModeKeyFor,
          globalQuestionFrequency: async () => globalFrequency,
          pushFrom: (id, msg) => pushes.push({ id, ...msg })
        }
      )
      configureGoalCoordinator({
        runners: () => registry,
        workModes: store,
        pushFrom: (id, msg) => pushes.push({ id, ...msg })
      })
      return {
        runnerId,
        store,
        session,
        workModeKeyFor,
        pushes,
        get: handlers['yan:getSessionQuestionFrequency'],
        set: handlers['yan:setSessionQuestionFrequency'],
        rm: () => rmSync(prodRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    }

    /* ================================ ① store 持久化 ================================ */
    {
      const keyA = 'C:/sessions/A.jsonl'
      const store = new WorkModeStore({ root })
      await store.load()

      const inheritNew = await store.setQuestionFrequency(keyA, 'inherit')
      ok(
        inheritNew.ok && inheritNew.state.questionFrequency === 'inherit' && inheritNew.state.revision === 0,
        'store：新会话设 inherit 不落盘（revision 0）',
        JSON.stringify(inheritNew.state)
      )
      ok(!store.snapshot().entries[keyA], 'store：新会话 inherit 不产生记录')

      const eager = await store.setQuestionFrequency(keyA, 'eager')
      ok(
        eager.ok && eager.state.questionFrequency === 'eager' && eager.state.revision === 1,
        'store：显式 eager 落盘 revision=1',
        JSON.stringify(eager.state)
      )

      const modeSet = await store.set(keyA, 'autonomous')
      ok(
        modeSet.ok && modeSet.state.mode === 'autonomous' && modeSet.state.questionFrequency === 'eager',
        'store：setMode 不抹会话频率',
        JSON.stringify(modeSet.state)
      )

      const sparse = await store.setQuestionFrequency(keyA, 'sparse')
      ok(
        sparse.ok && sparse.state.mode === 'autonomous' && sparse.state.questionFrequency === 'sparse' &&
          sparse.state.revision === modeSet.state.revision + 1,
        'store：setQuestionFrequency 不抹模式且 revision 递增',
        JSON.stringify(sparse.state)
      )

      const stale = await store.setQuestionFrequency(keyA, 'balanced', 0)
      ok(
        !stale.ok && stale.error === 'version-mismatch' && stale.state.questionFrequency === 'sparse',
        'store：revision 冲突不写并回传当前值',
        JSON.stringify(stale)
      )

      const reloaded = new WorkModeStore({ root })
      await reloaded.load()
      const persisted = reloaded.state(keyA)
      ok(
        persisted.mode === 'autonomous' && persisted.questionFrequency === 'sparse' &&
          persisted.revision === sparse.state.revision,
        'store：重载后保留模式与频率',
        JSON.stringify(persisted)
      )

      /* 并发提交（都不带 revision）不能互相覆盖字段 */
      const keyB = 'C:/sessions/B.jsonl'
      await store.set(keyB, 'standard')
      await Promise.all([store.set(keyB, 'autonomous'), store.setQuestionFrequency(keyB, 'eager')])
      const both = store.state(keyB)
      ok(
        both.mode === 'autonomous' && both.questionFrequency === 'eager',
        'store：并发 setMode / setQuestionFrequency 字段不互覆盖',
        JSON.stringify(both)
      )

      /* 非法偏好归一为 inherit（并清掉旧显式档） */
      const bad = await store.setQuestionFrequency(keyB, 'loud')
      ok(
        bad.ok && bad.state.questionFrequency === 'inherit' && bad.state.mode === 'autonomous',
        'store：非法值归 inherit 且模式保留',
        JSON.stringify(bad.state)
      )
    }

    /* 旧记录兼容：缺字段 / 脏字段 → inherit */
    {
      const legacyRoot = mkdtempSync(join(tmpdir(), 'yan-qf-legacy-'))
      writeFileSync(
        workModeDocumentPath(legacyRoot),
        JSON.stringify({
          version: 1,
          entries: {
            'C:/sessions/old.jsonl': { mode: 'standard', revision: 3, updatedAt: 1 },
            'C:/sessions/dirty.jsonl': { mode: 'clarify', revision: 2, updatedAt: 1, questionFrequency: 'loud' }
          }
        }),
        'utf8'
      )
      const legacy = new WorkModeStore({ root: legacyRoot })
      await legacy.load()
      ok(legacy.state('C:/sessions/old.jsonl').questionFrequency === 'inherit', '旧记录：缺字段归 inherit')
      ok(legacy.state('C:/sessions/dirty.jsonl').questionFrequency === 'inherit', '旧记录：脏字段归 inherit')
      ok(legacy.state('C:/sessions/old.jsonl').mode === 'standard', '旧记录：模式仍可读')
      rmSync(legacyRoot, { recursive: true, force: true })
    }

    /* pending → 稳定键迁移整条搬走（频率跟着走） */
    {
      const adoptRoot = mkdtempSync(join(tmpdir(), 'yan-qf-adopt-'))
      const adoptStore = new WorkModeStore({ root: adoptRoot })
      await adoptStore.load()
      await adoptStore.setQuestionFrequency('pending:r1', 'eager')
      await adoptStore.set('pending:r1', 'clarify')
      await adoptStore.adopt('pending:r1', 'C:/sessions/C.jsonl')
      const adopted = adoptStore.state('C:/sessions/C.jsonl')
      ok(
        adopted.questionFrequency === 'eager' && adopted.mode === 'clarify' && !adoptStore.snapshot().entries['pending:r1'],
        'adopt：pending 迁移保留频率且不共享旧键',
        JSON.stringify(adopted)
      )
      rmSync(adoptRoot, { recursive: true, force: true })
    }

    /* ==================== ①c F06：生产路径 pending → 稳定文件的安全迁移 ==================== */
    {
      /* 同实例 pending 阶段设显式档，文件出现后由 producer 迁移到稳定键 */
      const h = await makeProducerFixture('runner-P', { sessionId: 'sid-P' })
      let res = await h.set({ runnerId: 'runner-P', sessionId: 'sid-P', expectedRevision: 0, questionFrequency: 'eager' })
      ok(res.ok && res.preference === 'eager', 'F06：pending 阶段可设显式频率', JSON.stringify(res))
      const pendingEntry = h.store.snapshot().entries['pending:runner-P']
      ok(pendingEntry?.questionFrequency === 'eager', 'F06：pending 键落盘', JSON.stringify(pendingEntry))
      ok(pendingEntry?.owner === 'sid-P', 'F06：pending 记录带源会话归属', JSON.stringify(pendingEntry))

      h.session.sessionFile = 'C:/sessions/P.jsonl'
      await pushWorkMode('runner-P')
      const stable = h.store.state('C:/sessions/P.jsonl')
      ok(
        stable.questionFrequency === 'eager' && stable.revision === 1 && stable.mode === 'standard',
        'F06：文件出现后 pending 覆盖整条迁移到稳定键（revision / mode 保留）',
        JSON.stringify(stable)
      )
      ok(!h.store.snapshot().entries['pending:runner-P'], 'F06：迁移后旧 pending 键不残留')
      const view = await h.get('runner-P')
      ok(
        view.ok && view.preference === 'eager' && view.key === 'C:/sessions/P.jsonl',
        'F06：查询也走稳定键读到迁移后的值',
        JSON.stringify(view)
      )
      h.rm()
    }
    {
      /* 归属不符（runner 被复用给别的会话）：不迁移，新会话安全 inherit */
      const h = await makeProducerFixture('runner-Q', { sessionId: 'sid-NEW' })
      await h.store.setQuestionFrequency('pending:runner-Q', 'eager', undefined, 'sid-OLD')
      h.session.sessionFile = 'C:/sessions/Q.jsonl'
      await pushWorkMode('runner-Q')
      const stable = h.store.state('C:/sessions/Q.jsonl')
      ok(
        stable.questionFrequency === 'inherit' && stable.revision === 0,
        'F06：归属不符不迁移（B 安全回落 inherit）',
        JSON.stringify(stable)
      )
      ok(
        h.store.snapshot().entries['pending:runner-Q']?.questionFrequency === 'eager',
        'F06：归属不符时旧 pending 保留但不被冒认'
      )
      h.rm()
    }
    {
      /* 旧记录没有 owner：未知归属 → 安全 inherit，不盲搬 */
      const h = await makeProducerFixture('runner-R', { sessionId: 'sid-R' })
      await h.store.setQuestionFrequency('pending:runner-R', 'sparse')
      h.session.sessionFile = 'C:/sessions/R.jsonl'
      await pushWorkMode('runner-R')
      ok(
        h.store.state('C:/sessions/R.jsonl').questionFrequency === 'inherit',
        'F06：未知归属（无 owner 旧记录）不冒认，安全 inherit'
      )
      h.rm()
    }
    {
      /* 迁移 / set 都不丢字段：mode 与频率正交 */
      const h = await makeProducerFixture('runner-S', { sessionId: 'sid-S' })
      await h.set({ runnerId: 'runner-S', sessionId: 'sid-S', expectedRevision: 0, questionFrequency: 'sparse' })
      await h.store.set('pending:runner-S', 'autonomous', undefined, 'sid-S')
      h.session.sessionFile = 'C:/sessions/S.jsonl'
      await pushWorkMode('runner-S')
      const st = h.store.state('C:/sessions/S.jsonl')
      ok(
        st.mode === 'autonomous' && st.questionFrequency === 'sparse',
        'F06：迁移整条记录时 mode / 频率两个字段都不丢',
        JSON.stringify(st)
      )
      h.rm()
    }

    /* ================================ ② 逐轮快照 ================================ */
    {
      const snapRoot = mkdtempSync(join(tmpdir(), 'yan-qf-snap-'))
      await writeWorkModeSnapshot('r1', { mode: 'standard', revision: 2, questionFrequency: 'eager' }, snapRoot)
      const snap1 = await readWorkModeSnapshot('r1', snapRoot)
      ok(snap1 && snap1.questionFrequency === 'eager', '快照：显式频率写入', JSON.stringify(snap1))
      await writeWorkModeSnapshot('r1', { mode: 'standard', revision: 3 }, snapRoot)
      const snap2 = await readWorkModeSnapshot('r1', snapRoot)
      ok(snap2 && snap2.questionFrequency === 'inherit', '快照：缺字段（切回继承）清掉旧显式档', JSON.stringify(snap2))
      const raw = JSON.parse(readFileSync(join(snapRoot, 'work-mode', 'r1.json'), 'utf8'))
      ok(raw.questionFrequency === 'inherit' && raw.mode === 'standard', '快照：文件里确实写的是 inherit')
      rmSync(snapRoot, { recursive: true, force: true })
    }

    /* ================================ ③ 扩展逐轮读取 ================================ */
    {
      const desktop = join(root, 'desktop.json')
      const handlers = {}
      extension({ on: (name, fn) => (handlers[name] = fn) })
      ok(typeof handlers.before_agent_start === 'function', '扩展：注册了 before_agent_start')

      const turn = () => {
        const event = { systemPrompt: 'BASE', systemPromptOptions: { sections: {} } }
        const out = handlers.before_agent_start(event)
        return { prompt: String(out.systemPrompt ?? ''), extra: event.systemPromptOptions.sections.inkstone_question }
      }
      const setGlobal = (value) => writeFileSync(desktop, JSON.stringify({ questionFrequency: value }), 'utf8')
      const setSession = (preference) =>
        writeWorkModeSnapshot('qf-runner-A', { mode: 'standard', revision: 7, questionFrequency: preference }, root)

      setGlobal('sparse')
      await setSession('eager')
      let t = turn()
      ok(t.prompt.includes('Question frequency: EAGER') && !t.prompt.includes('SPARSE'), '扩展：显式会话偏好覆盖全局')
      ok(t.extra.includes('Question frequency: EAGER'), '扩展：具名分区也拿到会话偏好')

      await setSession('inherit')
      t = turn()
      ok(t.prompt.includes('Question frequency: SPARSE'), '扩展：inherit 回落全局')

      setGlobal('eager')
      t = turn()
      ok(t.prompt.includes('Question frequency: EAGER'), '扩展：inherit 每轮重读全局')

      rmSync(join(root, 'work-mode', 'qf-runner-A.json'), { force: true })
      t = turn()
      ok(t.prompt.includes('Question frequency: EAGER'), '扩展：快照缺失回落全局')

      setGlobal('loud')
      t = turn()
      ok(t.prompt.includes('Question frequency: BALANCED'), '扩展：全局脏值归适中')

      /* 自主模式优先：不叠加频率 */
      await writeWorkModeSnapshot('qf-runner-A', { mode: 'autonomous', revision: 9, questionFrequency: 'eager' }, root)
      setGlobal('eager')
      t = turn()
      ok(t.prompt.includes('Do NOT ask the user questions'), '扩展：自主模式仍然不问')
      ok(!t.prompt.includes('Question frequency:'), '扩展：自主模式不叠加频率指引')

      /* 归属校验：快照属于 A，ctx 是 B（runner 被复用给别的会话）→ 忽略，不落旧 A 偏好 */
      const turnCtx = (ctx) => {
        const event = { systemPrompt: 'BASE', systemPromptOptions: { sections: {} } }
        const out = handlers.before_agent_start(event, ctx)
        return String(out.systemPrompt ?? '')
      }
      await writeWorkModeSnapshot(
        'qf-runner-A',
        { mode: 'standard', revision: 4, questionFrequency: 'eager' },
        root,
        { owner: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' } }
      )
      setGlobal('sparse')
      const ctxA = { sessionManager: { getSessionId: () => 'sid-A', getSessionFile: () => 'C:/sessions/A.jsonl' } }
      const ctxB = { sessionManager: { getSessionId: () => 'sid-B', getSessionFile: () => 'C:/sessions/B.jsonl' } }
      ok(turnCtx(ctxA).includes('Question frequency: EAGER'), '扩展：归属匹配时用会话快照')
      const bPrompt = turnCtx(ctxB)
      ok(
        bPrompt.includes('Question frequency: SPARSE') && !bPrompt.includes('Question frequency: EAGER'),
        '扩展：归属不符（runner 复用）回落全局，不把旧 A 偏好带进 B'
      )
    }

    /* ================================ ④ IPC 适配 ================================ */
    {
      const ipcRoot = mkdtempSync(join(tmpdir(), 'yan-qf-ipc-'))
      const store = new WorkModeStore({ root: ipcRoot })
      await store.load()

      const runnerState = { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }
      const registry = {
        activeRunner: () => ({ id: 'runner-A' }),
        agentOf: (id) => (id === 'runner-A' ? { getState: () => ({ ...runnerState }) } : undefined)
      }
      const pushes = []
      let globalFrequency = 'balanced'
      const workModeKeyFor = (id) => normalizeSessionFileKey(registry.agentOf(id)?.getState()?.sessionFile) ?? `pending:${id}`

      const handlers = {}
      const ipc = { handle: (channel, fn) => (handlers[channel] = fn), rawHandle: () => {} }
      registerQuestionFrequencyIpc(ipc, {
        registry: () => registry,
        workModes: store,
        workModeKeyFor,
        globalQuestionFrequency: async () => globalFrequency,
        pushFrom: (id, msg) => pushes.push({ id, ...msg })
      })
      const get = handlers['yan:getSessionQuestionFrequency']
      const set = handlers['yan:setSessionQuestionFrequency']
      ok(typeof get === 'function' && typeof set === 'function', 'IPC：注册了 get / set')

      /* 新会话默认 inherit，effective 跟随全局 */
      let view = await get()
      ok(view.ok && view.preference === 'inherit' && view.effective === 'balanced' && view.revision === 0, 'IPC：新会话 inherit / effective=全局', JSON.stringify(view))

      /* 显式设置：落盘 + 写快照 + 推送 */
      globalFrequency = 'sparse'
      let res = await set({ runnerId: 'runner-A', sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl', expectedRevision: 0, questionFrequency: 'eager' })
      ok(res.ok && res.preference === 'eager' && res.effective === 'eager' && res.global === 'sparse', 'IPC：显式设置生效且不被全局覆盖', JSON.stringify(res))
      ok(store.state('C:/sessions/A.jsonl').questionFrequency === 'eager', 'IPC：设置写入 store')
      const snapshot = await readWorkModeSnapshot('runner-A')
      ok(snapshot && snapshot.questionFrequency === 'eager', 'IPC：设置写入模型侧快照', JSON.stringify(snapshot))
      ok(pushes.some((p) => p.ch === 'work-mode' && p.payload.questionFrequency === 'eager'), 'IPC：设置后推送 work-mode')

      /* revision 冲突：不写并回传当前值 */
      res = await set({ runnerId: 'runner-A', sessionId: 'sid-A', expectedRevision: 99, questionFrequency: 'balanced' })
      ok(!res.ok && res.error === 'version-mismatch' && res.preference === 'eager', 'IPC：revision 冲突不写并回传当前值', JSON.stringify(res))

      /* 身份过期：显式 sessionId 与宿主当前不符 → 拒绝 */
      res = await set({ runnerId: 'runner-A', sessionId: 'sid-B', expectedRevision: 1, questionFrequency: 'sparse' })
      ok(!res.ok && res.error === 'stale_session', 'IPC：sessionId 不符拒绝', JSON.stringify(res))
      ok(store.state('C:/sessions/A.jsonl').questionFrequency === 'eager', 'IPC：拒绝后 store 未改')

      /* A 的迟到请求：持久化期间 runner 切到 B → 只保留 A，不写 B */
      const realSet = store.setQuestionFrequency.bind(store)
      let switchOnWrite = false
      store.setQuestionFrequency = async (key, pref, expected) => {
        const out = await realSet(key, pref, expected)
        if (switchOnWrite) runnerState.sessionFile = 'C:/sessions/B.jsonl'
        return out
      }
      switchOnWrite = true
      res = await set({ runnerId: 'runner-A', sessionId: 'sid-A', expectedRevision: 1, questionFrequency: 'sparse' })
      switchOnWrite = false
      ok(!res.ok && res.error === 'identity-changed', 'IPC：切会话期间的迟到请求报 identity-changed', JSON.stringify(res))
      ok(store.state('C:/sessions/A.jsonl').questionFrequency === 'sparse', 'IPC：迟到请求写进了它自己的 A')
      ok(!store.snapshot().entries['C:/sessions/B.jsonl'], 'IPC：迟到请求没有写到 B 键')
      const aSnapshot = await readWorkModeSnapshot('runner-A')
      ok(aSnapshot?.questionFrequency === 'eager', 'IPC：迟到请求不刷新快照（保留上一次成功值）', JSON.stringify(aSnapshot))

      /* 显式 runnerId 指向非 active 会话时也按其身份处理（不盲取 active） */
      res = await set({ runnerId: 'runner-A', sessionId: 'sid-B', expectedRevision: undefined, questionFrequency: 'balanced' })
      ok(!res.ok && res.error === 'stale_session', 'IPC：切走后显式 sessionId 不符仍拒绝')

      /* inherit 回落全局 */
      runnerState.sessionFile = 'C:/sessions/A.jsonl'
      const before = store.state('C:/sessions/A.jsonl').revision
      globalFrequency = 'eager'
      res = await set({ runnerId: 'runner-A', sessionId: 'sid-A', expectedRevision: before, questionFrequency: 'inherit' })
      ok(res.ok && res.preference === 'inherit' && res.effective === 'eager', 'IPC：inherit 回落全局', JSON.stringify(res))

      rmSync(ipcRoot, { recursive: true, force: true })
    }

    /* ==================== ④b 严格身份：缺必要身份不得写 ==================== */
    {
      const h = await makeIpcFixture()
      let res = await h.set({})
      ok(!res.ok && res.error === 'no_session', '严格：空 input 拒绝')
      ok(Object.keys(h.store.snapshot().entries).length === 0, '严格：空 input 不落任何记录')

      res = await h.set({ runnerId: 'ghost', sessionId: 'sid-X', expectedRevision: 0, questionFrequency: 'eager' })
      ok(!res.ok && res.error === 'no_session', '严格：不存在的 runner 拒绝')
      ok(!h.store.snapshot().entries['pending:ghost'], '严格：不产生悬空 pending 记录')

      res = await h.set({ runnerId: h.runnerId, expectedRevision: 0, questionFrequency: 'eager' })
      ok(!res.ok && res.error === 'no_session', '严格：缺稳定会话身份拒绝')

      res = await h.set({ runnerId: h.runnerId, sessionId: 'sid-A', questionFrequency: 'eager' })
      ok(!res.ok && res.error === 'bad-revision', '严格：缺 expectedRevision 拒绝')

      res = await h.set({ runnerId: h.runnerId, sessionId: 'sid-A', expectedRevision: Number.NaN, questionFrequency: 'eager' })
      ok(!res.ok && res.error === 'bad-revision', '严格：非有限 expectedRevision 拒绝')
      ok(Object.keys(h.store.snapshot().entries).length === 0, '严格：非法 input 后仍无记录')

      res = await h.set({ runnerId: h.runnerId, sessionId: 'sid-A', expectedRevision: 0, questionFrequency: 'eager' })
      ok(res.ok && res.preference === 'eager' && h.store.state('C:/sessions/A.jsonl').revision === 1, '严格：身份齐全时正常写入')
      h.rm()
    }

    /* ==================== ①b 真实 producer：pushWorkMode 携带权威 revision ==================== */
    {
      const producerStore = new WorkModeStore({ root })
      await producerStore.load()
      const producerState = { sessionId: 'sid-producer', sessionFile: 'C:/sessions/producer.jsonl' }
      const producerRegistry = {
        activeRunner: () => ({ id: 'runner-A' }),
        agentOf: (id) => (id === 'runner-A' ? { getState: () => ({ ...producerState }) } : undefined),
        runtimeOf: (id) =>
          id === 'runner-A' ? { sessionId: producerState.sessionId, runId: 'runner-A', generation: 1 } : null
      }
      const producerPushes = []
      configureGoalCoordinator({
        runners: () => producerRegistry,
        workModes: producerStore,
        pushFrom: (id, msg) => producerPushes.push({ id, ...msg })
      })
      await producerStore.setQuestionFrequency('C:/sessions/producer.jsonl', 'eager') // revision 1

      const payload = await pushWorkMode('runner-A')
      ok(
        payload.revision === 1 && payload.questionFrequency === 'eager' && payload.mode === 'standard',
        'producer：pushWorkMode 广播真实频率且携带 store 权威 revision',
        JSON.stringify(payload)
      )
      const wmPushes = producerPushes.filter((p) => p.ch === 'work-mode')
      ok(wmPushes.length >= 1 && wmPushes.at(-1).payload.revision === 1, 'producer：推送的 revision 也是权威值（不再是 0）')

      /* 旧快照里的退休模式不得被频率改动复活 */
      await writeWorkModeSnapshot('runner-A', { mode: 'autonomous', revision: 9, questionFrequency: 'eager' })
      const again = await pushWorkMode('runner-A')
      const snap = await readWorkModeSnapshot('runner-A')
      ok(again.mode === 'standard' && snap?.mode === 'standard', 'producer：不从旧快照复活 autonomous / clarify', JSON.stringify(again))
      rmSync(join(root, 'work-mode'), { recursive: true, force: true })
    }

    /* ==================== ⑤ publish 每个 await 后核对归属 ==================== */
    {
      /* 读取期间实例被复用：不写快照、不推送 */
      const h = await makeIpcFixture('runner-R1')
      await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager')
      globalThis.__qfHooks = {
        beforeRead: () => {
          h.runnerState.sessionId = 'sid-B'
          h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
        }
      }
      const res = await h.set({
        runnerId: 'runner-R1',
        sessionId: 'sid-A',
        sessionFile: 'C:/sessions/A.jsonl',
        expectedRevision: 1,
        questionFrequency: 'sparse'
      })
      globalThis.__qfHooks = null
      ok(!res.ok && res.error === 'identity-changed', 'publish：读取期间复用 → identity-changed', JSON.stringify(res))
      ok(!h.pushes.some((p) => p.ch === 'work-mode'), 'publish：读取期间复用 → 不推送旧 payload')
      ok((await readWorkModeSnapshot('runner-R1')) === null, 'publish：读取期间复用 → 不写 B 快照')
      h.rm()
    }
    {
      /* 保存后实例被复用：快照仍是它自己的 A，但不推送 */
      const h = await makeIpcFixture('runner-R2')
      await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager')
      globalThis.__qfHooks = {
        afterWrite: () => {
          h.runnerState.sessionId = 'sid-B'
          h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
        }
      }
      const res = await h.set({
        runnerId: 'runner-R2',
        sessionId: 'sid-A',
        sessionFile: 'C:/sessions/A.jsonl',
        expectedRevision: 1,
        questionFrequency: 'sparse'
      })
      globalThis.__qfHooks = null
      ok(!res.ok && res.error === 'identity-changed', 'publish：保存后复用 → identity-changed')
      ok(!h.pushes.some((p) => p.ch === 'work-mode'), 'publish：保存后复用 → 不推送旧 payload')
      const snap = await readWorkModeSnapshot('runner-R2')
      ok(snap?.questionFrequency === 'sparse', 'publish：保存后复用写下的仍是它自己的 A 快照', JSON.stringify(snap))
      h.rm()
    }
    {
      /* 保留待审标记；模式固定 standard，不从旧快照复活 autonomous */
      const h = await makeIpcFixture('runner-R3')
      await writeWorkModeSnapshot('runner-R3', { mode: 'autonomous', revision: 1, questionFrequency: 'inherit', planApprovalPending: true })
      await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager')
      const res = await h.set({ runnerId: 'runner-R3', sessionId: 'sid-A', expectedRevision: 1, questionFrequency: 'sparse' })
      const snap = await readWorkModeSnapshot('runner-R3')
      ok(
        res.ok && snap?.mode === 'standard' && snap?.planApprovalPending === true && snap?.questionFrequency === 'sparse',
        'publish：模式固定 standard、保留待审标记、频率写入',
        JSON.stringify(snap)
      )
      h.rm()
    }
    {
      /* describe 的 global await 后重新解析身份，不返回新 key + 旧 session 混合体 */
      const h = await makeIpcFixture('runner-R4')
      let flip = false
      h.setGlobal(async () => {
        if (flip) {
          h.runnerState.sessionId = 'sid-B'
          h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
        }
        return 'balanced'
      })
      await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager')
      flip = true
      const res = await h.get()
      ok(
        res.ok && res.runnerId === 'runner-R4' && res.key === 'C:/sessions/B.jsonl' && res.sessionFile === 'C:/sessions/B.jsonl',
        'describe：global await 后按新身份重取 key，不混合',
        JSON.stringify(res)
      )
      h.rm()
      rmSync(join(root, 'work-mode'), { recursive: true, force: true })
    }

    /* ==================== ⑤b F04：快照提交关键段不得被旧会话 rename 覆盖 ==================== */
    {
      const bSnapshot = (runnerId, rev) =>
        writeWorkModeSnapshot(
          runnerId,
          { mode: 'standard', revision: rev, questionFrequency: 'eager' },
          undefined,
          { owner: { sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl' } }
        )

      /* 读取期间复用：B 的有效快照不被旧 A 覆盖 */
      {
        const h = await makeIpcFixture('runner-X1')
        await bSnapshot('runner-X1', 7)
        await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'sparse')
        globalThis.__qfHooks = {
          beforeRead: () => {
            h.runnerState.sessionId = 'sid-B'
            h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
          }
        }
        const res = await h.set({
          runnerId: 'runner-X1',
          sessionId: 'sid-A',
          sessionFile: 'C:/sessions/A.jsonl',
          expectedRevision: 1,
          questionFrequency: 'sparse'
        })
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot('runner-X1')
        ok(!res.ok && res.error === 'identity-changed', 'F04：读取期间复用 → identity-changed', JSON.stringify(res))
        ok(
          snap?.questionFrequency === 'eager' && snap?.sessionId === 'sid-B',
          'F04：B 的有效快照未被旧 A 覆盖',
          JSON.stringify(snap)
        )
        h.rm()
      }

      /* 写入关键段复用：guard 分别在写入起点 / rename 前复校，都不覆盖 B */
      for (const flipAt of [2, 4]) {
        const runnerId = `runner-X${flipAt}`
        const h = await makeIpcFixture(runnerId)
        await bSnapshot(runnerId, 7)
        await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'sparse')
        let armed = false
        let armedCalls = 0
        h.registry.agentOf = (id) => {
          if (id !== runnerId) return undefined
          return {
            getState: () => {
              if (armed) {
                armedCalls++
                if (armedCalls === flipAt) {
                  h.runnerState.sessionId = 'sid-B'
                  h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
                }
              }
              return { ...h.runnerState }
            }
          }
        }
        globalThis.__qfHooks = {
          beforeWrite: () => {
            armed = true
            armedCalls = 0
          }
        }
        const res = await h.set({
          runnerId,
          sessionId: 'sid-A',
          sessionFile: 'C:/sessions/A.jsonl',
          expectedRevision: 1,
          questionFrequency: 'sparse'
        })
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot(runnerId)
        ok(
          !res.ok && res.error === 'identity-changed',
          `F04：写关键段第 ${flipAt} 次身份校验时复用 → identity-changed`,
          JSON.stringify(res)
        )
        ok(
          snap?.questionFrequency === 'eager' && snap?.sessionId === 'sid-B',
          `F04：关键段复用时 B 的有效快照未被 rename 覆盖（${flipAt}）`,
          JSON.stringify(snap)
        )
        ok(!h.pushes.some((p) => p.ch === 'work-mode'), `F04：关键段复用不推送旧 payload（${flipAt}）`)
        h.rm()
      }

      /* 代次变化（runner 复用、sessionFile 还没刷新）：identity 仍能识别 */
      {
        const runnerId = 'runner-XG'
        const h = await makeIpcFixture(runnerId)
        await bSnapshot(runnerId, 7)
        await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'sparse')
        let generation = 1
        h.registry.runtimeOf = (id) => (id === runnerId ? { sessionId: h.runnerState.sessionId, runId: runnerId, generation } : null)
        let armed = false
        let armedCalls = 0
        h.registry.agentOf = (id) => {
          if (id !== runnerId) return undefined
          return {
            getState: () => {
              if (armed) {
                armedCalls++
                if (armedCalls === 3) generation = 2
              }
              return { ...h.runnerState }
            }
          }
        }
        globalThis.__qfHooks = {
          beforeWrite: () => {
            armed = true
            armedCalls = 0
          }
        }
        const res = await h.set({
          runnerId,
          sessionId: 'sid-A',
          sessionFile: 'C:/sessions/A.jsonl',
          expectedRevision: 1,
          questionFrequency: 'sparse'
        })
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot(runnerId)
        ok(!res.ok && res.error === 'identity-changed', 'F04：代次变化（runner 复用）→ identity-changed', JSON.stringify(res))
        ok(
          snap?.questionFrequency === 'eager' && snap?.sessionId === 'sid-B',
          'F04：代次变化时 B 的有效快照未被覆盖',
          JSON.stringify(snap)
        )
        h.rm()
      }

      /* 写后复用：A 的迟到快照留在磁盘，但带 A 自己的归属，扩展核对归属不会带给 B */
      {
        const h = await makeIpcFixture('runner-X9')
        await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'sparse')
        globalThis.__qfHooks = {
          afterWrite: () => {
            h.runnerState.sessionId = 'sid-B'
            h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
          }
        }
        const res = await h.set({
          runnerId: 'runner-X9',
          sessionId: 'sid-A',
          sessionFile: 'C:/sessions/A.jsonl',
          expectedRevision: 1,
          questionFrequency: 'sparse'
        })
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot('runner-X9')
        ok(!res.ok && res.error === 'identity-changed', 'F04：写后复用 → identity-changed（不推送）', JSON.stringify(res))
        ok(
          snap?.questionFrequency === 'sparse' && snap?.sessionId === 'sid-A',
          'F04：写后复用时磁盘留下的是 A 自己的归属快照（扩展会拒绝错归属）',
          JSON.stringify(snap)
        )
        h.rm()
      }
    }

    /* ==================== ⑥b 纯选择器：displayedSessionOf 语义与 runner 匹配 ==================== */
    {
      const runners = () => [
        { id: 'runner-A', runId: 'runner-A', sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
        { id: 'runner-B', runId: 'runner-B', sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl' }
      ]
      let t = sessionQuestionFrequencyTarget({
        peekedSessionId: null, peekedPath: null,
        session: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
        pendingActivation: null, activeRunnerId: 'runner-A', runners: runners()
      })
      ok(t.enabled && t.runnerId === 'runner-A', '选择器：active 会话命中自己', JSON.stringify(t))

      t = sessionQuestionFrequencyTarget({
        peekedSessionId: 'sid-B', peekedPath: 'C:/sessions/B.jsonl',
        session: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
        pendingActivation: { sessionId: 'sid-B' }, activeRunnerId: 'runner-A', runners: runners()
      })
      ok(t.enabled && t.runnerId === 'runner-B', '选择器：deferred 预览命中后台实例，不误改 active', JSON.stringify(t))

      /* pi 对同一文件切回后可能给新 sessionId：路径也要能命中 */
      t = sessionQuestionFrequencyTarget({
        peekedSessionId: null, peekedPath: null,
        session: { sessionId: 'sid-A2', sessionFile: 'C:/sessions/A.jsonl' },
        pendingActivation: null, activeRunnerId: 'runner-A',
        runners: [{ id: 'runner-A', runId: 'runner-A', sessionId: 'sid-A-old', sessionFile: 'C:/sessions/A.jsonl' }]
      })
      ok(t.enabled && t.runnerId === 'runner-A', '选择器：pi 换 sessionId 后按路径仍命中', JSON.stringify(t))

      t = sessionQuestionFrequencyTarget({
        peekedSessionId: 'sid-B', peekedPath: 'C:/sessions/B.jsonl', session: null,
        pendingActivation: { sessionId: 'sid-B' }, activeRunnerId: 'runner-A',
        runners: [{ id: 'runner-A', runId: 'runner-A', sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }]
      })
      ok(!t.enabled && t.reason === 'pending-activation', '选择器：deferred 且无实例 → pending-activation 禁用', JSON.stringify(t))

      t = sessionQuestionFrequencyTarget({
        peekedSessionId: null, peekedPath: null, session: null,
        pendingActivation: null, activeRunnerId: null, runners: []
      })
      ok(!t.enabled && t.reason === 'no-session', '选择器：没有视图会话 → 禁用', JSON.stringify(t))
    }

    /* ==================== ⑥ 组件：目标身份 + 真实 producer→picker→IPC 序列 ==================== */
    {
      const { SessionQuestionFrequencyPicker } = await loadQuestionFrequencyComponent(build, buildDir, pathToFileURL, join)
      const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
      const realHarness = Object.getOwnPropertyDescriptor(globalThis, '__qfPickerHarness')
      const flush = async (rounds = 16) => {
        for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
      }

      let getCalls = []
      let setCalls = []
      let getResponder = () => Promise.resolve({ ok: false, error: 'no_session' })
      let setResponder = () => Promise.resolve({ ok: false, error: 'no_session' })
      globalThis.window = {
        yan: {
          getSessionQuestionFrequency: (runnerId) => {
            getCalls.push(runnerId)
            return getResponder(runnerId)
          },
          setSessionQuestionFrequency: (input) => {
            setCalls.push(input)
            return setResponder(input)
          }
        }
      }

      const start = async (store) => {
        const runtime = createQfHarness(SessionQuestionFrequencyPicker, { workMode: null, ...store })
        globalThis.__qfPickerHarness = runtime
        runtime.renderNow()
        await flush()
        const segmented = () => qfElements(runtime.tree).find((el) => el.type === 'Segmented')
        return {
          runtime,
          value: () => segmented()?.props?.value,
          options: () => segmented()?.props?.options ?? [],
          change: async (value) => {
            segmented()?.props?.onChange?.(value)
            await flush()
          },
          setStore: async (next) => {
            runtime.setStore(next)
            await flush()
          },
          flush
        }
      }
      const runnerA = { id: 'runner-A', runId: 'runner-A', sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }

      try {
        /* ⑥-1 deferred 预览显示 B、active 是 A、后台有 B → 定向 runner-B，不误改 A */
        {
          const runnerB = { id: 'runner-B', runId: 'runner-B', sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl' }
          getCalls = []
          setCalls = []
          let resolveGet
          getResponder = () => new Promise((res) => (resolveGet = res))
          const h = await start({
            peekedSessionId: 'sid-B',
            peekedPath: 'C:/sessions/B.jsonl',
            session: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
            pendingActivation: { sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl', cwd: 'C:/w' },
            activeRunnerId: 'runner-A',
            runners: [runnerA, runnerB]
          })
          ok(getCalls.length === 1 && getCalls[0] === 'runner-B', '组件：deferred 预览定向后台 B runner，而不是 active A', JSON.stringify(getCalls))
          resolveGet({ ok: true, runnerId: 'runner-B', sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl', key: 'C:/sessions/B.jsonl', revision: 2, preference: 'eager', effective: 'eager', global: 'balanced' })
          await flush()
          ok(h.value() === 'eager', '组件：显示被查看会话的权威偏好')
          ok(h.options().every((o) => !o.disabled), '组件：能对应 runner 就可以改')
          setResponder = async () => ({ ok: true, runnerId: 'runner-B', sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl', key: 'C:/sessions/B.jsonl', revision: 3, preference: 'sparse', effective: 'sparse', global: 'balanced' })
          await h.change('sparse')
          ok(
            setCalls.length === 1 && setCalls[0].runnerId === 'runner-B' && setCalls[0].sessionId === 'sid-B' && setCalls[0].expectedRevision === 2,
            '组件：提交带正确身份与权威 revision（不猜 0）',
            JSON.stringify(setCalls[0])
          )
        }

        /* ⑥-2 deferred 预览显示 B、没有 B 的 runner → 禁用，不动 active A */
        {
          getCalls = []
          setCalls = []
          getResponder = async () => ({ ok: false, error: 'no_session' })
          setResponder = async () => ({ ok: false, error: 'no_session' })
          const h = await start({
            peekedSessionId: 'sid-B',
            peekedPath: 'C:/sessions/B.jsonl',
            session: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
            pendingActivation: { sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl', cwd: 'C:/w' },
            activeRunnerId: 'runner-A',
            runners: [runnerA]
          })
          ok(getCalls.length === 0, '组件：没有对应 runner 时不查询（禁用）')
          ok(h.options().every((o) => o.disabled), '组件：没有对应 runner 时四项都禁用')
          await h.change('eager')
          ok(setCalls.length === 0, '组件：禁用时不提交，绝不误改 active 会话')
        }

        /* ⑥-3 真实 producer + IPC：pushWorkMode → picker → IPC set（revision 不猜 0） */
        {
          const ipc = await makeIpcFixture('pick-runner')
          await ipc.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager') // revision 1
          configureGoalCoordinator({
            runners: () => ipc.registry,
            workModes: ipc.store,
            pushFrom: (id, msg) => ipc.pushes.push({ id, ...msg })
          })
          getCalls = []
          setCalls = []
          getResponder = (runnerId) => ipc.get(runnerId)
          setResponder = (input) => ipc.set(input)
          const runnerPick = { id: 'pick-runner', runId: 'pick-runner', sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }
          const h = await start({
            peekedSessionId: null,
            peekedPath: null,
            session: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' },
            pendingActivation: null,
            activeRunnerId: 'pick-runner',
            runners: [runnerPick]
          })
          ok(getCalls[0] === 'pick-runner' && h.value() === 'eager', '组件：active 会话先拿权威频率')
          const payload = await pushWorkMode('pick-runner')
          ok(payload.revision === 1, '真实序列：切回推送 revision=1（store 权威值）', JSON.stringify(payload))
          await h.setStore({ ...h.runtime.store, workMode: payload })
          await h.change('balanced')
          ok(setCalls.at(-1)?.expectedRevision === 1, '真实序列：picker 用推送的权威 revision 提交', JSON.stringify(setCalls.at(-1)))
          const stored = ipc.store.state('C:/sessions/A.jsonl')
          ok(
            stored.questionFrequency === 'balanced' && stored.revision === 2,
            '真实序列：pushWorkMode → picker → IPC 提交成功（不再 version-mismatch）',
            JSON.stringify(stored)
          )
          ipc.rm()
          rmSync(join(root, 'work-mode'), { recursive: true, force: true })
        }
      } finally {
        if (realWindow === undefined) delete globalThis.window
        else Object.defineProperty(globalThis, 'window', realWindow)
        if (realHarness === undefined) delete globalThis.__qfPickerHarness
        else globalThis.__qfPickerHarness = realHarness.value
      }
    }

    /* ==================== ⑤c 其余生产 writer 归属封口 ==================== */
    {
      const bSnapshot = (runnerId, rev = 7) =>
        writeWorkModeSnapshot(
          runnerId,
          { mode: 'standard', revision: rev, questionFrequency: 'eager' },
          undefined,
          { owner: { sessionId: 'sid-B', sessionFile: 'C:/sessions/B.jsonl' } }
        )

      const makeGoalIpcFixture = (runnerId) => {
        const goalRoot = mkdtempSync(join(tmpdir(), 'yan-qf-goalipc-'))
        const store = new WorkModeStore({ root: goalRoot })
        const runnerState = { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' }
        const registry = {
          activeRunner: () => ({ id: runnerId }),
          agentOf: (id) => (id === runnerId ? { getState: () => ({ ...runnerState }) } : null),
          runtimeOf: (id) =>
            id === runnerId ? { sessionId: runnerState.sessionId, runId: runnerId, generation: 1 } : null
        }
        const workModeKeyFor = (id) =>
          normalizeSessionFileKey(registry.agentOf(id)?.getState()?.sessionFile) ?? `pending:${id}`
        const pushes = []
        const handlers = {}
        registerGoalIpc(
          { handle: (channel, fn) => (handlers[channel] = fn), rawHandle: () => {} },
          {
            registry: () => registry,
            workModes: store,
            handoffs: {},
            handoffTransactions: {},
            sessionChains: {},
            handoffDiag: { record: () => {} },
            pushFrom: (id, msg) => pushes.push({ id, ...msg }),
            scheduleSessionWork: async () => {}
          }
        )
        /* goal-ipc 的 workModeKeyFor / goals 经 goal-coordinator 的宿主解析，必须同图接上。 */
        configureGoalCoordinator({
          runners: () => registry,
          workModes: store,
          pushFrom: (id, msg) => pushes.push({ id, ...msg })
        })
        return {
          runnerId,
          runnerState,
          store,
          registry,
          workModeKeyFor,
          pushes,
          set: handlers['yan:setWorkMode'],
          rm: () => rmSync(goalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
        }
      }

      /* ① goal-ipc setWorkMode：写入关键段被复用 → 不覆盖 B 的有效快照 */
      {
        const h = makeGoalIpcFixture('runner-G1')
        await bSnapshot('runner-G1')
        globalThis.__qfHooks = {
          beforeWrite: () => {
            h.runnerState.sessionId = 'sid-B'
            h.runnerState.sessionFile = 'C:/sessions/B.jsonl'
          }
        }
        const res = await h.set('autonomous', undefined)
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot('runner-G1')
        ok(res.ok === true, 'goal-ipc：正常返回 store 结果', JSON.stringify(res))
        ok(
          snap?.questionFrequency === 'eager' && snap?.sessionId === 'sid-B',
          'goal-ipc：写入关键段被复用 → 不覆盖 B 的有效快照',
          JSON.stringify(snap)
        )
        ok(!h.pushes.some((p) => p.ch === 'work-mode'), 'goal-ipc：身份已换 → 不推送旧 payload')
        h.rm()
      }

      /* ② goal-ipc setWorkMode：正常合法写入保留 mode / 频率 / revision 字段 */
      {
        const h = makeGoalIpcFixture('runner-G2')
        await h.store.setQuestionFrequency('C:/sessions/A.jsonl', 'eager') // revision 1
        const res = await h.set('autonomous', 1)
        const snap = await readWorkModeSnapshot('runner-G2')
        const raw = JSON.parse(readFileSync(join(root, 'work-mode', 'runner-G2.json'), 'utf8'))
        ok(
          res.ok && raw.mode === 'autonomous' && raw.revision === 2 && raw.questionFrequency === 'eager' &&
            snap?.questionFrequency === 'eager',
          'goal-ipc：合法写入保留 mode / 频率 / revision 字段',
          JSON.stringify({ res, raw })
        )
        h.rm()
      }

      /* ③ handoff 目的段：迟到 / 复用 → 不覆盖 B，也不复制源的错误频率偏好 */
      const makeHandoffFixture = (runnerId) => {
        const handoffRoot = mkdtempSync(join(tmpdir(), 'yan-qf-handoff-'))
        const store = new WorkModeStore({ root: handoffRoot })
        const runnerState = { sessionId: 'sid-D', sessionFile: 'C:/sessions/dest.jsonl' }
        const registry = {
          agentOf: (id) => (id === runnerId ? { getState: () => ({ ...runnerState }) } : null),
          runtimeOf: (id) =>
            id === runnerId ? { sessionId: runnerState.sessionId, runId: runnerId, generation: 1 } : null,
          activeRunnerId: runnerId
        }
        const workModeKeyFor = (id) =>
          normalizeSessionFileKey(registry.agentOf(id)?.getState()?.sessionFile) ?? `pending:${id}`
        configureHandoffCoordinator({
          runners: () => registry,
          defaultWorkMode: () => 'standard',
          goals: { inheritTo: async () => true },
          workModes: store,
          sessionChains: {},
          handoffTransactions: {},
          handoffDiag: { record: () => {} },
          workModeKeyFor,
          resolveWorkMode: async () => ({ mode: 'standard', revision: 0 }),
          pushFrom: () => {},
          push: () => {},
          maybeArmGoalContinue: async () => {},
          cancelGoalResume: async () => {},
          applyGoalResume: async () => {},
          consumeRepeatBlocks: async () => {},
          rememberRunnerSession: async () => {},
          pushRunners: () => {},
          pushRunnerSnapshot: async () => {},
          openHandoffSession: async () => ({ ok: false }),
          projectIdForCwd: () => undefined
        })
        return {
          runnerId,
          runnerState,
          store,
          workModeKeyFor,
          rm: () => rmSync(handoffRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
        }
      }
      {
        const h = makeHandoffFixture('runner-H1')
        await bSnapshot('runner-H1')
        globalThis.__qfHooks = {
          beforeWrite: () => {
            h.runnerState.sessionId = 'sid-A'
            h.runnerState.sessionFile = 'C:/sessions/A.jsonl'
          }
        }
        await inheritForHandoff({
          sessionFile: 'C:/sessions/dest.jsonl',
          runId: 'runner-H1',
          sourceSession: 'C:/sessions/source.jsonl'
        })
        globalThis.__qfHooks = null
        const snap = await readWorkModeSnapshot('runner-H1')
        ok(
          snap?.questionFrequency === 'eager' && snap?.sessionId === 'sid-B',
          'handoff：目的段写入关键段被复用 → 不覆盖 B 的有效快照',
          JSON.stringify(snap)
        )
        h.rm()
      }
      {
        const h = makeHandoffFixture('runner-H2')
        await h.store.load()
        await h.store.set('C:/sessions/source.jsonl', 'autonomous')
        await h.store.setQuestionFrequency('C:/sessions/source.jsonl', 'eager')
        await inheritForHandoff({
          sessionFile: 'C:/sessions/dest.jsonl',
          runId: 'runner-H2',
          sourceSession: 'C:/sessions/source.jsonl'
        })
        const snap = await readWorkModeSnapshot('runner-H2')
        const raw = JSON.parse(readFileSync(join(root, 'work-mode', 'runner-H2.json'), 'utf8'))
        const dest = h.store.state('C:/sessions/dest.jsonl')
        ok(
          raw.mode === 'standard' &&
            raw.revision === dest.revision &&
            raw.questionFrequency === 'inherit' &&
            snap?.sessionId === 'sid-D',
          'handoff：合法写入固定 standard、保留目的 revision / 频率、带目的归属（不复制源的 eager）',
          JSON.stringify({ raw, dest, snap })
        )
        h.rm()
      }
    }

    /* ==================== ⑦ work-mode.js 读归属：错归属回落安全标准档 ==================== */
    {
      const prevData = process.env.YAN_DATA_DIR
      const prevSid = process.env.YAN_SESSION_ID
      const wmRoot = mkdtempSync(join(tmpdir(), 'yan-qf-wmext-'))
      process.env.YAN_DATA_DIR = wmRoot
      process.env.YAN_SESSION_ID = 'runner-W'
      try {
        const ctxA = {
          sessionManager: { getSessionId: () => 'sid-A', getSessionFile: () => 'C:/sessions/A.jsonl' }
        }
        const ctxB = {
          sessionManager: { getSessionId: () => 'sid-B', getSessionFile: () => 'C:/sessions/B.jsonl' }
        }
        await writeWorkModeSnapshot(
          'runner-W',
          { mode: 'clarify', revision: 4, planApprovalPending: true },
          wmRoot,
          { owner: { sessionId: 'sid-A', sessionFile: 'C:/sessions/A.jsonl' } }
        )
        const owned = workModeExt.currentWorkMode(ctxA)
        ok(
          owned.mode === 'clarify' && owned.planApprovalPending === true,
          'work-mode.js：归属相符才采用快照（含待审标记）',
          JSON.stringify(owned)
        )
        const wrong = workModeExt.currentWorkMode(ctxB)
        ok(
          wrong.mode === 'standard' && wrong.planApprovalPending === false,
          'work-mode.js：错归属回落安全标准档，不带 A 的待审限制',
          JSON.stringify(wrong)
        )
        const unknown = workModeExt.currentWorkMode({})
        ok(
          unknown.mode === 'standard' && unknown.planApprovalPending === false,
          'work-mode.js：ctx 身份不可得且有归属 → 不盲接受',
          JSON.stringify(unknown)
        )
        await writeWorkModeSnapshot('runner-W', { mode: 'autonomous', revision: 5 }, wmRoot)
        const legacy = workModeExt.currentWorkMode({})
        ok(legacy.mode === 'autonomous', 'work-mode.js：旧无归属快照维持旧行为', JSON.stringify(legacy))
      } finally {
        if (prevData === undefined) delete process.env.YAN_DATA_DIR
        else process.env.YAN_DATA_DIR = prevData
        if (prevSid === undefined) delete process.env.YAN_SESSION_ID
        else process.env.YAN_SESSION_ID = prevSid
        rmSync(wmRoot, { recursive: true, force: true })
      }
    }

    /* ---- 扩展能读到 IPC 写出的快照（端到端） ---- */
    {
      const e2eRoot = mkdtempSync(join(tmpdir(), 'yan-qf-e2e-'))
      await writeWorkModeSnapshot('qf-runner-A', { mode: 'standard', revision: 1, questionFrequency: 'sparse' }, e2eRoot)
      const snap = await readWorkModeSnapshot('qf-runner-A', e2eRoot)
      ok(snap && snap.questionFrequency === 'sparse', '端到端：快照 round-trip 保持显式档')
      rmSync(e2eRoot, { recursive: true, force: true })
    }
  } finally {
    delete globalThis.__qfHooks
    rmSync(root, { recursive: true, force: true })
    rmSync(buildDir, { recursive: true, force: true })
    restoreEnv()
  }
}

// 只运行这一组，不依赖产品构建、个人设置或真实模型。
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  let passed = 0
  let failed = 0
  await runQuestionFrequencySessionTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL ${label} ${detail ?? ''}`)
    }
  })
  console.log(JSON.stringify({ passed, failed }))
  if (failed) process.exitCode = 1
}
