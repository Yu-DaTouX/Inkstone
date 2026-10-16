/**
 * Command Code 额度「整段消失」的定向检查。
 *
 * 复现的用户报告：用 Command Code 模型（如 deepseek/deepseek-v4.1-flash）时，
 * 状态栏额度段与右栏「额度」都不显示。两处共用 QuotaSection，provider 取
 * `s.session.model.provider`（pi 对内置扩展报 `commandcode`）。
 *
 * 根因不在额度口径，而在渲染入口的「空入口」判定：只要没有主值 / 没有窗口 /
 * 没有月预算就整块 `return null`——把「查询失败 / 接口没返回窗口 / Promise 直接
 * reject」也一起藏了，连已经写好的错误行都不可达。
 *
 * 本脚本分两层，都不联网、不用凭证、不调真实模型：
 *   ① 纯逻辑：`shouldRenderQuotaSection` / `quotaSnapshotMatchesProvider` /
 *      窗口解析。钉住「已知支持额度接口的 provider 失败时要留下」，
 *      并核对失败 / 未返回窗口 ≠ 额度为零。
 *   ② 组件级脱敏 fixture：真跑 `QuotaSection`，mock `window.yan.providerQuota`，
 *      覆盖成功 / 缺凭证 / 未返回窗口 / Promise reject / 快速切 provider /
 *      A→B→A 旧请求不覆盖新请求 / 同 provider 预算变化不丢刷新 / stale 保留。
 *      React 用最小 hook harness 驱动（无 jsdom、无 Electron）。
 *
 * 导出的 `runCommandCodeQuotaDisplayTests(ok)` 供 test:unit 调用；直接运行本文件
 * 也会执行并在失败时置退出码。import 本模块不会执行测试、不改 global。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = resolve('.tmp/commandcode-quota-display')

async function loadPure(entry, name) {
  const outfile = resolve(OUT, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

/* ------------------------------------------------------------------ 脱敏 fixture */

/** 字段形状取自线上快照，数值已改写 —— 不冒充真实账户。 */
const SNAPSHOT = {
  credits: { monthlyCredits: 69.996 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.003, cap: 14, exceeded: false, resetAt: 1_790_013_986_382 },
    weekly: { used: 0.003, cap: 35, exceeded: false, resetAt: 1_790_600_786_382 }
  }
}

const win = (id, label, used, total, resetAt = Date.now() + 3_600_000) => ({ id, label, used, total, resetAt, exceeded: false })

const ccPayload = (over = {}) => ({
  provider: 'commandcode',
  supported: true,
  used: 3,
  total: 70,
  currency: 'USD',
  label: '本月已用',
  windows: [win('fiveHour', '5 小时', 0.3, 14), win('weekly', '每周', 0.3, 35)],
  checkedAt: 1_700_000_000_000,
  ...over
})

/* ---------------------------------------------------------- 最小 React hook harness */

function depsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

/**
 * 只实现 QuotaSection 用到的那几个 hook（useState/useRef/useCallback/useEffect/
 * useMemo + JSX createElement）。按调用顺序存 slot，setState 触发一次重渲染，
 * 重渲染后跑 deps 变化过的 effect。足以在 Node 里真跑组件、不必引入 jsdom。
 */
function createHarness(component, initialStore, variant = 'section') {
  const slots = []
  let cursor = 0
  let scheduled = false
  let tree = null

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      renderNow()
    })
  }

  function renderNow() {
    cursor = 0
    tree = component({ variant })
    for (const slot of slots) {
      if (!slot || slot.kind !== 'effect' || !slot.pending) continue
      slot.pending = false
      if (typeof slot.cleanup === 'function') { try { slot.cleanup() } catch { /* ignore */ } }
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
      if (!slot || slot.kind !== 'callback' || !depsEqual(slot.deps, deps)) { slot = { kind: 'callback', fn, deps }; slots[i] = slot }
      return slot.fn
    },
    useMemo(fn, deps) {
      const i = cursor++
      let slot = slots[i]
      if (!slot || slot.kind !== 'memo' || !depsEqual(slot.deps, deps)) { slot = { kind: 'memo', value: fn(), deps }; slots[i] = slot }
      return slot.value
    },
    useEffect(fn, deps) {
      const i = cursor++
      const slot = slots[i]
      if (!slot || slot.kind !== 'effect') { slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: undefined } }
      else if (!depsEqual(slot.deps, deps)) { slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: slot.cleanup } }
      else { slot.pending = false }
    },
    createElement(type, props, key) {
      const merged = { ...(props || {}) }
      if (key !== undefined) merged.key = key
      return { __el: true, type, props: merged }
    }
  }
  return runtime
}

function collect(node, out = { testids: new Set(), text: [], els: [] }) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (typeof node === 'object' && node.__el) {
    const props = node.props || {}
    out.els.push(props)
    if (typeof props['data-testid'] === 'string') out.testids.add(props['data-testid'])
    collect(props.children, out)
    collect(props.extra, out)
    collect(props.panel, out)
  }
  return out
}

const deferred = () => {
  let resolveFn, rejectFn
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/* 组件 bundle 的 React / 展示层替身。真跑的只有 QuotaSection 与 shared 纯逻辑。 */
const FIXTURES = {
  react: `
const rt = () => globalThis.__quotaHarness
export const useState = (...a) => rt().useState(...a)
export const useRef = (...a) => rt().useRef(...a)
export const useCallback = (...a) => rt().useCallback(...a)
export const useEffect = (...a) => rt().useEffect(...a)
export const useMemo = (...a) => rt().useMemo(...a)
`,
  'jsx-runtime': `
const rt = () => globalThis.__quotaHarness
export const Fragment = Symbol.for('quota.Fragment')
export const jsx = (type, props, key) => rt().createElement(type, props, key)
export const jsxs = jsx
export const jsxDEV = jsx
`,
  store: `export const useStore = (selector) => selector(globalThis.__quotaHarness.store)`,
  i18n: `export const useT = () => (key, vars) => (vars ? key + '|' + JSON.stringify(vars) : key)`,
  'tool-section': `export function Section({ children, extra, ...rest }) { return { __el: true, type: 'Section', props: { ...rest, extra, children } } }`,
  ui: `
const el = (type) => (props) => ({ __el: true, type, props: props || {} })
export const Button = el('Button')
export const IconButton = el('IconButton')
export const Input = el('Input')
export const MiniMeter = el('MiniMeter')
export const Switch = el('Switch')
`,
  'detail-popover': `export function DetailTrigger({ children, panel, ...rest }) { return { __el: true, type: 'DetailTrigger', props: { ...rest, panel, children } } }`
}

async function loadQuotaComponent(dir) {
  const outfile = join(dir, 'quota-section.mjs')
  await build({
    entryPoints: ['src/renderer/src/components/toolbar/QuotaSection.tsx'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [{
      name: 'quota-component-fixtures',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'component-fixture' }))
        b.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'component-fixture' }))
        for (const [filter, name] of [
          [/state\/store$/, 'store'],
          [/\/i18n$/, 'i18n'],
          [/ToolSection$/, 'tool-section'],
          [/\/ui$/, 'ui'],
          [/DetailPopover$/, 'detail-popover']
        ]) b.onResolve({ filter }, () => ({ path: name, namespace: 'component-fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'component-fixture' }, (args) => ({ contents: FIXTURES[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

/* ------------------------------------------------------------- 组件级场景（真跑组件） */

async function runComponentScenarios(check, QuotaSection) {
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realHarness = Object.getOwnPropertyDescriptor(globalThis, '__quotaHarness')
  const focusListeners = []
  let currentQuota = null

  globalThis.document = { visibilityState: 'visible' }
  globalThis.window = {
    yan: {
      providerQuota: (provider, budget) => currentQuota(provider, budget),
      codexAccounts: async () => []
    },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: (type, fn) => { if (type === 'focus') focusListeners.push(fn) },
    removeEventListener: () => {}
  }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  const flush = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)) }

  const make = (over = {}) => {
    const calls = []
    currentQuota = (provider, budget) => {
      const d = deferred()
      calls.push({ provider, budget, ...d })
      return d.promise
    }
    const store = {
      session: { model: { provider: 'commandcode' }, sessionId: 's1' },
      settings: { providerBudgets: {} },
      patchSettings: async () => {},
      setQuotaFailover: () => {},
      setKeepRunning: () => {},
      ...over.store
    }
    const runtime = createHarness(QuotaSection, store, over.variant ?? 'section')
    globalThis.__quotaHarness = runtime
    const read = () => collect(runtime.tree)
    return {
      calls,
      runtime,
      store,
      start: async () => { runtime.renderNow(); await flush() },
      setProvider: async (provider) => {
        runtime.setStore({ ...runtime.store, session: { ...runtime.store.session, model: { provider } } })
        await flush()
      },
      setBudget: async (commandcode) => {
        runtime.setStore({ ...runtime.store, settings: { providerBudgets: { commandcode } } })
        await flush()
      },
      flush,
      hasTestId: (id) => read().testids.has(id),
      text: () => read().text.join(' '),
      titles: () => read().els.map((p) => p.title).filter((t) => typeof t === 'string'),
      tree: () => runtime.tree
    }
  }

  try {
    // ① 成功：真实组件 mock window.yan，拿到窗口即渲染，不出现错误行。
    {
      const h = make()
      await h.start()
      check(h.calls.length === 1 && h.calls[0].provider === 'commandcode', '组件挂载后对当前 provider 发起一次查询')
      h.calls[0].resolve(ccPayload())
      await h.flush()
      check(h.hasTestId('quota-win-fiveHour'), '成功响应 → 渲染窗口')
      check(!h.hasTestId('quota-error'), '成功响应 → 没有错误行')
    }

    // ② 缺凭证：后端 resolved 带 error，仍要留下错误行。
    {
      const h = make()
      await h.start()
      h.calls[0].resolve({ provider: 'commandcode', supported: true, error: '未找到该供应商的 API Key', checkedAt: 1 })
      await h.flush()
      check(h.hasTestId('quota-error'), '缺凭证 → 仍渲染错误行，不整段消失')
      check(h.text().includes('acct.failed') && h.text().includes('未找到该供应商的 API Key'), '缺凭证原因可见')
    }

    // ③ 接口返回但没有窗口：同样留下，不能当成 0 额度。
    {
      const h = make()
      await h.start()
      h.calls[0].resolve({ provider: 'commandcode', supported: true, error: '未返回额度窗口', checkedAt: 1 })
      await h.flush()
      check(h.hasTestId('quota-error') && h.text().includes('未返回额度窗口'), '未返回窗口 → 如实显示原因')
    }

    // ④ Promise 直接 reject：supported 停在 null，错误也必须可见（本轮关键修复）。
    {
      const h = make()
      await h.start()
      h.calls[0].reject(new Error('网络错误'))
      await h.flush()
      check(h.hasTestId('quota-error'), 'Promise reject（supported 未回来）→ 仍渲染错误行')
      check(h.text().includes('acct.failed') && h.text().includes('网络错误'), 'reject 原因可见')
    }

    // ④b 状态栏变体：reject 时悬停提示也要能解释「—」。
    {
      const h = make({ variant: 'status' })
      await h.start()
      h.calls[0].reject(new Error('HTTP 500'))
      await h.flush()
      check(h.titles().some((t) => t.includes('acct.failed') && t.includes('HTTP 500')), '状态栏摘要的悬停提示写明失败原因')
    }

    // ⑤ 快速切 provider：旧 provider 的迟到成功不得串到新 provider。
    {
      const h = make()
      await h.start()
      await h.setProvider('deepseek')
      check(h.calls.length === 2 && h.calls[1].provider === 'deepseek', '切 provider 后为新 provider 发查询')
      h.calls[0].resolve(ccPayload())            // 旧的 commandcode 迟到
      h.calls[1].resolve({ provider: 'deepseek', supported: true, remaining: 5, currency: 'CNY', checkedAt: 2 })
      await h.flush()
      check(h.text().includes('¥5.00'), 'deepseek 的余额正常显示')
      check(!h.hasTestId('quota-win-fiveHour'), 'commandcode 的旧窗口没有串进 deepseek')
    }

    // ⑥ A→B→A：旧 A 的迟到结果不得覆盖新 A，也不得清掉新 A 的 loading。
    {
      const h = make()
      await h.start()
      await h.setProvider('deepseek')
      await h.setProvider('commandcode')
      check(h.calls.length === 3, '回到 A 时又发了一笔新查询（不因 provider 字符串相同被挡）')
      h.calls[2].resolve(ccPayload({ used: 2, windows: [win('fiveHour', '5 小时', 2, 14)] }))
      await h.flush()
      check(h.text().includes('$2.00'), '新 A 的结果先落地')
      h.calls[0].resolve(ccPayload({ used: 99, windows: [win('fiveHour', '5 小时', 99, 100)] }))
      await h.flush()
      check(h.text().includes('$2.00') && !h.text().includes('$99.00'), '旧 A 的迟到结果不覆盖新 A')
    }

    // ⑦ 同 provider 预算变化：在飞时不并发，但回来后必须补跑最后一次刷新。
    {
      const h = make()
      await h.start()
      await h.setBudget(100)
      check(h.calls.length === 1, '同 provider 已有请求在飞 → 不并发第二笔')
      h.calls[0].resolve(ccPayload({ used: 1 }))
      await h.flush()
      check(h.calls.length === 2, '在飞请求回来后补跑欠下的刷新')
      check(h.calls[1].budget === 100, '补跑用的是最新预算')
      h.calls[1].resolve(ccPayload({ used: 2, total: 100, windows: [win('fiveHour', '5 小时', 2, 100)] }))
      await h.flush()
      check(h.text().includes('$2.00'), '最终展示最新预算下的结果')
    }

    // ⑧ stale 保留：失败但有上次成功数据时，显示旧数字并注明时间/原因。
    {
      const h = make()
      await h.start()
      h.calls[0].resolve(ccPayload())
      await h.flush()
      await h.setProvider('deepseek')
      h.calls[1].resolve({ provider: 'deepseek', supported: true, remaining: 5, currency: 'CNY', checkedAt: 2 })
      await h.flush()
      await h.setProvider('commandcode')
      h.calls[2].resolve(ccPayload({ staleError: 'HTTP 429' }))
      await h.flush()
      check(h.hasTestId('quota-win-fiveHour'), 'stale 时保留上次成功的窗口')
      check(h.text().includes('quota.stale') && h.text().includes('HTTP 429'), 'stale 时注明是上次成功的数据与本次失败原因')
    }

    // ⑨ 明确不支持的自定义 API：不占空块（即使带 error）。
    {
      const h = make()
      await h.start()
      h.calls[0].resolve({ provider: 'commandcode', supported: false, error: '该供应商没有可用的公开余额 API', checkedAt: 1 })
      await h.flush()
      check(h.tree() === null, 'supported=false → 整段不渲染（保持旧行为）')
    }
  } finally {
    currentQuota = null
    if (realHarness) Object.defineProperty(globalThis, '__quotaHarness', realHarness)
    else delete globalThis.__quotaHarness
    if (realWindow) Object.defineProperty(globalThis, 'window', realWindow)
    else delete globalThis.window
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument)
    else delete globalThis.document
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

/* ----------------------------------- models.json 取 key 统一 helper（正式 main/quota-credentials.ts） */

async function loadQuotaCredentials() {
  const outfile = resolve(OUT, 'quota-credentials.mjs')
  await build({
    entryPoints: ['src/main/quota-credentials.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'quota-credentials-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'quota-cred-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'quota-cred-stub' }, () => ({
          contents: `export const readAuthEntry = async (p) => globalThis.__quotaCred?.authEntry?.[p]`,
          loader: 'js'
        }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body })

/**
 * 取 key 的统一来源：auth/env 优先、models.json 官方兜底。
 * 全部用假 env / 临时 models.json，不读真实凭证、不联网。
 */
async function runQuotaCredentialSourceTests(check) {
  const creds = await loadQuotaCredentials()
  const dir = await mkdtemp(resolve(OUT, 'quota-creds-'))
  const modelsFile = join(dir, 'models.json')
  globalThis.__quotaCred = { authEntry: {} }
  try {
    /* pi 的配置值语法：只认环境引用，命令型一律拒绝 */
    check(creds.resolveNativeConfigValue('sk-literal', {}) === 'sk-literal', '配置值：纯字符串原样返回')
    check(creds.resolveNativeConfigValue('$CC_KEY', { CC_KEY: 'env-key' }) === 'env-key', '配置值：$NAME 环境引用')
    check(creds.resolveNativeConfigValue('${CC_KEY}', { CC_KEY: 'env2' }) === 'env2', '配置值：${NAME} 环境引用')
    check(creds.resolveNativeConfigValue('$MISSING_KEY_X', {}) === undefined, '配置值：环境引用缺变量 → 缺失（不造凭证）')
    check(creds.resolveNativeConfigValue('$$literal', {}) === '$literal', '配置值：$$ 还原字面量')
    check(creds.resolveNativeConfigValue('!echo pwned', {}) === undefined, '配置值：! 命令型 → 拒绝，不执行')

    /* baseUrl 官方约束 */
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_static' }) === 'user_static', '官方 HTTPS 主机 + 静态 key → 可取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_x' }) === undefined, '相似官方域（后缀伪造）→ 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://evil.test/api.commandcode.ai', apiKey: 'user_x' }) === undefined, '官方域名出现在路径 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_x' }) === undefined, '非 HTTPS → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai:8443/provider/v1', apiKey: 'user_x' }) === undefined, '非默认端口 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://user:pass@api.commandcode.ai/provider/v1', apiKey: 'user_x' }) === undefined, 'URL 内嵌凭证 → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { apiKey: 'user_x' }) === undefined, 'commandcode 缺 baseUrl（无原生默认）→ 不取')
    check(creds.extractModelsJsonQuotaKey('deepseek', { apiKey: 'sk-x' }) === 'sk-x', 'deepseek 缺 baseUrl → 用 pi 原生官方默认，可取')
    check(creds.extractModelsJsonQuotaKey('deepseek', { baseUrl: 'https://api.deepseek.com.evil.test', apiKey: 'sk-x' }) === undefined, 'deepseek 代理域 → 不取')
    check(creds.extractModelsJsonQuotaKey('yan-local', { baseUrl: 'https://api.commandcode.ai', apiKey: 'sk-x' }) === undefined, '未知 / 自定义 provider → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '!echo secret' }) === undefined, '命令型 apiKey → 不取')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_KEY}' }, { CC_KEY: 'env-key' }) === 'env-key', 'models.json 环境引用（有 env）→ 取 env 值')
    check(creds.extractModelsJsonQuotaKey('commandcode', { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_KEY}' }, {}) === undefined, 'models.json 环境引用（无 env）→ 缺失')
    check(creds.extractModelsJsonQuotaKey('commandcode', null) === undefined, '条目形状不对 → 不取')

    /* 坏 JSON：不泄露、不执行 */
    await writeFile(modelsFile, '{ this is not json')
    check(await creds.readModelsJsonQuotaKey('commandcode', { agentDir: dir, env: {} }) === undefined, '坏 JSON → 缺失，不泄露不执行')

    /*
     * 来源分离：auth / env / models 三把不同的 key，按原生顺序 auth > models > env。
     * 用 options.readAuth / options.env 明确注入来源，不从合并的 resolveSecret 猜。
     */
    const authEntry = { type: 'api_key', key: 'user_auth_sentinel' }
    const readAuth = async () => authEntry
    const threeEnv = { COMMANDCODE_API_KEY: 'user_env_sentinel' }

    /* 坏 JSON：三个来源都不取（此时即使 auth/env 都有 key，也不能发送） */
    await writeFile(modelsFile, '{ this is not json')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, '坏 JSON → auth/env/models 都不取')

    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: 'user_models_sentinel' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === 'user_auth_sentinel', '三来源都有 key → 原生顺序 auth 胜出（不是 env）')
    /* auth + env，无 models */
    await writeFile(modelsFile, JSON.stringify({ providers: {} }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === 'user_auth_sentinel', 'auth + env、无 models → auth 胜出')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_env_sentinel', 'env-only、无 models → 用原生内置 env')
    /* models + env，无 auth */
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: 'user_models_sentinel' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_models_sentinel', 'models + env、无 auth → models 胜出（原生 rawKey 优先于内置 env）')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => ({ type: 'api_key', key: '   ' }) }) === 'user_models_sentinel', '空白 auth 视为缺失 → models 胜出')
    /* auth-only / env-only（无 models 条目）保持可用 */
    await writeFile(modelsFile, JSON.stringify({ providers: {} }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {}, readAuth }) === 'user_auth_sentinel', 'auth-only（无 models）→ 仍可用')
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === 'user_env_sentinel', 'env-only（无 models）→ 仍可用')

    /*
     * 生效端点不可证明时，三个来源都不取 —— 即使 auth / env 都存了 key。
     * 这是本次修的真实漏洞：代理条目的 key 往往是用户存进 auth.json / env 的那一把。
     */
    for (const [label, entry] of [
      ['代理域', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_models_sentinel' }],
      ['非 https', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel' }],
      ['非默认端口', { baseUrl: 'https://api.commandcode.ai:8443/provider/v1', apiKey: 'user_models_sentinel' }],
      ['URL 内嵌凭证', { baseUrl: 'https://u:p@api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel' }],
      ['模板 baseUrl', { baseUrl: '$CC_BASE_URL', apiKey: 'user_models_sentinel' }],
      ['命令 baseUrl', { baseUrl: '!echo https://api.commandcode.ai', apiKey: 'user_models_sentinel' }],
      ['commandcode 缺 baseUrl（无原生默认）', { apiKey: 'user_models_sentinel' }],
      ['形状不可信', ['api.commandcode.ai']]
    ]) {
      await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: entry } }))
      check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, `端点不可证明（${label}）→ auth/env/models 都不取`)
    }
    /* per-model override 指离官方：原生会用它，故整条不可证明 */
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: {
      baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel',
      models: [{ id: 'cc', baseUrl: 'https://api.commandcode.ai.evil.test/v1' }]
    } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth }) === undefined, 'per-model baseUrl 指离官方 → auth/env/models 都不取')
    /* per-model 缺 baseUrl 或同为官方：可放行 */
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: {
      baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_sentinel',
      models: [{ id: 'cc' }, { id: 'cc2', baseUrl: 'https://api.commandcode.ai/provider/v1' }]
    } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {} }) === 'user_models_sentinel', 'per-model 均为官方或缺省 → models key 可用')

    /*
     * models.json 声明了 apiKey 时，原生不再回退内置 env：
     * 命令型 / 环境引用缺变量 → 如实报缺失，绝不拿全局 env 冒充另一把 key。
     */
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: '!echo other-account-key' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === undefined, '命令型 models apiKey + env → 报缺失（不拿 env 冒充）')
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: '${CC_MISSING_KEY}' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv, readAuth: async () => undefined }) === undefined, '环境引用缺变量的 models apiKey + env → 报缺失（不拿 env 冒充）')
    /* commandcode 条目无 apiKey + env：扩展让位、无内置默认 → 不读 env */
    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1' } } }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: threeEnv }) === undefined, 'commandcode 条目无 apiKey + env → 报缺失（扩展让位，无原生 env 回退）')
    /* 内置 provider 条目无 apiKey + env：原生会回退 env */
    await writeFile(modelsFile, JSON.stringify({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com' } } }))
    check(await creds.resolveQuotaProviderSecret('deepseek', { agentDir: dir, env: { DEEPSEEK_API_KEY: 'sk_deepseek_env' } }) === 'sk_deepseek_env', '内置 provider 条目无 apiKey + env → 原生 env 回退生效')

    /* 命令型 apiKey：既不返回值，也绝不落 shell（哨兵文件不存在） */
    const sentinel = join(dir, 'PWNED').replace(/\\/g, '/')
    await writeFile(modelsFile, JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai', apiKey: `!node -e "require('fs').writeFileSync('${sentinel}','x')"` } }
    }))
    check(await creds.resolveQuotaProviderSecret('commandcode', { agentDir: dir, env: {}, readAuth: async () => undefined }) === undefined, '命令型 models.json apiKey → 返回缺失')
    check(!existsSync(sentinel), '命令型 models.json apiKey → 未被 shell 执行（无哨兵文件）')
  } finally {
    delete globalThis.__quotaCred
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------- 状态栏入口（正式 main/quota.ts）与磁贴同源 */

const QUOTA_MAIN_STUBS = {
  electron: `export const net = { fetch: (...a) => globalThis.__quotaNet.fetch(...a) }`,
  credentials: `
export const readAuthEntry = async (p) => globalThis.__quotaNet?.authEntry?.[p]
export const resolveCodexAccountId = async () => undefined
`,
  'image-credentials': `export const hostImageCredentials = { codex: async () => null }`
}

async function loadQuotaMain() {
  const outfile = resolve(OUT, 'quota-main.mjs')
  await build({
    entryPoints: ['src/main/quota.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'quota-main-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'quota-main-stub' }))
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'quota-main-stub' }))
        b.onResolve({ filter: /^\.\/image-credentials$/ }, () => ({ path: 'image-credentials', namespace: 'quota-main-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'quota-main-stub' }, (args) => ({ contents: QUOTA_MAIN_STUBS[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

/**
 * 状态栏额度（QuotaSection → yan:providerQuota → main/quota.ts）与磁贴共用同一个 helper。
 * 这里真跑正式 quota.ts（stub 网络），钉住 models.json-only 官方 key 也走同一个官方额度接口。
 */
async function runStatusBarModelsKeyTest(check) {
  const dir = await mkdtemp(resolve(OUT, 'quota-main-'))
  const priorPi = process.env.YAN_PI_DIR
  const priorKey = process.env.COMMANDCODE_API_KEY
  const priorFetch = globalThis.fetch
  process.env.YAN_PI_DIR = dir
  try {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_only' } }
    }))
    const main = await loadQuotaMain()
    const urls = []
    globalThis.__quotaNet = {
      authEntry: {},
      fetch: async () => { throw new Error('test: net.fetch must not be used for commandcode quota') }
    }
    globalThis.fetch = async (url) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('/alpha/billing/credits')) return jsonResponse(SNAPSHOT)
      if (u.includes('/alpha/billing/subscriptions')) return jsonResponse({ data: { currentPeriodEnd: '2026-10-21T00:00:00.000Z' } })
      throw new Error(`unexpected URL ${u}`)
    }
    const q = await main.providerQuota('commandcode')
    check(q.supported === true && !q.error, '状态栏入口：models.json-only 官方 key 可取额度（不再「未找到 API Key」）')
    check(q.windows.map((w) => w.id).join(',') === 'fiveHour,weekly,monthly', '状态栏入口：同一 models.json key 得到同样三窗口')
    check(q.windows.find((w) => w.id === 'monthly')?.estimated === true, '状态栏入口：推算月窗口仍标 estimated')
    check(urls.every((u) => u.startsWith('https://api.commandcode.ai/')), '状态栏入口：只请求官方主机')

    /* 代理条目 + auth/env 都有 key → 零官方 fetch，不产额度（不把代理 key 发官方） */
    urls.length = 0
    globalThis.__quotaNet.authEntry = { commandcode: { type: 'api_key', key: 'user_auth_sentinel' } }
    process.env.COMMANDCODE_API_KEY = 'user_env_sentinel'
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_models_sentinel' } }
    }))
    const qProxy = await main.providerQuota('commandcode')
    check(qProxy.error === '未找到该供应商的 API Key', '状态栏入口：代理条目 + auth/env key → 报缺凭证（不取任何来源）')
    check(urls.length === 0, '状态栏入口：代理条目 + auth/env key → 零官方 fetch')

    /* 无 models 条目 + env-only → 仍走官方额度接口 */
    urls.length = 0
    globalThis.__quotaNet.authEntry = {}
    await rm(join(dir, 'models.json'), { force: true })
    const qEnv = await main.providerQuota('commandcode')
    check(qEnv.supported === true && !qEnv.error, '状态栏入口：env-only（无 models 条目）→ 仍可取额度')
    check(urls.every((u) => u.startsWith('https://api.commandcode.ai/')), '状态栏入口：env-only → 只请求官方主机')
  } finally {
    delete globalThis.__quotaNet
    globalThis.fetch = priorFetch
    if (priorPi === undefined) delete process.env.YAN_PI_DIR
    else process.env.YAN_PI_DIR = priorPi
    if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
    else process.env.COMMANDCODE_API_KEY = priorKey
    await rm(dir, { recursive: true, force: true })
  }
}

/* ---------------------------- 随包 commandcode 扩展：env-only 注册声明 + 不覆盖用户 key */

async function runCommandCodeExtensionAuthTest(check) {
  const mod = await import(pathToFileURL(resolve('resources/pi-extensions/commandcode.js')).href)
  const dir = await mkdtemp(resolve(OUT, 'cc-ext-'))
  const priorAgent = process.env.PI_CODING_AGENT_DIR
  const priorKey = process.env.COMMANDCODE_API_KEY
  const realFetch = globalThis.fetch
  const calls = []
  const pi = { registerProvider: (id, config) => calls.push({ id, config }) }
  try {
    process.env.PI_CODING_AGENT_DIR = dir
    await writeFile(join(dir, 'yan-commandcode-models.json'), JSON.stringify({
      savedAt: 1,
      models: [{ id: 'cc-test', name: 'cc-test', api: 'openai-completions', baseUrl: mod.BASE_URL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }]
    }))
    globalThis.fetch = async () => { throw new Error('test: no network') }

    /* env-only：必须声明 pi 原生的环境引用，否则该 provider 永远 not_ready */
    process.env.COMMANDCODE_API_KEY = 'user_env_only'
    await mod.default(pi)
    check(calls.length === 1 && calls[0].id === 'commandcode', '扩展 env-only：注册 commandcode')
    check(calls[0]?.config.apiKey === '$COMMANDCODE_API_KEY', '扩展 env-only：声明 $COMMANDCODE_API_KEY 环境引用（pi 原生配置值语法）')

    /* models.json 已有 commandcode：扩展让位，不注册 → 不覆盖用户手写 key */
    calls.length = 0
    delete process.env.COMMANDCODE_API_KEY
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ commandcode: { type: 'api_key', key: 'user_auth' } }))
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_key' } } }))
    await mod.default(pi)
    check(calls.length === 0, '扩展：models.json 已有 commandcode → 让位不注册（不覆盖用户手写 key）')

    /* auth.json-only（无 env）：注册也不带 apiKey，凭证仍走 pi credential 路径 */
    calls.length = 0
    await rm(join(dir, 'models.json'), { force: true })
    await mod.default(pi)
    check(calls.length === 1 && calls[0]?.config.apiKey === undefined, '扩展 auth.json-only：不声明 apiKey（不被扩展覆盖，走 credential）')
  } finally {
    globalThis.fetch = realFetch
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = priorAgent
    if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
    else process.env.COMMANDCODE_API_KEY = priorKey
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------------ 入口 */

export async function runCommandCodeQuotaDisplayTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (cond, label, extra = '') => { if (!cond) throw new Error(`Command Code 额度显示：${label}${extra ? ' ' + extra : ''}`) }

  await mkdir(OUT, { recursive: true })
  const { commandCodeWindows } = await loadPure('src/main/quota-commandcode.ts', 'quota-commandcode')
  const { shouldRenderQuotaSection, quotaSnapshotMatchesProvider } = await loadPure('src/shared/quota-display.ts', 'quota-display')

  /** 组件把当前状态映射成入参；这里只保留判定要用到的字段。 */
  const renderInput = (over = {}) => ({
    provider: 'commandcode',
    loading: false,
    supported: true,
    hasError: false,
    hasMainText: false,
    windowCount: 0,
    hasBudget: false,
    ...over
  })

  /* 1. 正常路径 */
  {
    const windows = commandCodeWindows(SNAPSHOT, Date.UTC(2026, 9, 21))
    check(windows.length === 3, '五个小时 / 每周 / 本月三个窗口都产出', windows.map((w) => w.id).join(', '))
    check(shouldRenderQuotaSection(renderInput({ windowCount: windows.length })), '有窗口 → 渲染')
    check(shouldRenderQuotaSection(renderInput({ hasMainText: true })), '有主值（即使窗口为空）→ 渲染')
  }

  /* 2. 失败 / 未返回窗口：必须留下并说明。 */
  {
    const failed = renderInput({ supported: true, hasMainText: false, windowCount: 0 })
    check(shouldRenderQuotaSection(failed), '已知支持额度接口的 provider 查询失败 → 仍渲染错误行')
    const oldHidden =
      !failed.provider ||
      (!failed.loading && !failed.hasMainText && failed.windowCount === 0 && !failed.hasBudget && failed.provider !== 'claude-bridge')
    check(oldHidden, '旧 guard 会把同样的状态整块隐藏（这就是「没有额度段」的原因）')
    const noWindows = commandCodeWindows({ windowLimits: { limited: false } })
    check(noWindows.length === 0, '接口没返回任何窗口时解析出 0 个窗口（不是编一个 0 额度）')
    check(shouldRenderQuotaSection(renderInput({ windowCount: noWindows.length })), '接口返回但没窗口 → 仍渲染，让原因可见')
  }

  /* 3. Promise 直接 reject：supported 还没回来，错误也要可见。 */
  {
    check(
      shouldRenderQuotaSection(renderInput({ supported: null, loading: false, hasError: true })),
      'Promise reject（supported === null）→ hasError 让错误行可见'
    )
    check(
      !shouldRenderQuotaSection(renderInput({ supported: false, hasError: true })),
      '明确不支持（supported === false）即使报错也不占空块'
    )
    check(
      !shouldRenderQuotaSection({
        provider: 'commandcode', loading: false, supported: null, hasError: false,
        hasMainText: false, windowCount: 0, hasBudget: false
      }),
      '还没查、也没有错误 → 不凭空占位'
    )
  }

  /* 4. 明确不支持 / 未知 provider */
  {
    check(!shouldRenderQuotaSection(renderInput({ provider: 'yan-local', supported: false })), '自定义 API（supported === false）→ 不渲染')
    check(!shouldRenderQuotaSection(renderInput({ provider: '' })), '没有 provider → 不渲染')
    check(shouldRenderQuotaSection(renderInput({ supported: null, loading: true })), '首次查询在飞 → 渲染占位，避免闪一下消失')
  }

  /* 5. 切换供应商：旧快照不得串供应商 */
  {
    const commandSnapshot = { provider: 'commandcode', supported: true, windows: commandCodeWindows(SNAPSHOT, Date.UTC(2026, 9, 21)) }
    check(quotaSnapshotMatchesProvider(commandSnapshot.provider, 'commandcode'), '同一 provider → 快照可用')
    check(!quotaSnapshotMatchesProvider(commandSnapshot.provider, 'deepseek'), '换到 deepseek → Command Code 快照作废')
    check(quotaSnapshotMatchesProvider('COMMANDCODE', ' commandcode '), '大小写 / 空白差异按同一 provider 处理')
    check(!quotaSnapshotMatchesProvider(undefined, 'commandcode'), '快照没有 provider → 不作数')
    const active = quotaSnapshotMatchesProvider(commandSnapshot.provider, 'deepseek') ? commandSnapshot : null
    check(active === null, '派生出的 quota 为 null（不会把 Command Code 的窗口留给 deepseek）')
  }

  /* 6. 真跑组件（脱敏 fixture，mock window.yan） */
  const dir = await mkdtemp(resolve(OUT, 'component-'))
  try {
    const { QuotaSection } = await loadQuotaComponent(dir)
    await runComponentScenarios(check, QuotaSection)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  /* 7. models.json 取 key 统一来源（auth/env > models.json，官方域校验，不执行命令） */
  await runQuotaCredentialSourceTests(check)

  /* 8. 状态栏入口（正式 main/quota.ts）与磁贴同源：models.json-only 官方 key 可取额度 */
  await runStatusBarModelsKeyTest(check)

  /* 9. 随包 commandcode 扩展：env-only 注册声明环境引用；有 models.json 时让位不覆盖 */
  await runCommandCodeExtensionAuthTest(check)
}

/* -------------------------------------------------------------- 直接运行入口 */

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let failed = 0
  const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`)
    else { failed++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
  }
  try {
    await runCommandCodeQuotaDisplayTests(ok)
    console.log(failed ? `\n✗ Command Code 额度显示：失败 ${failed} 项` : '\n✓ Command Code 额度显示：全部通过')
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
