import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-subagent-quota-toast-'))
const fixtureModules = {
  './quota': `export const providerQuota = (provider) => globalThis.quotaFixture.check(provider)`,
  './codex-accounts': `
    export const listCodexAccounts = async () => ['old', 'spare']
    export const findActiveCodexAccountKey = async () => globalThis.quotaFixture.active.codex
    export const switchCodexAccount = async (key) => {
      globalThis.quotaFixture.switches.push(key)
      globalThis.quotaFixture.active.codex = key
      return { ok: true }
    }
  `,
  './oauth-accounts': `
    export const oauthAccountTargets = async () => []
    export const findActiveOAuthAccountKey = async () => globalThis.quotaFixture.active.oauth
    export const switchOAuthAccount = async () => ({ ok: false })
  `,
  './account-quota': `
    export const accountQuotaReport = () => globalThis.quotaFixture.report()
    export const invalidateAccountQuotaReport = () => {}
  `,
  './settings': `export const getSettings = async () => ({ accountFailover: true })`,
  './api-key-pool': `export const captureActiveApiKey = async () => ({ ok: true })`
}
const rendererModules = {
  react: `
    export const useEffect = (effect) => globalThis.quotaFixture.effects.push(effect)
    export const useRef = (current) => ({ current })
  `,
  '../i18n': `export const useT = () => () => ''`,
  '../state/store': `
    export const useStore = (select) => select(globalThis.quotaFixture.view)
    useStore.getState = () => globalThis.quotaFixture.view
    useStore.subscribe = (fn) => {
      globalThis.quotaFixture.render = fn
      return () => { globalThis.quotaFixture.render = undefined }
    }
  `,
  '../ui': `
    export const toastQueue = {
      close: (key) => globalThis.quotaFixture.closed.push(key),
      subscribe: () => () => {}, visibleToasts: []
    }
    export const showToast = (title, options) => String(globalThis.quotaFixture.shown.push({ title, ...options }))
    export const ToastRegion = () => null
  `
}

async function compile(name, source, fixtures, matches, extra = {}) {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    stdin: { contents: source, resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', ...extra,
    plugins: [{ name: 'quota-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(fixtures, args.path) && matches(args.importer) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: fixtures[args.path] }))
    } }]
  })
  return import(pathToFileURL(outfile).href)
}

function createRpc() {
  const listeners = new Map()
  return {
    commands: [],
    on(event, listener) { listeners.set(event, listener) },
    running: false,
    spawn() { this.running = true },
    async close() { this.running = false },
    async command(type, payload) {
      this.commands.push({ type, payload })
      return { success: true, data: {} }
    },
    event(evt) { listeners.get('event')?.(evt) }
  }
}

function hitQuota(rpc) {
  const errorMessage = "You've hit your usage limit. Your limit resets at 5pm."
  rpc.event({ type: 'turn_start' })
  rpc.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage } })
  rpc.event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage })
  rpc.event({ type: 'auto_retry_end', success: false, finalError: errorMessage })
  rpc.event({ type: 'agent_settled', aborted: true })
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000
  do {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.fail(label)
}

const minute = 60_000
const windowOf = (used, resetMinutes) => ({ id: 'five', label: '5h', used, total: 100, ...(resetMinutes !== undefined ? { resetAt: Date.now() + resetMinutes * minute } : {}) })
const fixture = globalThis.quotaFixture = {
  effects: [], shown: [], closed: [], view: { subagents: [], notices: [] },
  active: { codex: 'old', oauth: 'anthropic-old' }, switches: [], probes: [],
  windows: { 'openai-codex': windowOf(4), anthropic: windowOf(100, 5) },
  exhausted: { old: false, spare: true },
  gate: undefined, reports: 0,
  check(provider) {
    this.probes.push(provider)
    const window = this.windows[provider]
    return Promise.resolve(window ? { windows: [window] } : { error: '暂时读不到额度' })
  },
  async report() {
    this.reports++
    await this.gate
    return { cards: ['old', 'spare'].map((key) => ({
      key, active: this.active.codex === key, label: key, provider: 'openai-codex', source: 'yan', switchable: true,
      status: this.exhausted[key] ? 'limited' : 'ok', windows: [windowOf(this.exhausted[key] ? 100 : 4)]
    })) }
  }
}

let host, controller, cleanup = []
try {
  const { NoticeBridge } = await compile('renderer', `export { NoticeBridge } from './src/renderer/src/app/NoticeBridge.tsx'`, rendererModules, (path) => path.endsWith('NoticeBridge.tsx'), { jsx: 'automatic' })
  globalThis.document = { documentElement: { style: { setProperty() {}, removeProperty() {} } } }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  NoticeBridge()
  cleanup = fixture.effects.map((effect) => effect())
  const { SubagentController, createRunsHost, createSubagentQuotaWatch, activeAccountKey, switchToSpareAccount } = await compile('host', `
    export { SubagentController } from './src/main/subagents.ts'
    export { createRunsHost } from './src/main/runs-host.ts'
    export { createSubagentQuotaWatch } from './src/main/subagent-quota-watch.ts'
    export { activeAccountKey, switchToSpareAccount } from './src/main/account-autoswitch.ts'
  `, fixtureModules, (path) => /(?:account-autoswitch|subagent-quota-watch)\.ts$/.test(path))
  const pushes = [], notices = [], rpcs = [], reports = []
  host = await createRunsHost({ root: join(dir, 'runs'), push: (push) => pushes.push(push) })
  host.observerFor()({ sessionId: 'parent' }, { type: 'agent-start' })
  await waitFor(() => host.snapshot().runs.length === 1, '父运行登记')
  const watch = createSubagentQuotaWatch({
    activeAccount: activeAccountKey,
    async switchAccount(provider, options) {
      const account = await switchToSpareAccount(provider, options)
      reports.push({ provider, options, account })
      if (account) void controller.quotaAccountChanged(provider, account)
      return account
    },
    notifyParent: (run) => notices.push(run.id)
  })
  controller = new SubagentController({
    cwd: dir, archiveDir: join(dir, 'subagents'), parentSessionId: 'parent', quotaWatch: watch,
    prepare: async (cwd, _id, isolation) => ({ cwd, rootCwd: cwd, isolation }),
    createRpc: () => { const rpc = createRpc(); rpcs.push(rpc); return rpc },
    onEvent: (_id, event, run) => host.observeSubagentEvent(run, event),
    onChange(run) {
      const previous = fixture.view
      fixture.view = { ...previous, subagents: [...previous.subagents.filter((other) => other.id !== run.id), run] }
      fixture.render?.(fixture.view, previous)
    },
    onFinished: (run) => host.settleSubagent(run, run.status === 'done' ? 'done' : run.status === 'error' ? 'failed' : 'stopped', run.error)
  })
  const start = async (model = 'openai-codex/test') => {
    const result = await controller.start('额度测试', model, 'shared-cwd')
    assert.equal(result.ok, true, result.error)
    const { id } = result.run
    const rpc = rpcs.at(-1)
    return {
      id, rpc, get state() { return controller.get(id) },
      get phase() { return host.snapshot().runs.find((run) => run.sessionId === `subagent:${id}`)?.phase.kind },
      get prompts() { return rpc.commands.filter((command) => command.type === 'prompt').length }
    }
  }

  const a = await start()
  const b = await start()
  const other = await start('anthropic/test')
  for (const child of [a, b, other]) hitQuota(child.rpc)
  await waitFor(() => notices.length === 3, '所有代理均进入等待')
  assert.equal(a.phase, 'stalled')
  assert.equal(b.phase, 'stalled')
  assert.equal(other.phase, 'stalled')
  assert.deepEqual(reports.filter(({ provider }) => provider === 'openai-codex').map(({ options, account }) => [options.failedKey, account]), [['old', null], ['old', null]], '额度接口仍未报满，也查备用号但不能继续用刚撞限的账号')
  assert.equal(fixture.shown.length, 1, '同 provider 只弹一条；单账号/短等待不需要人工处理')
  assert.match(fixture.shown[0].title, /openai-codex/)
  await controller.quotaAccountChanged('openai-codex')
  assert.equal(a.prompts + b.prompts, 2, '人工切换回调但账号未变时不续跑')

  fixture.exhausted.spare = false
  const c = await start()
  let release
  fixture.gate = new Promise((resolve) => { release = resolve })
  hitQuota(c.rpc)
  await waitFor(() => fixture.reports === 3 && c.phase === 'stalled', '自动换号查询期间仍是非终态')
  c.rpc.event({ type: 'agent_settled', aborted: true })
  release()
  await waitFor(() => [a, b, c].every((child) => child.prompts === 2), '换号立即唤醒兄弟，无需等 60 秒轮询')
  assert.deepEqual(fixture.switches, ['spare'])
  assert.equal(fixture.reports, 3, '重复原生结束事件不再开启换号')
  assert.equal(other.prompts, 1, '没有跨 provider 唤醒')
  assert.deepEqual(fixture.closed, ['1'], '撤回旧额度 Toast')
  assert.equal(fixture.shown.length, 1, '自动换号不弹成功 Toast')
  assert.ok([a, b, c].every((child) => child.phase === 'running' && !child.state.quotaWait))
  assert.equal(fixture.probes.filter((provider) => provider === 'openai-codex').length, 3, '无需再次查询额度才能唤醒')

  fixture.active.oauth = 'anthropic-new'
  await controller.quotaAccountChanged()
  assert.equal(other.prompts, 2, '外部换号通知按新的活动账号即时续跑')
  for (const child of [a, b, c, other]) {
    child.rpc.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } })
    child.rpc.event({ type: 'agent_settled' })
  }
  await waitFor(() => [a, b, c, other].every((child) => child.phase === 'done'), '成功收口，无旧额度错误残留')
  assert.ok(!pushes.some((push) => push.payload?.upsert?.some((run) => run.phase.kind === 'failed')), '自愈过程未推失败状态')

  fixture.active.codex = 'old'
  const opts = { quotaExhausted: true, failedKey: 'old' }
  const [winner, follower] = await Promise.all([switchToSpareAccount('openai-codex', opts), switchToSpareAccount('openai-codex', opts)])
  assert.deepEqual([winner, follower].map(({ key, switched }) => [key, switched]), [['spare', true], ['spare', false]])
  assert.deepEqual(fixture.switches, ['spare', 'spare'], '并发只写入一次新账号，后到者使用已切好的账号')
  assert.equal(await watch.switchAccount(c.state, 'old'), 'spare', 'switched: false 不视为没有可换账号')

  fixture.windows['openai-codex'] = undefined
  fixture.active.codex = 'old'
  const missingQuota = await start()
  hitQuota(missingQuota.rpc)
  await waitFor(() => missingQuota.prompts === 2, '活动账号额度接口无数据时也先尝试换号')
  assert.equal(fixture.shown.length, 1)

  fixture.windows['openai-codex'] = windowOf(100, 120)
  fixture.exhausted.old = true
  fixture.exhausted.spare = true
  const failed = await start()
  hitQuota(failed.rpc)
  await waitFor(() => failed.phase === 'failed', '真正无法换号且放弃等待时才进 failed')
  assert.equal(failed.state.status, 'error')
  assert.equal(failed.prompts, 1)
  assert.equal(fixture.shown.length, 1)
  console.log('subagent-quota-toast: 缓存滞后、并发择号、即时唤醒、run 终态与撤回 Toast 全部通过')
} finally {
  await controller?.stopAll()
  await host?.dispose()
  for (const dispose of cleanup.reverse()) dispose?.()
  await rm(dir, { recursive: true, force: true })
}
