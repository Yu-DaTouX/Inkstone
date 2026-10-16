import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = resolve('.tmp/fix-validation-20261015/account-quota-pane')

const resetAt = Date.now() + 3_600_000

const CMD_WINDOWS = [
  { id: 'fiveHour', label: '5 小时', used: 0.7, total: 14, resetAt, exceeded: false },
  { id: 'weekly', label: '每周', used: 1.6, total: 35, resetAt, exceeded: false },
  { id: 'monthly', label: '本月', used: 1.6, total: 70, resetAt, exceeded: false, estimated: true }
]

const ccProviderQuota = (over = {}) => ({
  provider: 'commandcode',
  supported: true,
  used: 1.6,
  total: 70,
  currency: 'USD',
  label: '本月已用',
  windows: CMD_WINDOWS,
  checkedAt: 1_700_000_000_000,
  ...over
})

const ccCard = (over = {}) => ({
  key: 'yan:commandcode',
  source: 'yan',
  provider: 'commandcode',
  name: 'Command Code',
  status: 'ok',
  windows: CMD_WINDOWS,
  checkedAt: 1_700_000_000_000,
  ...over
})

const report = (cards, over = {}) => ({
  cards,
  prefs: { sources: { 'codex-cli': false, 'claude-code': false, 'gemini-cli': false }, labels: {} },
  checkedAt: 1_700_000_000_000,
  ...over
})

function depsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function createHarness(component, initialStore, variant = 'section') {
  const root = { slots: [], cursor: 0 }
  let current = root
  const childContexts = []
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

  function runEffects(ctx) {
    for (const slot of ctx.slots) {
      if (!slot || slot.kind !== 'effect' || !slot.pending) continue
      slot.pending = false
      if (typeof slot.cleanup === 'function') { try { slot.cleanup() } catch { } }
      const cleanup = slot.effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  function renderNow() {
    root.cursor = 0
    childContexts.length = 0
    current = root
    tree = component({ variant })
    runEffects(root)
    for (const child of childContexts) runEffects(child)
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
      const i = current.cursor++
      let slot = current.slots[i]
      if (!slot || slot.kind !== 'state') { slot = { kind: 'state', value: typeof init === 'function' ? init() : init }; current.slots[i] = slot }
      return [slot.value, (v) => {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (Object.is(next, slot.value)) return
        slot.value = next
        schedule()
      }]
    },
    useRef(init) {
      const i = current.cursor++
      let slot = current.slots[i]
      if (!slot || slot.kind !== 'ref') { slot = { kind: 'ref', ref: { current: init } }; current.slots[i] = slot }
      return slot.ref
    },
    useCallback(fn, deps) {
      const i = current.cursor++
      let slot = current.slots[i]
      if (!slot || slot.kind !== 'callback' || !depsEqual(slot.deps, deps)) { slot = { kind: 'callback', fn, deps }; current.slots[i] = slot }
      return slot.fn
    },
    useMemo(fn, deps) {
      const i = current.cursor++
      let slot = current.slots[i]
      if (!slot || slot.kind !== 'memo' || !depsEqual(slot.deps, deps)) { slot = { kind: 'memo', value: fn(), deps }; current.slots[i] = slot }
      return slot.value
    },
    useEffect(fn, deps) {
      const i = current.cursor++
      const slot = current.slots[i]
      if (!slot || slot.kind !== 'effect') { current.slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: undefined } }
      else if (!depsEqual(slot.deps, deps)) { current.slots[i] = { kind: 'effect', effect: fn, deps, pending: true, cleanup: slot.cleanup } }
      else { slot.pending = false }
    },
    createElement(type, props, key) {
      const merged = { ...(props || {}) }
      if (key !== undefined) merged.key = key
      if (typeof type === 'function') {
        const child = { slots: [], cursor: 0 }
        childContexts.push(child)
        const previous = current
        current = child
        let out
        try { out = type(merged) } finally { current = previous }
        return out
      }
      return { __el: true, type, props: merged }
    }
  }
  return runtime
}

function collect(node, out = { testids: [], text: [], els: [] }) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (typeof node === 'object' && node.__el) {
    const props = node.props || {}
    out.els.push(props)
    if (typeof props['data-testid'] === 'string') out.testids.push(props['data-testid'])
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

const REACT_FIXTURE = `
const rt = () => globalThis.__acctHarness
export const useState = (...a) => rt().useState(...a)
export const useRef = (...a) => rt().useRef(...a)
export const useCallback = (...a) => rt().useCallback(...a)
export const useEffect = (...a) => rt().useEffect(...a)
export const useMemo = (...a) => rt().useMemo(...a)
`
const JSX_FIXTURE = `
const rt = () => globalThis.__acctHarness
export const Fragment = Symbol.for('acct.Fragment')
export const jsx = (type, props, key) => rt().createElement(type, props, key)
export const jsxs = jsx
export const jsxDEV = jsx
`
const I18N_FIXTURE = `export const useT = () => (key, vars) => (vars ? key + '|' + JSON.stringify(vars) : key)`
const STORE_FIXTURE = `export const useStore = (selector) => selector(globalThis.__acctHarness.store)`
const CONFIRM_FIXTURE = `export const useConfirm = () => async () => true`
const MARK_FIXTURE = `export const AgentMark = (props) => ({ __el: true, type: 'AgentMark', props: props || {} })`
const QUOTA_RESET_FIXTURE = `export const resetText = () => ({ text: '', tip: '' })`

const UI_FIXTURE = `
const el = (type) => (props) => ({ __el: true, type, props: props || {} })
export const Button = el('Button')
export const IconButton = el('IconButton')
export const Input = el('Input')
export const Badge = el('Badge')
export const Disclosure = el('Disclosure')
export const EmptyState = el('EmptyState')
export const SettingRow = el('SettingRow')
export const Spinner = el('Spinner')
export const Switch = el('Switch')
export const MiniMeter = el('MiniMeter')
`
const TOOL_SECTION_FIXTURE = `export function Section({ children, extra, ...rest }) { return { __el: true, type: 'Section', props: { ...rest, extra, children } } }`
const DETAIL_POPOVER_FIXTURE = `export function DetailTrigger({ children, panel, ...rest }) { return { __el: true, type: 'DetailTrigger', props: { ...rest, panel, children } } }`

function componentFixtures() {
  const byPath = {
    react: REACT_FIXTURE,
    'jsx-runtime': JSX_FIXTURE,
    i18n: I18N_FIXTURE,
    store: STORE_FIXTURE,
    confirm: CONFIRM_FIXTURE,
    ui: UI_FIXTURE,
    mark: MARK_FIXTURE,
    'quota-reset': QUOTA_RESET_FIXTURE,
    'tool-section': TOOL_SECTION_FIXTURE,
    'detail-popover': DETAIL_POPOVER_FIXTURE
  }
  return {
    name: 'account-quota-pane-fixtures',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /\/i18n$/ }, () => ({ path: 'i18n', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /\/ui\/confirm$/ }, () => ({ path: 'confirm', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /\/ui$/ }, () => ({ path: 'ui', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /AgentMark$/ }, () => ({ path: 'mark', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /\/QuotaSection$/ }, () => ({ path: 'quota-reset', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /ToolSection$/ }, () => ({ path: 'tool-section', namespace: 'acct-fixture' }))
      b.onResolve({ filter: /DetailPopover$/ }, () => ({ path: 'detail-popover', namespace: 'acct-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'acct-fixture' }, (args) => ({ contents: byPath[args.path], loader: 'js' }))
    }
  }
}

async function loadComponent(entry, outName) {
  const outfile = join(OUT, outName)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [componentFixtures()]
  })
  return import(pathToFileURL(outfile).href)
}

const MAIN_STUBS = {
  electron: `export const net = { fetch: async () => { throw new Error('test: no network') } }`,
  credentials: `
export const readAuthEntry = async (p) => globalThis.__acctScenario?.authEntry?.[p]
`,
  quota: `
export const providerQuota = async (p, budget) => globalThis.__acctScenario.quota(p, budget)
export const fetchCodexUsage = async () => { throw new Error('test: codex usage not stubbed') }
`,
  'codex-accounts': `
export const codexAccountTargets = async () => globalThis.__acctScenario?.codexTargets ?? []
export const switchCodexAccount = async () => ({ ok: false, error: 'test: not stubbed' })
`
}

async function loadAccountQuotaMain() {
  const outfile = join(OUT, 'account-quota-main.mjs')
  await build({
    entryPoints: ['src/main/account-quota.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'account-quota-main-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/credentials$/ }, () => ({ path: 'credentials', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/quota$/ }, () => ({ path: 'quota', namespace: 'acct-main-stub' }))
        b.onResolve({ filter: /^\.\/codex-accounts$/ }, () => ({ path: 'codex-accounts', namespace: 'acct-main-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'acct-main-stub' }, (args) => ({ contents: MAIN_STUBS[args.path], loader: 'js' }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

async function runMainReportScenarios(check, main, piDir) {
  const setScenario = (scenario) => { globalThis.__acctScenario = scenario }
  const modelsFile = join(piDir, 'models.json')
  await mkdir(piDir, { recursive: true })
  try {
    setScenario({
      authEntry: { commandcode: { type: 'api_key', key: 'user_test_key' } },
      quota: async (p) => (p === 'commandcode' ? ccProviderQuota() : { provider: p, supported: false, error: 'unsupported' })
    })
    let r = await main.accountQuotaReport()
    let cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, '有 key → Command Code 卡出现')
    check(cc?.status === 'ok', '有 key → 卡片状态 ok')
    check(cc?.windows.map((w) => w.id).join(',') === 'fiveHour,weekly,monthly', '有 key → 5h / 周 / 月三个窗口')
    check(cc?.windows.find((w) => w.id === 'monthly')?.estimated === true, '月窗口标 estimated（推算，不是官方字段）')
    check(cc?.windows.filter((w) => w.id !== 'monthly').every((w) => !w.estimated), '官方 5h / 周窗口不标 estimated')

    setScenario({ authEntry: {}, quota: async () => { throw new Error('should not be called') } })
    r = await main.accountQuotaReport()
    check(!r.cards.some((c) => c.provider === 'commandcode'), '没有 key → 不生成 Command Code 卡')

    setScenario({ authEntry: { commandcode: { type: 'api_key', key: 'user_test_key' } }, quota: async () => { throw new Error('HTTP 429') } })
    r = await main.accountQuotaReport()
    cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, '查询 reject → 卡片仍存在（不静默消失）')
    check(cc?.status === 'error' && cc?.error === 'HTTP 429', '查询 reject → 卡片带错误原因')
    check(cc?.windows.length === 0, '查询 reject → 不补 0 窗口')

    setScenario({
      authEntry: {
        commandcode: { type: 'api_key', key: 'user_test_key' },
        deepseek: { type: 'api_key', key: 'sk-test' }
      },
      quota: async (p) => p === 'commandcode'
        ? ccProviderQuota()
        : p === 'deepseek'
          ? { provider: 'deepseek', supported: true, remaining: 12.5, currency: 'CNY', checkedAt: 1 }
          : { provider: p, supported: false, error: 'unsupported' }
    })
    r = await main.accountQuotaReport()
    const byProvider = new Map(r.cards.map((c) => [c.provider, c]))
    check(byProvider.get('commandcode')?.windows.length === 3 && !byProvider.get('commandcode')?.balance, 'commandcode 卡只带自己的窗口')
    check(byProvider.get('deepseek')?.balance?.amount === 12.5 && byProvider.get('deepseek')?.windows.length === 0, 'deepseek 卡只带自己的余额，不串 commandcode 窗口')

    await writeFile(modelsFile, JSON.stringify({
      providers: { commandcode: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_models_only' } }
    }))
    setScenario({ authEntry: {}, quota: async (p) => (p === 'commandcode' ? ccProviderQuota() : { provider: p, supported: false, error: 'unsupported' }) })
    r = await main.accountQuotaReport()
    cc = r.cards.find((c) => c.provider === 'commandcode')
    check(!!cc, 'models.json-only 官方 key → Command Code 卡出现（此前会整张消失）')
    check(cc?.status === 'ok' && cc?.windows.length === 3, 'models.json-only 官方 key → 拿到三窗口')

    for (const [label, entry] of [
      ['代理域', { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_proxy_key' }],
      ['非 https', { baseUrl: 'http://api.commandcode.ai/provider/v1', apiKey: 'user_http_key' }],
      ['命令型', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: '!echo secret' }],
      ['缺少 baseUrl', { apiKey: 'user_no_base_key' }],
      ['per-model 代理', { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'user_mixed_key', models: [{ id: 'cc', baseUrl: 'https://api.commandcode.ai.evil.test/v1' }] }]
    ]) {
      await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: entry } }))
      setScenario({ authEntry: {}, quota: async () => { throw new Error('should not be called') } })
      r = await main.accountQuotaReport()
      check(!r.cards.some((c) => c.provider === 'commandcode'), `models.json ${label} → 不产 Command Code 卡，也不取 key`)
    }

    await writeFile(modelsFile, JSON.stringify({ providers: { commandcode: { baseUrl: 'https://api.commandcode.ai.evil.test/v1', apiKey: 'user_proxy_key' } } }))
    const priorKey = process.env.COMMANDCODE_API_KEY
    process.env.COMMANDCODE_API_KEY = 'user_env_sentinel'
    try {
      setScenario({
        authEntry: { commandcode: { type: 'api_key', key: 'user_auth_sentinel' } },
        quota: async () => { throw new Error('should not be called') }
      })
      r = await main.accountQuotaReport()
      check(!r.cards.some((c) => c.provider === 'commandcode'), '代理条目 + auth/env key → 不产 Command Code 卡')
    } finally {
      if (priorKey === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = priorKey
    }
    await rm(modelsFile, { force: true })
  } finally {
    delete globalThis.__acctScenario
  }
}

async function runPaneComponentScenarios(check, AccountQuotaPane, QuotaSection) {
  const real = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    harness: Object.getOwnPropertyDescriptor(globalThis, '__acctHarness')
  }
  const focusListeners = []
  let currentQuota = null
  let accountCalls = []

  globalThis.document = { visibilityState: 'visible' }
  globalThis.window = {
    yan: {
      accountQuota: () => currentQuota(),
      providerQuota: () => currentQuota(),
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

  const makePane = (store = {}) => {
    focusListeners.length = 0
    const runtime = createHarness(AccountQuotaPane, { session: { model: { provider: 'commandcode' }, sessionId: 's1' }, ...store })
    globalThis.__acctHarness = runtime
    const read = () => collect(runtime.tree)
    return {
      runtime,
      store: runtime.store,
      cardOrder: () => read().els.filter((p) => typeof p['data-testid'] === 'string' && p['data-testid'].startsWith('acct-card-')).map((p) => p['data-testid']),
      hasTestId: (id) => read().testids.includes(id),
      text: () => read().text.join(' '),
      start: async () => { runtime.renderNow(); await flush() },
      setProvider: async (provider) => { runtime.setStore({ ...runtime.store, session: { ...runtime.store.session, model: { provider } } }); await flush() },
      flush
    }
  }

  const makeStatus = () => {
    focusListeners.length = 0
    const runtime = createHarness(QuotaSection, {
      session: { model: { provider: 'commandcode' }, sessionId: 's1' },
      settings: { providerBudgets: {} },
      patchSettings: async () => {},
      setQuotaFailover: () => {},
      setKeepRunning: () => {}
    }, 'status')
    globalThis.__acctHarness = runtime
    const read = () => collect(runtime.tree)
    return { runtime, text: () => read().text.join(' '), hasTestId: (id) => read().testids.includes(id), start: async () => { runtime.renderNow(); await flush() } }
  }

  try {
    {
      accountCalls = []
      currentQuota = async () => { accountCalls.push(1); return report([ccCard()]) }
      const h = makePane()
      await h.start()
      check(h.hasTestId('accounts-pane'), '账号额度磁贴正文渲染（accounts-pane，可达现代入口）')
      check(h.hasTestId('acct-card-yan-commandcode'), 'Command Code 卡渲染')
      check(h.hasTestId('acct-win-fiveHour') && h.hasTestId('acct-win-weekly') && h.hasTestId('acct-win-monthly'), '渲染 5h / 周 / 月三个窗口')
      check(h.hasTestId('acct-win-monthly-estimated'), '月窗口带 estimated 标记（沿用额度浮层窗口语言）')
      check(!h.hasTestId('acct-win-fiveHour-estimated') && !h.hasTestId('acct-win-weekly-estimated'), '官方窗口不带 estimated 标记')
    }

    {
      currentQuota = async () => report([{ key: 'yan:deepseek', source: 'yan', provider: 'deepseek', name: 'DeepSeek', status: 'ok', windows: [], checkedAt: 1, balance: { label: '余额', amount: 5, currency: 'CNY' } }])
      const h = makePane()
      await h.start()
      check(!h.hasTestId('acct-card-yan-commandcode'), '没有 key 的报告 → 不伪造 Command Code 卡')
      check(h.hasTestId('acct-card-yan-deepseek'), '其它账号照常显示，不受影响')
    }

    {
      currentQuota = async () => { throw new Error('网络错误') }
      const h = makePane()
      await h.start()
      check(h.text().includes('acct.failed') && h.text().includes('网络错误'), '首次查询 reject → 显示失败原因')
      check(!h.hasTestId('acct-card-yan-commandcode'), 'reject 且无旧数据 → 不伪造卡片')
    }

    {
      let n = 0
      currentQuota = async () => {
        n++
        if (n === 1) return report([ccCard()], { checkedAt: Date.now() - 10 * 60_000 })
        throw new Error('HTTP 429')
      }
      const h = makePane()
      await h.start()
      check(h.hasTestId('acct-win-monthly'), 'stale 前先渲染成功数据')
      for (const fn of focusListeners) fn()
      await h.flush()
      check(n === 2, '快照超过自动刷新间隔后，获得焦点触发重查')
      check(h.hasTestId('acct-win-monthly'), '重查失败仍保留上次成功的窗口')
      check(h.text().includes('quota.stale') && h.text().includes('HTTP 429'), 'stale 时注明数据来源与本次失败原因')
      check(h.hasTestId('acct-win-monthly-estimated'), 'stale 保留的月窗口仍带 estimated 标记')
    }

    {
      currentQuota = async () => report([
        { key: 'yan:deepseek', source: 'yan', provider: 'deepseek', name: 'DeepSeek', status: 'ok', windows: [], checkedAt: 1 },
        ccCard()
      ])
      const h = makePane({ session: { model: { provider: 'commandcode' }, sessionId: 's1' } })
      await h.start()
      check(h.cardOrder()[0] === 'acct-card-yan-commandcode', '当前 provider 为 commandcode → 它的卡排最前')
      await h.setProvider('deepseek')
      check(h.cardOrder()[0] === 'acct-card-yan-deepseek', '切到 deepseek → 排序切到 deepseek 卡')
      check(h.cardOrder().length === 2, '快切只重排已有卡，不增减卡片')
    }

    {
      currentQuota = () => ccProviderQuota()
      const status = makeStatus()
      await status.start()
      currentQuota = async () => report([ccCard()])
      const pane = makePane()
      await pane.start()
      const pct = (used, total) => ((used / total) * 100).toFixed(1)
      for (const [id, used, total] of [['fiveHour', 0.7, 14], ['weekly', 1.6, 35], ['monthly', 1.6, 70]]) {
        const expected = pct(used, total)
        check(status.text().includes(expected), `状态栏显示 ${id} 的 raw 百分比 ${expected}%`)
        check(pane.text().includes(expected), `账号卡显示同一 ${id} 的 raw 百分比 ${expected}%`)
      }
      check(status.hasTestId('quota-win-monthly-estimated'), '状态栏月窗口标 estimated')
      check(pane.hasTestId('acct-win-monthly-estimated'), '账号卡月窗口标 estimated（两处一致）')
    }
  } finally {
    currentQuota = null
    accountCalls = []
    if (real.harness) Object.defineProperty(globalThis, '__acctHarness', real.harness); else delete globalThis.__acctHarness
    if (real.window) Object.defineProperty(globalThis, 'window', real.window); else delete globalThis.window
    if (real.document) Object.defineProperty(globalThis, 'document', real.document); else delete globalThis.document
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
  }
}

export async function runAccountQuotaPaneTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (cond, label, extra = '') => { if (!cond) throw new Error(`账号额度磁贴：${label}${extra ? ' ' + extra : ''}`) }

  await mkdir(OUT, { recursive: true })

  const iso = await mkdtemp(join(tmpdir(), 'yan-acct-pane-'))
  const priorData = process.env.YAN_DATA_DIR
  const priorPi = process.env.YAN_PI_DIR
  process.env.YAN_DATA_DIR = iso
  process.env.YAN_PI_DIR = join(iso, 'pi')

  try {
    await build({ entryPoints: ['src/shared/account-quota.ts'], outfile: join(OUT, 'account-quota-shared.mjs'), bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
    const shared = await import(pathToFileURL(join(OUT, 'account-quota-shared.mjs')).href)
    {
    const d = { key: 'yan:deepseek', source: 'yan', provider: 'deepseek', name: 'DeepSeek', status: 'ok', windows: [], checkedAt: 0 }
    const ordered = shared.orderAccountCardsForProvider([d, ccCard(), { ...ccCard(), key: 'yan:openrouter', provider: 'openrouter' }], 'commandcode')
    check(ordered[0].provider === 'commandcode', '选择器：当前 provider 提到首位')
    check(ordered.slice(1).map((c) => c.provider).join(',') === 'deepseek,openrouter', '选择器：其余保持原有相对顺序（稳定）')
    const none = shared.orderAccountCardsForProvider([d], 'commandcode')
    check(none.length === 1 && none[0].provider === 'deepseek', '选择器：没有对应卡时不新建卡、顺序不变')
    check(shared.orderAccountCardsForProvider([d, ccCard()], '').map((c) => c.provider).join(',') === 'deepseek,commandcode', '选择器：没有当前 provider 时顺序不变')
    check(shared.orderAccountCardsForProvider([d, ccCard()], 'COMMANDCODE')[0].provider === 'commandcode', '选择器：provider 大小写不敏感')
    check(!shared.orderAccountCardsForProvider([d], 'unsupported').some((c) => c.provider === 'unsupported'), '选择器：未知 / 不支持的 provider 不伪造卡')
  }

  const main = await loadAccountQuotaMain()
  await runMainReportScenarios(check, main, join(iso, 'pi'))

  const dir = await mkdtemp(join(OUT, 'component-'))
  try {
    const { AccountQuotaPane } = await loadComponent('src/renderer/src/components/toolbar/AccountQuotaPane.tsx', 'account-quota-pane.mjs')
    const { QuotaSection } = await loadComponent('src/renderer/src/components/toolbar/QuotaSection.tsx', 'quota-section-test.mjs')
    await runPaneComponentScenarios(check, AccountQuotaPane, QuotaSection)

    const hostActions = await (async () => {
      await build({ entryPoints: ['src/renderer/src/lib/host-actions.ts'], outfile: join(OUT, 'host-actions.mjs'), bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
      return import(pathToFileURL(join(OUT, 'host-actions.mjs')).href)
    })()
    const launch = hostActions.HOST_ACTIONS.find((a) => a.id === 'launchAccounts')
    check(launch?.tool === 'accounts', '宿主动作表：launchAccounts 打开 accounts 工具（现代入口）')
    check(hostActions.HOST_ACTIONS.filter((a) => a.section === 'tools').some((a) => a.tool === 'accounts'), '工具区存在 accounts 启动项')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
} finally {
    await rm(iso, { recursive: true, force: true }).catch(() => undefined)
    if (priorData === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = priorData
    if (priorPi === undefined) delete process.env.YAN_PI_DIR; else process.env.YAN_PI_DIR = priorPi
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let failed = 0
  const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`)
    else { failed++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
  }
  try {
    await runAccountQuotaPaneTests(ok)
    console.log(failed ? `\n✗ 账号额度磁贴：失败 ${failed} 项` : '\n✓ 账号额度磁贴：全部通过')
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
