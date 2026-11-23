import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { delimiter, join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runSuite } from './lib/test-suite.mjs'
import { agentTestBuildOptions } from './lib/agent-test-bundle.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { ANTIGRAVITY_DEFAULT_MODE } = await compile('src/shared/antigravity.ts')
  const { AntigravityHandoffLimitError, AntigravitySession, antigravityExecutable, antigravityPrompt, normalizeAntigravityImages, scheduleAntigravityToolIdleTimeout } = await compile('src/main/antigravity.ts')
  const longHistory = [{ role: 'user', text: 'A' + 'x'.repeat(110_000) + 'Z' }, { role: 'assistant', text: '答复', thinking: 'internal thought should be omitted', toolCalls: [{ id: 'tc-1', name: 'read', status: 'ok', args: { Path: 'a.ts' }, output: 'ok', details: { antigravity: true, kind: 'read', antigravityDiffs: [{ path: 'a.ts', patch: 'huge-diff' }] }, startedAt: 1, endedAt: 2 }] }]
  const handoff = antigravityPrompt('继续', longHistory)
  ok(handoff.startsWith('Current user message:\n继续\n') && handoff.includes(longHistory[0].text) && !handoff.includes('internal thought should be omitted') && !handoff.includes('huge-diff'), '超过旧字符上限但在安全字节内时置顶当前消息、交接完整历史并剔除 UI 冗余字段')
  const withLocalizedImage = antigravityPrompt('看图', [{ role: 'user', text: '旧图', images: [{ mimeType: 'image/png', data: '', url: 'file:///a.png' }, { mimeType: 'image/jpeg', data: '' }] }])
  ok(withLocalizedImage.includes('"url":"file:///a.png"') && !withLocalizedImage.includes('"data":""'), '交接历史保留本地图片 URL，不发送空 data 字段')
  assert.throws(() => antigravityPrompt('a'.repeat(100_001), []), /消息太长/)
  assert.throws(() => antigravityPrompt('继续', [{ role: 'user', text: '砚'.repeat(110_000) }]), (err) => err instanceof AntigravityHandoffLimitError && err.bytes > err.limit && /历史未裁剪/.test(err.message))
  ok(true, '分别限制新消息字符数和冷交接安全字节数，防止触发 CLI 静默截断')
  const { parseAntigravityQuota, createAntigravityQuota, readAntigravityQuotaOutput } = await compile('src/main/antigravity-quota.ts')
  const quota = { status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [{
    name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.925, reset_time: '2026-11-21T00:30:00Z' },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0 },
      { id: 'disabled', name: 'Disabled', status: 'disabled', remaining_fraction: 1 },
      { id: 'missing', name: 'Missing', remaining_fraction: null },
      { id: 'invalid', name: 'Invalid', remaining_fraction: 2 }
    ]
  }] } } }
  const [group] = parseAntigravityQuota(JSON.stringify(quota))
  ok(group.models.join(',') === 'Gemini 4 Neon,Gemini 3.8 Flash' && group.windows.length === 2 &&
    group.windows[0].resetAt === Date.parse('2026-11-21T00:30:00Z') && group.windows[0].remainingFraction === 0.925 &&
    group.windows[1].remainingFraction === 0 && group.windows[1].resetAt === undefined, '官方额度 JSON 保留分组、剩余数和时间，忽略无效或禁用窗口')
  ok(parseAntigravityQuota(JSON.stringify({ ...quota, num_turns: 1 })).length === 0 &&
    parseAntigravityQuota(JSON.stringify({ ...quota, command: { ...quota.command, name: 'model' } })).length === 0, '仅接受零模型回合的 usage 命令结果')
  const parseResetGroups = (...groups) => parseAntigravityQuota(JSON.stringify({ ...quota, command: { ...quota.command, data: { groups } } }))
  const buckets = quota.command.data.groups[0].buckets
  const [inactive, mixed, argon] = parseResetGroups(
    { name: 'Claude and GPT models', buckets: [
      { ...buckets[0], remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      { ...buckets[1], remaining_fraction: 1, reset_time: 'not-a-date' },
      { ...buckets[0], id: 'old', reset_time: '2019-12-31T23:59:59Z' }
    ] },
    { name: 'Gemini Models', buckets: [
      { ...buckets[0], reset_time: '0001-01-01T00:00:00Z' },
      { ...buckets[1], reset_time: '2020-01-01T00:00:00Z' }
    ] },
    { name: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.', buckets: [
      { id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-29T02:33:32Z' }
    ] }
  )
  ok(inactive.windows.length === 3 && inactive.windows.every((window) => !Object.hasOwn(window, 'resetAt')), '零时间、无效日期及早于有效纪元的时间不输出 resetAt，额度窗口保留')
  ok(!Object.hasOwn(mixed.windows[0], 'resetAt') && mixed.windows[1].resetAt === Date.UTC(2020, 0, 1), '部分有效时独立保留有效窗口，包含纪元下界')
  ok(argon.windows.length === 1 && !Object.hasOwn(argon.windows[0], 'resetAt') && argon.models.length === 0 && argon.description === 'For paid Pro plans, Argon quota is separate.', '满额未消耗的滚动窗口（如 Gemini 4 Argon）不输出滚动占位 resetAt，并保留分组说明')

  {
    let time = 1000
    let reads = 0
    let query = () => [group]
    const refresh = createAntigravityQuota(() => { reads++; return query() }, () => time)
    const initial = refresh()
    assert.equal(refresh(true), initial)
    const fresh = await initial
    time += 4999
    assert.equal(await refresh(true), fresh)
    assert.equal(reads, 1)
    time++
    query = () => { throw Object.assign(new Error('timeout'), { killed: true }) }
    const stale = await refresh(true)
    assert.deepEqual(stale.groups, fresh.groups)
    assert.equal(stale.staleSince, fresh.checkedAt)
    assert.match(stale.error, /超时/)
    time += 1999
    assert.equal(await refresh(true), stale)
    assert.equal(await refresh(), stale)
    assert.equal(reads, 2)
    time++
    query = () => readAntigravityQuotaOutput('{broken', '')
    const malformed = await refresh(true)
    assert.equal(malformed.staleSince, fresh.checkedAt)
    time += 9999
    assert.equal(await refresh(), malformed)
    time = fresh.checkedAt + 300_000
    assert.deepEqual((await refresh()).groups, [])
    assert.equal(reads, 4)
    ok(true, '合并额度请求，区分手动与自动节流；超时和坏回执保留成功值但不延长旧数据寿命')
    for (const [failure, expected] of [
      [() => readAntigravityQuotaOutput('{"status":"FAILED","error":"UNAUTHENTICATED"}', ''), /先登录/],
      [() => { throw Object.assign(new Error('exit'), { code: 2, stderr: 'API key detected' }) }, /登录方式/],
      [() => [], /没有返回/]
    ]) {
      time += 60_000
      query = () => [group]
      assert.equal((await refresh()).groups.length, 1)
      time += 5000
      query = failure
      const invalid = await refresh(true)
      assert.deepEqual(invalid.groups, [])
      assert.match(invalid.error, expected)
      time += 2000
      query = () => { throw Object.assign(new Error('timeout'), { killed: true }) }
      assert.deepEqual((await refresh(true)).groups, [])
    }
    ok(true, '认证失效、API Key 无订阅和明确空额度立即清空，后续抖动不会恢复旧账号数据')
  }

  const { AntigravityQuotaDetails, AntigravityQuotaPaneSection, antigravityQuotaSummary, antigravityQuotaTone, I18nProvider } = await compile(null, {
    stdin: {
      contents: "export * from './src/renderer/src/features/workbench/AntigravityQuota'; export { I18nProvider } from './src/renderer/src/i18n';",
      resolveDir: resolve('.')
    },
    jsx: 'automatic', loader: { '.css': 'empty' }, packages: 'external'
  })
  const now = new Date(2026, 10, 22, 13, 30, 0)
  const today = new Date(2026, 10, 22, 17, 28, 0)
  const nextWeek = new Date(2026, 10, 28, 22, 38, 0)
  const weeklyTime = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nextWeek)
  const renderQuota = (windows, extra = {}) => renderToStaticMarkup(createElement(AntigravityQuotaDetails, {
    lang: 'en-US', now: now.getTime(), quota: { snapshot: { groups: [{ name: inactive.name, models: [], windows }] }, loading: false, refresh() {} }, ...extra
  }))
  const [fiveHour, weekly] = mixed.windows
  const noResets = renderQuota([0, -1, Infinity, NaN, Date.UTC(2019, 0, 1), Number.MAX_VALUE, undefined].map((resetAt, index) => ({ ...fiveHour, id: `bad-${index}`, resetAt })))
  ok(!/\bResets?\b/.test(noResets) && noResets.includes('Claude and GPT models'), '渲染端独立拦截占位和无效时间，全组无有效时间不显示重置')
  const fullRolling = renderQuota([{ ...weekly, id: 'argon-full', remainingFraction: 1, resetAt: nextWeek.getTime() }])
  ok(!/\bResets?\b/.test(fullRolling) && fullRolling.includes('100%') && fullRolling.includes('width:100%') && fullRolling.includes('data-full="1"'), '渲染端同样拦截 100% 满额滚动窗口的假重置时间，进度条按剩余比例展示')
  const both = renderQuota([{ ...weekly, remainingFraction: 0.83, resetAt: nextWeek.getTime() }, { ...fiveHour, remainingFraction: 0.74, resetAt: today.getTime() }])
  ok(both.includes('Resets 17:28 · in 3h 58m') && both.includes(`Resets ${weeklyTime} · in 6d 9h`) && both.includes('width:74%') && both.includes('width:83%'), '5h 与每周分别直接显示各自重置时间与倒计时，进度条与剩余百分比一致')
  const staleQuota = { checkedAt: now.getTime(), staleSince: now.getTime() - 5000, groups: [group], error: 'Fixture timeout.' }
  const staleMarkup = renderToStaticMarkup(createElement(AntigravityQuotaDetails, {
    lang: 'en-US', now: now.getTime(), model: { id: 'Gemini 4 Neon', name: 'Gemini 4 Neon' }, quota: { snapshot: staleQuota, loading: false, refresh() {} }
  }))
  ok(staleMarkup.includes('Fixture timeout.') && staleMarkup.includes('Showing the last successful allowance') && staleMarkup.includes('92.5%') &&
    staleMarkup.includes('Current') && antigravityQuotaSummary(staleQuota, { id: 'Gemini 4 Neon' }, 'en-US').includes('Stale') &&
    antigravityQuotaTone(staleQuota, { id: 'Gemini 4 Neon' }) === undefined &&
    antigravityQuotaTone({ checkedAt: now.getTime(), groups: [group] }, { id: 'Gemini 4 Neon' }) === 'fail', '折叠摘要、当前分组标记与旧数据提示正常，非旧数据耗尽返回 fail 语气')
  const paneMarkup = renderToStaticMarkup(createElement(I18nProvider, null, createElement(AntigravityQuotaPaneSection, {
    snapshot: { checkedAt: now.getTime(), groups: [
      { name: 'Gemini Models', models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'], windows: [
        { ...fiveHour, remainingFraction: 0.74, resetAt: today.getTime() },
        { ...weekly, remainingFraction: 0.83, resetAt: nextWeek.getTime() }
      ] },
      { ...argon, windows: [{ ...argon.windows[0], resetAt: nextWeek.getTime() }] }
    ] },
    loading: false, active: true, model: { id: 'gemini-4-neon', name: 'Gemini 4 Neon' }, now: now.getTime()
  })))
  ok(paneMarkup.match(/data-testid="v3-wb-quota-card-antigravity"/g)?.length === 1 &&
    paneMarkup.match(/data-testid="v3-wb-quota-antigravity-subgroup"/g)?.length === 2 &&
    paneMarkup.match(/aria-expanded="false"/g)?.length === 2 &&
    paneMarkup.includes('Gemini 4 Neon · Gemini 3.8 Flash') && paneMarkup.includes('For paid Pro plans, Argon quota is separate.'),
    '右栏额度详情只渲染一张卡，模型清单和说明默认折叠')
  ok(paneMarkup.includes('aria-valuenow="26"') && paneMarkup.includes('aria-valuenow="17"') &&
    paneMarkup.includes('17:28') && paneMarkup.includes('3时58分') && paneMarkup.includes('6天9时') &&
    paneMarkup.includes('已用') && paneMarkup.includes('使用中'), '额度卡用已用比例画仪表，保留各窗口时间和当前组标签')
  const argonCardMarkup = paneMarkup.slice(paneMarkup.indexOf('Gemini 4 Argon'))
  ok(argonCardMarkup.includes('aria-valuenow="0"') && !argonCardMarkup.includes('ui-meter__trailing') &&
    !argonCardMarkup.includes('5 小时'), 'Argon 满额显示 0% 已用，仅有本周窗口且不显示占位倒计时')

  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const modelsFixture = (id) => ({ current: id, available: id ? [{ id, name: id }] : [] })
  {
    const { createAntigravityDiscoveryProbes } = await compile('src/main/ipc/antigravity-ipc.ts')
    const resolving = deferred()
    const launches = []
    const probes = createAntigravityDiscoveryProbes(async (cwd) => cwd === 'resolving' ? resolving.promise : cwd, () => {
      const task = deferred()
      const proc = { ...task, closed: false }
      launches.push(proc)
      return {
        start: (_cwd, _server, opts) => { assert.equal(opts.discoverOnly, true); return task.promise },
        close: async () => { proc.closed = true; task.reject(new Error('fixture closed')) }
      }
    })
    const same = ['A', './A'].map((cwd) => probes.discover(cwd))
    const others = ['B', 'C', 'D'].map((cwd) => probes.discover(cwd).catch((err) => err))
    await assert.rejects(probes.discover('E'), /稍后重试/)
    assert.equal(launches.length, 4)
    launches[0].resolve(modelsFixture('A'))
    assert.deepEqual(await Promise.all(same), [modelsFixture('A'), modelsFixture('A')])
    assert.equal(launches[0].closed, true)
    const retry = probes.discover('A').catch((err) => err)
    const delayed = probes.discover('resolving')
    await Promise.resolve()
    await probes.dispose()
    resolving.resolve('late')
    await assert.rejects(delayed, /已关闭/)
    assert.equal(launches.length, 5)
    assert.ok((await Promise.all([...others, retry])).every((value) => value instanceof Error))
    assert.ok(launches.every((item) => item.closed))
    ok(true, '发现探针同目录合并、并发限额、完成即清退，以及退出期间不启动待解析的目录')
  }
  {
    const { createAntigravityDiscovery } = await compile('src/renderer/src/state/antigravity-discovery.ts', { packages: 'external' })
    let time = 0
    const requests = []
    const store = createAntigravityDiscovery((cwd) => {
      const task = deferred()
      requests.push({ cwd, ...task })
      return task.promise
    }, () => time)
    const old = store.discover('old')
    assert.equal(store.discover('old', true), old)
    const other = store.discover('next')
    await Promise.resolve()
    requests[1].resolve(modelsFixture('next'))
    await other
    requests[0].reject(new Error("Error invoking remote method 'yan:antigravity:discover': Error: fixture denied"))
    await old
    assert.equal(store.snapshot('next').models[0].id, 'next')
    assert.equal(store.snapshot('old').error, 'fixture denied')
    const retried = store.discover('old')
    await Promise.resolve()
    assert.equal(store.snapshot('old').error, undefined)
    requests[2].resolve(modelsFixture(null))
    await retried
    assert.equal(store.discover('old'), undefined)
    time += 60_000
    const expired = store.discover('old')
    const fill = Array.from({ length: 32 }, (_, i) => store.discover(`fill-${i}`))
    assert.equal(store.snapshot('old'), undefined)
    const latest = store.discover('old')
    await Promise.resolve()
    requests.at(-1).resolve(modelsFixture('latest'))
    await latest
    requests[3].resolve(modelsFixture('expired'))
    for (const request of requests.slice(4, -1)) request.resolve(modelsFixture(null))
    await Promise.all([expired, ...fill])
    assert.equal(store.snapshot('old').models[0].id, 'latest')
    ok(true, '发现缓存按目录隔离，失败可重试，空结果按 TTL 缓存，淘汰请求的迟到响应不能覆盖新结果')
  }
  {
    const { inheritAntigravitySelection } = await compile('src/renderer/src/features/composer/worktree-intent.ts', {
      alias: { '@/state/store': './src/renderer/src/state/store' }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }, packages: 'external'
    })
    const selection = { modelId: 'pro', mode: 'plan', effort: 'xhigh' }
    const calls = []
    let current = true
    let state = { model: { provider: 'pi', id: 'pro' } }
    let resetMode = true
    const ports = {
      current: () => current,
      snapshot: () => state,
      select: async (id) => {
        calls.push('model')
        state = { model: { provider: 'antigravity', id }, antigravity: { mode: 'default', thinking: { current: 'high' } } }
        return { ok: true }
      },
      setMode: async (mode) => { calls.push('mode'); state.antigravity.mode = mode; return { ok: true } },
      setThinking: async (effort) => {
        calls.push('effort')
        state.antigravity.thinking.current = effort
        if (resetMode) state.antigravity.mode = 'default'
        return { ok: true }
      }
    }
    assert.equal((await inheritAntigravitySelection(selection, ports)).ok, false)
    assert.deepEqual(calls, ['model', 'mode', 'effort'])
    resetMode = false
    assert.equal((await inheritAntigravitySelection(selection, ports)).ok, true)
    assert.deepEqual(calls, ['model', 'mode', 'effort', 'mode'])
    state.antigravity.mode = 'default'
    assert.deepEqual(await inheritAntigravitySelection(selection, { ...ports, setMode: async () => ({ ok: false, error: 'fixture unavailable' }) }), { ok: false, error: 'fixture unavailable' })
    state = null
    assert.equal((await inheritAntigravitySelection(selection, { ...ports, select: async () => { current = false; return { ok: true } } })).ok, false)
    assert.deepEqual(calls, ['model', 'mode', 'effort', 'mode'])
    ok(true, '工作树先切模型再应用权限与思考档；任一失败、回执相互覆盖或切走时禁止继续')
  }

  const cwd = process.cwd()
  const start = (...args) => {
    const child = spawn(process.execPath, [resolve('debug/lib/fake-antigravity.mjs'), ...args], { windowsHide: true })
    const session = new AntigravitySession(child, async () => { child.kill() })
    const events = []
    session.onEvent = (event) => events.push(event)
    return { session, events }
  }
  const wait = async (fn) => {
    for (let i = 0; i < 200; i++) {
      const value = fn()
      if (value) return value
      await delay(15)
    }
    assert.fail('等待 ACP 事件超时')
  }

  {
    const location = mkdtempSync(join(tmpdir(), 'yan-acp-executable-'))
    const keys = ['LOCALAPPDATA', 'PATH', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'PYTHONUNBUFFERED', 'YAN_FIXTURE_PRIVATE_ENV']
    const saved = new Map(keys.map((key) => [key, process.env[key]]))
    try {
      const executable = join(location, 'agy.exe')
      writeFileSync(executable, '')
      Object.assign(process.env, { LOCALAPPDATA: location, PATH: [location, process.env.PATH].join(delimiter),
        AGY_CLI_DISABLE_AUTO_UPDATE: '0', PYTHONUNBUFFERED: '0', YAN_FIXTURE_PRIVATE_ENV: 'fixture' })
      const resolved = antigravityExecutable(cwd)
      ok(resolved.executable === executable && resolved.env.AGY_CLI_DISABLE_AUTO_UPDATE === '1' &&
        resolved.env.PYTHONUNBUFFERED === '1' && !Object.hasOwn(resolved.env, 'YAN_FIXTURE_PRIVATE_ENV'), '启动环境仍按白名单筛选，固定禁用 CLI 自更新、启用 Python 非缓冲输出')
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(location, { recursive: true, force: true })
    }
  }

  for (const args of [['embedded-context'], ['legacy']]) {
    const fixture = start('gateway-models', ...args)
    try {
      const models = await fixture.session.start(cwd)
      assert.equal(models.supportsEmbeddedContext, args.includes('embedded-context'))
      assert.deepEqual(models.available.filter(({ id }) => id.startsWith('gateway')), [
        { id: 'gateway-a', name: 'Gateway (gateway-a)' },
        { id: 'gateway-b', name: 'Gateway (gateway-b)' },
        { id: 'gateway-c', name: 'Gateway (gateway-c)' }
      ])
      const selected = await fixture.session.selectModel('gateway-b')
      assert.equal(selected.current, 'gateway-b')
      await assert.rejects(fixture.session.selectModel('Gateway (gateway-b)'))
      const refPrompt = '检查文件引用\n\n文件引用：\n- src/example file.txt'
      await fixture.session.prompt(refPrompt, 'gateway-b')
      const payload = JSON.parse(fixture.events.filter((event) => event.type === 'text').map((event) => event.text).join(''))
      assert.deepEqual(payload, { model: 'gateway-b', blocks: [{ type: 'text', text: refPrompt }] })
    } finally {
      await fixture.session.close()
    }
  }
  ok(true, '现代和旧 ACP 模型列表按原始 ID 去重并区分同名项；不论是否声明 embeddedContext，输入框文件路径引用原样走文本块')

  {
    const http = { type: 'http', name: 'inkstone-pi', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'fixture' }] }
    const stdio = { name: 'inkstone-pi', command: process.execPath, args: [], env: [] }
    const configs = { stdio: [stdio], http: [http] }
    let resumeSessionId
    for (const [args, resume, servers, transport, steer] of [
      [['--protocol=2', '--version=v1.5.0', 'http-mcp'], false, configs, 'http', true],
      [['--version=1.10.0', 'http-mcp'], true, configs, 'http', true],
      [['load-only', 'http-mcp', '--version=2.0.0'], true, configs, 'http', true],
      [['--version=1.4.99'], false, configs, 'stdio', false],
      [['http-mcp'], false, { ...configs, http: [] }, 'stdio', false],
      [[], false, stdio, 'stdio', false]
    ]) {
      const { session, events } = start(...args)
      try {
        const models = await session.start(cwd, servers, resume ? { resumeSessionId } : undefined)
        resumeSessionId ??= session.acpSessionId
        assert.equal(session.resumed, resume)
        assert.equal(session.canSteerWithPrompt, steer)
        assert.equal(models.current, 'flash')
        if (args.includes('--protocol=2')) {
          assert.equal((await session.selectModel('pro')).current, 'pro')
          assert.equal((await session.selectModel('flash')).current, 'flash')
        }
        await session.prompt('检查 MCP 传输')
        assert.equal(events.find((event) => event.type === 'text').text, transport)
      } finally { await session.close() }
    }
    const incompatible = start('--protocol=3').session
    try { await assert.rejects(incompatible.start(cwd), /协议版本不兼容/) } finally { await incompatible.close() }
    ok(true, 'ACP v1/v2 配置切换、拒绝其他协议版本；HTTP 按能力优先用于 new/resume/load，其余保留 stdio，按数值版本启用原生插话')
  }

  {
    const { session, events } = start('--version=v1.5.0', 'native-steer')
    try {
      await session.start(cwd, undefined, { mode: 'auto' })
      const ordinary = session.prompt('空交互提问', 'flash', 'low', 'auto')
      assert.equal(await ordinary, 'end_turn')
      assert.ok(events.some((e) => e.text === '提问结果 · cancelled · cancel=0'))
      assert.ok(events.every((e) => e.type !== 'permission' && e.type !== 'question'))
      events.length = 0
      const old = session.prompt('原生插话阻塞', 'flash', 'low', 'auto')
      await wait(() => events.some((e) => e.text === '旧轮首块'))
      assert.throws(() => session.steerPrompt('权限档不可绕过', 'flash', 'low', 'plan'), /权限档/)
      const steered = session.steerPrompt('原生插话提问', 'flash', 'low', 'auto')
      assert.ok(steered)
      assert.equal(await old, 'end_turn')
      assert.equal(session.steerPrompt('在途不可重入', 'flash', 'low', 'auto'), undefined)
      await wait(() => session.context?.used === 567)
      assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['旧轮首块', '旧轮收尾'])
      assert.equal(events.findLast((e) => e.type === 'usage').usage.input, 10)
      assert.ok(!events.some((e) => e.type === 'question' || e.type === 'tool'))
      const next = []
      const running = steered.attach((e) => next.push(e))
      await wait(() => next.some((e) => e.type === 'question'))
      assert.deepEqual(next.map(({ type }) => type), ['text', 'tool', 'context', 'question'])
      const question = next.at(-1)
      assert.equal(question.title, '选择夹具\\u{202e}选项')
      assert.deepEqual(question.options.map(({ id }) => id), ['one', 'two', 'three', 'four', 'five'])
      assert.equal(question.options[4].name, 'five')
      assert.ok(question.options[3].name.startsWith('文字\\u{202e}') && !question.options[3].name.includes('\u202e') && question.options[3].name.length < 550)
      session.reply(question.id, 'duplicate')
      session.reply(question.id, 'two')
      assert.equal(await running, 'end_turn')
      assert.ok(next.some((e) => e.type === 'permission-cleared' && e.id === question.id))
      assert.equal(next.findLast((e) => e.type === 'text').text, '提问结果 · two · cancel=0')
      ok(true, 'Auto 不干预交互题，保留合法非审批选项；插话不取消，旧轮及新轮更新和提问按序独立分发')

      await session.selectMode('default')
      next.length = 0
      const waiting = session.prompt('原生插话阻塞')
      await wait(() => next.some((e) => e.text === '旧轮首块'))
      const approvalPrompt = session.steerPrompt('原生插话审批')
      assert.equal(await waiting, 'end_turn')
      await delay(25)
      const after = []
      const approvalRunning = approvalPrompt.attach((e) => after.push(e))
      const approval = await wait(() => after.find((e) => e.type === 'permission'))
      assert.deepEqual(approval.options.map(({ id }) => id), ['once', 'deny'])
      session.reply(approval.id, 'deny')
      assert.equal(await approvalRunning, 'end_turn')
      ok(after.some((e) => e.text === '审批结果 · deny') && !next.some((e) => e.type === 'permission'), '插话缓冲普通审批且不会把它投递给旧轮或放宽权限')

      after.length = 0
      const initial = session.prompt('原生插话阻塞')
      await wait(() => after.some((e) => e.text === '旧轮首块'))
      const middle = session.steerPrompt('原生插话阻塞')
      assert.equal(await initial, 'end_turn')
      const middleEvents = []
      const middleResult = middle.attach((e) => middleEvents.push(e))
      await wait(() => middleEvents.some((e) => e.text === '旧轮首块'))
      const final = session.steerPrompt('原生插话结束')
      assert.equal(await middleResult, 'end_turn')
      await delay(20)
      assert.equal(session.busy, true)
      const finalEvents = []
      assert.equal(await final.attach((e) => finalEvents.push(e)), 'end_turn')
      assert.deepEqual(middleEvents.filter((e) => e.type === 'text').map((e) => e.text), ['旧轮首块', '旧轮收尾'])
      assert.deepEqual(finalEvents, [{ type: 'text', text: '插话快速结束' }, { type: 'usage', usage: { input: 20 } }])
      ok(!session.busy, '已接管的插话可继续接下一次；新轮回执早于接管也不会丢更新或提前释放 busy')
    } finally { await session.close() }
  }

  {
    const { session, events } = start('--version=1.5.0', 'native-steer')
    try {
      await session.start(cwd)
      const old = session.prompt('原生插话阻塞')
      await wait(() => events.some((e) => e.text === '旧轮首块'))
      const steer = session.steerPrompt('原生插话提问')
      assert.equal(await old, 'end_turn')
      await wait(() => session.context?.used === 567)
      await delay(30)
      session.cancel()
      const replay = []
      assert.equal(await steer.attach((e) => replay.push(e)), 'cancelled')
      assert.ok(replay.some((e) => e.type === 'question') && replay.some((e) => e.type === 'permission-cleared'))
      assert.equal(session.busy, false)
      const nextOld = session.prompt('原生插话阻塞')
      await wait(() => replay.some((e) => e.text === '旧轮首块'))
      const nextSteer = session.steerPrompt('原生插话提问')
      assert.equal(await nextOld, 'end_turn')
      await session.close()
      const dropped = []
      await assert.rejects(nextSteer.attach((e) => dropped.push(e)), /会话已关闭/)
      ok(dropped.length === 0 && !session.busy, '用户停止可取消未接管插话并清理提问，关闭清理缓冲及待处理 RPC')
    } finally { await session.close() }
  }

  {
    const { session, events } = start()
    try {
      await session.start(cwd)
      const usages = []
      for (const query of ['缓存与思考', '思考超出输出', '显式可见输出']) {
        await session.prompt(query)
        usages.push(events.findLast((e) => e.type === 'usage').usage)
      }
      assert.deepEqual(usages, [
        { input: 80, output: 20, cacheRead: 20, thought: 9, totalTokens: 120, visibleOutput: 11 },
        { input: 80, output: 20, thought: 21 },
        { output: 20, thought: 9, visibleOutput: 4 }
      ])
      ok(true, '回合输入不重复计缓存，兼容 thought 别名，安全推导可见输出并优先用显式值')
      for (const query of ['失效思考签名', '错误思考签名']) {
        await assert.rejects(session.prompt(query), (error) => error.name === 'INVALID_THINKING_SIGNATURE' && /思考签名已失效/.test(error.message))
      }
      const loaded = session.prompt('大工具载荷')
      const approval = await wait(() => events.find((e) => e.type === 'permission'))
      try {
        const tools = events.filter((e) => e.type === 'tool' && e.id === 'big')
        const [initial, completed] = tools
        assert.equal(initial.output, 'combined output')
        assert.deepEqual(completed.args.imageObject, { type: 'image', mimeType: 'image/png' })
        assert.equal(completed.args.imageUrl, '')
        assert.equal(completed.args.log, 'before  after')
        assert.equal(completed.args.text, 'z'.repeat(31_995) + ' END')
        assert.equal(completed.output, completed.args.text)
        assert.deepEqual(completed.args.nested, { combined_output: 'nested' })
        assert.equal(Object.hasOwn(completed.args, 'formattedOutput'), false)
        assert.deepEqual(completed.diffs, [{ path: 'big.txt', oldText: 'OLD' + 'a'.repeat(40_000), newText: 'NEW' + 'z'.repeat(40_000) }])
        assert.deepEqual(approval.options.map(({ id }) => id), ['deny'])
        assert.ok(approval.blocked)
      } finally { session.reply(approval.id, 'deny') }
      assert.equal(await loaded, 'end_turn')
      ok(true, '超过旧行上限的大载荷仍能解析；移除图像和重复输出，只存无损尾部及完整 diff，审批继续基于原始载荷拒超限')
      await assert.rejects(session.prompt('超大 ACP 行'), /返回的数据过大/)
      ok(true, 'ACP 输入行保留 16 MiB 字节上限，多字节字符不能绕过')
    } finally { await session.close() }
  }

  const { session, events } = start()
  try {
    const models = await session.start(cwd)
    ok(models.current === 'flash' && models.available.map((m) => m.id).join() === 'flash,pro,third-party', '解析分组模型列表')
    ok(models.mode === 'default' && models.thinking.options.map((m) => m.id).join() === 'low,high', '确认默认审批并解析 CLI 思考档')
    await wait(() => session.context?.used === 120)
    ok(true, '建会话回执后一行的初始上下文已接收')
    await assert.rejects(session.selectModel('unlisted'))
    const pro = await session.selectModel('pro')
    ok(pro.current === 'pro' && pro.thinking.options.at(-1).name === 'Extra', '切换模型后读取相关档位和显示名')
    await assert.rejects(session.selectThinking('ultracode'))
    const high = await session.selectThinking('xhigh')
    ok(high.thinking.current === 'xhigh', '使用模型对应的 config ID 并读取确认回执')
    await wait(() => session.context?.used === 360)
    ok(true, '空闲时更改思考档也接收上下文')
    await assert.rejects(session.selectMode('bypass'))
    ok((await session.selectMode('plan')).modes.current === 'plan', '用真实的 CLI 配置 ID 切到计划权限档')
    await assert.rejects(session.prompt('检查权限档'), /权限档/)
    await session.prompt('检查权限档', 'pro', 'xhigh', 'plan')
    ok(events.some((event) => event.text === '当前权限档 · plan'), '仅按会话明确选定的权限档发送')
    await session.selectMode('default')
    await session.prompt('检查档位')
    ok(events.some((e) => e.text === '当前档位 · pro/xhigh'), '后续真实走 ACP 配置后的夹具档位')
    await session.prompt('统计数据')
    ok(events.some((e) => e.type === 'thought' && e.text === '夹具思考') &&
      events.some((e) => e.type === 'context' && e.used === 5000 && e.size === 20000) &&
      events.some((e) => e.type === 'usage' && e.usage.output === 30 && e.usage.cacheWrite === undefined && e.usage.cost === undefined),
    '区分思考、上下文、终态用量和缺失字段；累计费用不归给回合')
    events.length = 0
    await session.prompt('多步进度')
    const plans = events.filter((e) => e.type === 'plan')
    ok(plans.length === 3 && plans[0].entries[0].status === 'running' && plans.at(-1).entries.every((e) => e.status === 'done'), '解析 ACP plan 进度更新事件')
    events.length = 0
    await session.prompt('你好')
    ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === '模拟回复 · pro', '增量文本按序输出，忽略其他会话的事件')
    events.length = 0
    await session.prompt('后台自唤醒')
    await wait(() => events.some((e) => e.type === 'text' && e.text.includes('内部后台任务已完成')))
    ok(
      events.some((e) => e.type === 'thought' && e.text === '检查内部后台任务结果') &&
      events.some((e) => e.type === 'tool' && e.id === 'bg-check-1' && e.status === 'completed') &&
      events.some((e) => e.type === 'text' && e.text === '内部后台任务已完成，结果 45/45 通过。'),
      'end_turn 后 CLI 内部后台任务主动推送的思考、工具与正文不被静默丢弃'
    )
    session.cancel()
    await delay(50)
    ok(!events.some((e) => e.type === 'closed'), '非 prompt 期间取消内部后台续跑不误断整个 ACP 连接')
    events.length = 0
    await session.prompt('后台工具无回执')
    await wait(() => events.some((e) => e.type === 'tool' && e.id === 'stalled-tool' && e.status === 'in_progress'))
    const timeout = deferred()
    const outdated = scheduleAntigravityToolIdleTimeout(() => assert.fail('已被下一次更新清除'), 10)
    clearTimeout(outdated)
    const timer = scheduleAntigravityToolIdleTimeout(timeout.resolve, 20)
    assert.equal(timer.hasRef(), false)
    assert.match((await timeout.promise).message, /后台工具长时间没有更新/)
    assert.ok(!events.some((e) => e.id === 'stalled-tool' && e.status === 'completed'))
    ok(true, '后台工具缺终态时提供可重置且不阻塞进程退出的故障超时')
    events.length = 0
    await session.prompt('看这张图', 'pro', 'xhigh', 'default', [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
    ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === '收到 1 张图 · image/png · 看这张图', '支持发送 ACP 图片内容块')
    events.length = 0
    await session.prompt('', 'pro', 'xhigh', 'default', [{ data: ' DATA:IMAGE/JPEG;base64,/9j/\r\n2Q ', mimeType: ' image/JPG ' }])
    ok(events.some((e) => e.text === '收到 1 张图 · image/jpeg'), '纯图消息：去除 data URL、空白，规范 MIME 和 Base64 padding 后发往 CLI')
    assert.throws(() => normalizeAntigravityImages([{ data: 'a%%', mimeType: 'image/png' }]), /第 1 张/)
    assert.throws(() => normalizeAntigravityImages([{ data: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/jpeg' }]), /第 1 张/)
    assert.throws(() => normalizeAntigravityImages([{ data: 'iVBORw0KGgo=', mimeType: 'image/jpeg' }]), /第 1 张/)
    assert.throws(() => normalizeAntigravityImages([{ data: 'A'.repeat(32 * 1024 * 1024 + 1), mimeType: 'image/png' }]), /传输上限/)
    await assert.rejects(session.prompt('不能静默丢弃坏图', 'pro', 'xhigh', 'default', [{ data: '', mimeType: 'image/png' }]), /第 1 张/)
    ok(true, '发布前拒绝错误编码、超限和 MIME/文件头不一致，不静默丢弃坏图')
    await assert.rejects(session.prompt('参数诊断'), (error) => error.rpcCode === -32602 && /session\/prompt/.test(error.message) &&
      /prompt\.1\.data/.test(error.message) && /raw Base64/.test(error.message) && /Missing image bytes/.test(error.message) &&
      !/fixture-secret|原始正文/.test(error.message))
    ok(true, 'RPC 参数错误保留方法、错误码、字段和有限说明，不回显凭据与请求原文')
    events.length = 0
    const pending = session.prompt('权限')
    await assert.rejects(session.prompt('重入'))
    const ask = await wait(() => events.find((e) => e.type === 'permission'))
    ok(ask.title === '查看夹具项目' && ask.detail.includes('README.md') && ask.options.map((e) => e.id).join() === 'once,deny', '显示工具详情，并移除永久授权选项')
    session.reply(ask.id, 'always')
    session.reply(ask.id, 'once')
    ok(await pending === 'end_turn' && events.some((e) => e.text === '审批结果 · once'), '拒绝伪造永久授权、只回传单次批准，并拒绝越权文件 IPC')
    const missing = session.prompt('详情缺失')
    const denyOnly = await wait(() => events.find((e) => e.type === 'permission' && e.id !== ask.id))
    ok(denyOnly.options.every((e) => !e.allow), '缺少操作详情时只允许拒绝')
    session.cancel()
    ok(await missing === 'cancelled' && events.some((e) => e.type === 'permission-cleared' && e.id === denyOnly.id), '停止回复并清除待审批')
    for (const mode of ['default', 'accept-edits', 'plan']) {
      await session.selectMode(mode)
      events.length = 0
      const full = session.prompt('完整审批详情', 'pro', 'xhigh', mode)
      const approval = await wait(() => events.find((e) => e.type === 'permission'))
      assert.deepEqual(approval.options.map((o) => o.id), ['once', 'deny'])
      for (const field of ['CommandLine', 'echo fixture', 'BypassSandbox', 'true', 'fixture.txt', 'first', 'second\\u{202e}third', '审批说明', 'execute']) assert.ok(approval.detail.includes(field))
      assert.ok(!approval.detail.includes('\u202e') && approval.title.includes('\\u{202e}'))
      session.reply(approval.id, 'deny')
      assert.equal(await full, 'end_turn')
    }
    ok(true, 'default、accept-edits 与 plan 都保留完整审批命令、路径、参数及 BypassSandbox，并显式显示不可见字符')
    for (const request of ['详情超限', '空参数审批', '重复审批选项']) {
      events.length = 0
      const requested = session.prompt(request, 'pro', 'xhigh', 'plan')
      const approval = await wait(() => events.find((e) => e.type === 'permission'))
      assert.deepEqual(approval.options.map((o) => o.id), ['deny'])
      if (request === '详情超限') assert.ok(approval.blocked && approval.detail.includes('无法完整显示') && !approval.detail.includes('xxxx'))
      session.reply(approval.id, 'once')
      session.reply(approval.id, 'deny')
      assert.equal(await requested, 'end_turn')
      assert.ok(events.some((e) => e.text === '审批结果 · deny'))
    }
    ok(true, '超限、空参数或重复批准 ID 均不能获批，超限不再给出伪装成完整内容的截断片段')
    await session.selectMode('default')
    const crash = session.prompt('崩溃')
    await assert.rejects(crash, /断开连接/)
    ok(events.some((e) => e.type === 'closed'), '进程退出时结束待处理请求并通知界面')
  } finally { await session.close() }

  {
    const { AntigravitySubagentRpc } = await compile('src/main/antigravity-subagent-rpc.ts')
    const child = async (model, options, approve = async () => true, ...args) => {
      const rpc = new AntigravitySubagentRpc(cwd, model, approve, { ...options, launch: () => start(...args).session })
      const events = []
      rpc.on('event', (event) => events.push(event))
      rpc.spawn()
      return { rpc, events, ready: await rpc.command('get_state', undefined, { timeoutMs: 2500 }) }
    }
    const readOnly = await child('pro', { thinkingLevel: 'xhigh', readOnly: true }, () => assert.fail('plan 不应弹出批准'))
    try {
      assert.equal(readOnly.ready.data?.thinkingLevel, 'xhigh')
      assert.equal((await readOnly.rpc.command('prompt', { message: '子代理步骤' })).success, true)
      await wait(() => readOnly.events.some((e) => e.type === 'agent_settled'))
      const final = readOnly.events.findLast((e) => e.type === 'message_end').message
      ok(final.content.some((block) => block.type === 'thinking' && block.thinking === '夹具子代理思考') &&
        final.content.some((block) => block.text === '子代理 · pro/xhigh/plan'), 'ACP 子代理按目标模型确认思考档及 Plan 权限，并透传思考与正文')
      ok(readOnly.events.filter((e) => e.type.startsWith('tool_execution_')).map((e) => e.type).join() === 'tool_execution_start,tool_execution_update,tool_execution_end' &&
        final.yanAntigravityTools[0]?.output === 'fixture tool result' && final.yanAntigravityTools[0]?.endedAt, 'ACP 子代理透传工具增量、结果和结束时间，重复完成不计两次')
      readOnly.events.length = 0
      await readOnly.rpc.command('prompt', { message: '检查命令权限' })
      await wait(() => readOnly.events.some((e) => e.type === 'agent_settled'))
      ok(readOnly.events.findLast((e) => e.type === 'message_end').message.content.some((block) => block.text === '审批结果 · deny'), '只读子代理主动拒绝 CLI 工具批准请求')
      readOnly.events.length = 0
      await readOnly.rpc.command('prompt', { message: '交互提问' })
      await wait(() => readOnly.events.some((e) => e.type === 'agent_settled'))
      assert.ok(readOnly.events.findLast((e) => e.type === 'message_end').message.content.some((block) => block.text.startsWith('提问结果 · cancelled')))
      readOnly.events.length = 0
      await readOnly.rpc.command('prompt', { message: '额度拒绝' })
      await wait(() => readOnly.events.some((e) => e.type === 'agent_settled'))
      const refused = readOnly.events.findLast((e) => e.type === 'message_end').message
      ok(refused.stopReason === 'error' && /Antigravity 模型额度可能已耗尽/.test(refused.errorMessage), '子代理直接取消交互题，refusal 提示额度耗尽')
    } finally { await readOnly.rpc.close() }
    const noPlan = await child('pro', { readOnly: true }, undefined, 'no-plan')
    const invalid = await child('flash', { thinkingLevel: 'high-ish' })
    const unavailable = await child('flash', { thinkingLevel: 'xhigh' })
    try {
      ok(!noPlan.ready.success && !invalid.ready.success && !unavailable.ready.success &&
        !noPlan.rpc.running && !invalid.rpc.running && !unavailable.rpc.running, '无 Plan 档、非法思考档或所选模型不支持指定档位时启动失败且不降级')
    } finally { await Promise.all([noPlan.rpc.close(), invalid.rpc.close(), unavailable.rpc.close()]) }
    let approvalSignal
    const cancellable = await child('flash', {}, (_request, signal) => {
      approvalSignal = signal
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(true), { once: true }))
    })
    try {
      assert.equal(cancellable.ready.data?.thinkingLevel, 'low')
      await cancellable.rpc.command('prompt', { message: '权限' })
      await wait(() => approvalSignal)
      await cancellable.rpc.command('abort')
      await wait(() => cancellable.events.some((e) => e.type === 'agent_settled'))
      const cancelled = cancellable.events.findLast((e) => e.type === 'message_end').message
      ok(approvalSignal.aborted && cancelled.stopReason === 'aborted' && cancelled.yanAntigravityTools[0]?.cancelled === true, '取消 ACP 子代理时中止审批、收束工具和回合')
      cancellable.events.length = 0
      await cancellable.rpc.command('prompt', { message: '崩溃' })
      await wait(() => cancellable.events.some((e) => e.type === 'agent_settled'))
      ok(!cancellable.rpc.running && cancellable.events.findLast((e) => e.type === 'message_end').message.stopReason === 'error', 'ACP 断线时收束在途回合并退出')
    } finally { await cancellable.rpc.close() }
  }

  {
    const { AgentController } = await compile('src/main/agent.ts', agentTestBuildOptions)
    const { readAntigravityPreference } = await compile('src/main/antigravity-preferences.ts', agentTestBuildOptions)
    const makeAgent = async (mode, ...args) => {
      const { session, events } = start(...args)
      const models = await session.start(cwd, undefined, { mode })
      const pushed = []
      const saved = []
      const ctl = new AgentController({ cwd, push: (event) => pushed.push(event) })
      ctl.refreshState = async () => {}
      ctl.refreshStats = async () => {}
      ctl.maybeGenerateTitle = async () => {}
      ctl.confirmExecutionAdmission = () => true
      ctl.state = { sessionId: randomUUID(), cwd, isStreaming: false, autoCompactionEnabled: false }
      const connection = ctl.acpConnection = { sessionId: ctl.state.sessionId, model: { id: 'flash', name: 'Flash', provider: 'antigravity' },
        thinking: models.thinking, mode: models.mode, modes: models.modes, session, hasContext: false }
      let appendGate
      const native = ctl.nativeRuntime = {
        bridgeCapabilities: ['append_antigravity_turn', 'append_antigravity_compaction'],
        appendAntigravityTurn: async (turn) => {
          const first = saved.length === 0
          saved.push(turn)
          if (first) await appendGate
          return { userId: 'u-' + saved.length, assistantId: 'a-' + saved.length }
        },
        appendAntigravityCompaction: async ({ summary }) => { saved.push(summary); return { entryId: 'compact-fixture' } }
      }
      ctl.bindAntigravity(connection, session)
      const prompt = (userText, text = userText) => {
        ctl.startAntigravityTurn({ connection, session, native, owner: ctl.asyncOwner(), userText, prompt: text })
        return ctl.acpTurn
      }
      const requests = () => pushed.filter((event) => event.ch === 'ui-request').map(({ payload }) => payload)
      return { ctl, session, events, saved, pushed, prompt, requests, connection, holdAppend: (gate) => { appendGate = gate } }
    }

    const ag = await makeAgent('auto', '--version=1.5.0', 'native-steer')
    const gate = deferred()
    try {
      await ag.prompt('检查能力声明').done
      assert.equal(ag.saved[0].steps[0].text, 'elicitation=true')
      ag.saved.length = 0
      ag.holdAppend(gate.promise)
      const old = ag.prompt('原生插话阻塞')
      await wait(() => ag.pushed.some((e) => e.payload?.patch?.textDelta === '旧轮首块'))
      assert.equal((await ag.ctl.steer('原生插话提问')).ok, true)
      assert.equal((await ag.ctl.steer('插话之后继续排队')).ok, true)
      assert.equal(ag.ctl.acpQueue.steering.length, 1)
      await wait(() => ag.saved.length && ag.session.context?.used === 567)
      assert.equal(ag.requests().length, 0)
      assert.equal(old.delegation.signal.aborted, false)
      assert.equal(ag.saved[0].steps[0].text, '旧轮首块旧轮收尾')
      assert.equal(ag.saved[0].status, 'stop')
      assert.equal(ag.connection.hasContext, true)
      assert.equal(ag.ctl.acpQueue.steering[0].text, '插话之后继续排队')
      gate.resolve()
      await old.done
      const next = ag.ctl.acpTurn
      assert.equal(next.delegation, old.delegation)
      const ask = await wait(() => ag.requests().at(-1))
      assert.equal(ask.purpose, undefined)
      assert.equal(ask.sensitive, undefined)
      assert.equal(ask.message, '选择夹具\\u{202e}选项')
      assert.deepEqual(ask.options.slice(0, 3), ['同名', '同名 (3)', '同名 (2)'])
      assert.deepEqual(await ag.ctl.answerUiRemotely(ask.id, { value: ask.options[1] }), { ok: true })
      await next.done
      await wait(() => ag.saved.length === 3 && !ag.ctl.acpTurn)
      assert.deepEqual(ag.saved.map(({ user }) => user), ['原生插话阻塞', '原生插话提问', '插话之后继续排队'])
      assert.deepEqual(ag.saved[1].steps.map(({ text }) => text), ['插话首块', '提问结果 · two · cancel=0'])
      assert.equal(ag.saved[1].antigravity.context.used, 567)
      assert.equal(readAntigravityPreference(ag.connection.sessionId).acpSessionId, ag.session.acpSessionId)
      ok(true, 'AgentController 在旧轮落盘等待期间缓冲新轮，原地接管不终止委派；远程选择重复展示名准确回填，后续插话继续排队')
    } finally { gate.resolve(); await ag.ctl.closeAntigravity() }

    const edit = await makeAgent('auto', '--version=1.5.0', 'native-steer')
    const stopGate = deferred()
    try {
      edit.holdAppend(stopGate.promise)
      const old = edit.prompt('原生插话阻塞')
      await wait(() => edit.pushed.some((e) => e.payload?.patch?.textDelta === '旧轮首块'))
      await edit.ctl.followUp('原生插话提问')
      const target = edit.ctl.acpQueue.followUp[0]
      assert.equal((await edit.ctl.steerQueued(target.id)).ok, true)
      await wait(() => edit.session.context?.used === 567 && edit.saved.length === 1)
      const stop = edit.ctl.abort()
      stopGate.resolve()
      await stop
      assert.equal(edit.ctl.acpTurn, undefined)
      assert.equal(edit.requests().length, 0)
      assert.equal(edit.saved.length, 2)
      assert.equal(edit.saved[1].user, target.text)
      assert.equal(edit.saved[1].status, 'aborted')
      assert.equal(old.delegation.signal.aborted, true)
      ok(true, '从队列提升消息使用原生插话；旧轮持久化期间停止会取消已发新轮并清理其提问')
    } finally { stopGate.resolve(); await edit.ctl.closeAntigravity() }

    const legacy = await makeAgent('default', '--version=1.4.9')
    try {
      const old = legacy.prompt('等待')
      await wait(() => legacy.pushed.some((e) => e.payload?.patch?.textDelta === '正在等待'))
      assert.equal((await legacy.ctl.steer('旧版回退消息')).ok, true)
      await old.done
      await wait(() => legacy.saved.length === 2 && !legacy.ctl.acpTurn)
      assert.equal(legacy.saved[0].status, 'aborted')
      assert.equal(legacy.saved[1].user, '旧版回退消息')
      ok(true, '旧版 CLI 继续取消旧回合后再发送排队消息')
    } finally { await legacy.ctl.closeAntigravity() }

    const healing = await makeAgent('default', '--version=1.5.0', 'native-steer', 'late-steer-error')
    let rebuilt
    try {
      await healing.prompt('你好').done
      assert.equal(readAntigravityPreference(healing.connection.sessionId).acpSessionId, healing.session.acpSessionId)
      const old = healing.prompt('原生插话阻塞')
      await wait(() => healing.pushed.some((e) => e.payload?.patch?.textDelta === '旧轮首块'))
      await healing.ctl.steer('原生插话结束')
      await old.done
      await wait(() => healing.saved.length === 3 && !healing.ctl.acpTurn)
      assert.match(healing.saved[2].error, /思考签名已失效/)
      assert.equal(healing.connection.session, undefined)
      assert.equal(readAntigravityPreference(healing.connection.sessionId).acpSessionId, undefined)
      assert.equal(await healing.ctl.resolveAntigravityResume(healing.connection), undefined)
      healing.ctl.selectAntigravity = async () => {
        rebuilt = start().session
        await rebuilt.start(cwd)
        healing.connection.session = rebuilt
        healing.ctl.bindAntigravity(healing.connection, rebuilt)
        return { ok: true }
      }
      assert.equal((await healing.ctl.sendAntigravity('额度拒绝')).ok, true)
      await healing.ctl.acpTurn?.done
      assert.notEqual(rebuilt.acpSessionId, healing.session.acpSessionId)
      assert.match(healing.saved[3].error, /Antigravity 模型额度可能已耗尽/)
      ok(true, '已在接管前失败的插话仍正确落盘；失效签名清除持久化 ACP ID，下一次发送进入重连且 refusal 明示额度')
    } finally { await healing.ctl.closeAntigravity(); await rebuilt?.close() }

    const idle = await makeAgent('auto')
    const previousIdle = process.env.YAN_ACP_UNSOLICITED_IDLE_MS
    process.env.YAN_ACP_UNSOLICITED_IDLE_MS = '60'
    try {
      await idle.prompt('后台交互提问').done
      const ask = await wait(() => idle.requests().at(-1))
      idle.ctl.ui.expireHostUi(ask.id)
      await wait(() => idle.saved.length === 2 && !idle.ctl.acpTurn)
      assert.match(idle.saved[1].steps[0].text, /提问结果 · cancelled/)
      await idle.prompt('后台常驻工具').done
      await wait(() => idle.saved.length === 4 && !idle.ctl.acpTurn)
      assert.equal(idle.saved[3].status, 'stop')
      assert.equal(idle.saved[3].steps.map(({ text }) => text).join(''), '常驻工具已启动')
      ok(true, '后台交互题唤醒会话，超时回取消；IsDaemon 常驻执行工具不阻塞后台回合正常收尾')
      await idle.prompt('思考超出输出').done
      ok(idle.saved[4].antigravity.usage.thought === 21 && idle.saved[4].antigravity.usage.visibleOutput === undefined,
        '主会话未观察到思考文本时也不会把已知含思考的无效输出用量当作可见输出')

      await idle.prompt('后台定时巡检').done
      await wait(() => idle.saved.length === 7 && !idle.ctl.acpTurn)
      const scheduled = idle.saved[6]
      assert.equal(scheduled.status, 'stop')
      assert.equal(scheduled.continuation, true)
      const timer = scheduled.steps.flatMap((step) => step.tools ?? []).find(({ name }) => name === 'Run schedule')
      assert.equal(timer?.status, 'ok')
      assert.match(timer?.output, /等待触发/)
      assert.equal(idle.connection.session, idle.session)
      await wait(() => idle.saved.length === 8 && !idle.ctl.acpTurn)
      assert.equal(idle.saved[7].status, 'stop')
      assert.equal(idle.saved[7].continuation, true)
      assert.equal(idle.saved[7].steps.map(({ text }) => text).join(''), '已巡检进度')
      ok(true, 'Antigravity 原生定时任务不阻塞后台回合；等待超过旧超时后仍能唤醒原会话')

      await idle.prompt('后台工具无回执').done
      await wait(() => idle.saved.length === 10 && !idle.ctl.acpTurn)
      assert.equal(idle.saved[9].status, 'error')
      assert.match(idle.saved[9].error, /后台工具长时间没有更新/)
      ok(true, '没有终态的普通后台工具仍会超时')
    } finally {
      if (previousIdle === undefined) delete process.env.YAN_ACP_UNSOLICITED_IDLE_MS
      else process.env.YAN_ACP_UNSOLICITED_IDLE_MS = previousIdle
      await idle.ctl.closeAntigravity()
    }

    const compact = await makeAgent('default', 'summary-question')
    try {
      compact.ctl.rpc = { running: true }
      compact.ctl.hydrate = async () => ({ ok: true })
      compact.connection.hasContext = true
      compact.ctl.messages = [
        { id: 'u1', entryId: 'u1', role: 'user', text: '历史任务' },
        { id: 'a1', entryId: 'a1', role: 'assistant', text: '历史答案' }
      ]
      const result = await compact.ctl.runAntigravityCompaction('manual', undefined, { holdAdmission: true })
      ok(result.ok && compact.requests().length === 0 && compact.saved[0]?.includes('提问结果 · cancelled'), '压缩回调直接取消交互题，不显示用户提问卡片', JSON.stringify(result))
    } finally { await compact.ctl.closeAntigravity() }
  }

  {
    const { session: summarySession, events } = start()
    try {
      await summarySession.start(cwd)
      await assert.rejects(summarySession.prompt('structured context checkpoint summary'), /Compaction expected plan mode/)
      const settings = await summarySession.confirmPromptMode('plan')
      await summarySession.prompt('structured context checkpoint summary', settings.current, settings.thinking?.current, 'plan')
      ok(events.some((e) => e.text?.startsWith('## Goal')), '压缩请求使用 CLI 确认的 Plan 档')
    } finally { await summarySession.close() }
  }

  const unknown = start().session
  try {
    await unknown.start(cwd)
    ok((await unknown.selectModel('third-party')).thinking === undefined, '未公布思考档的模型清除前一模型档位')
  } finally { await unknown.close() }

  const legacy = start('legacy').session
  try {
    ok((await legacy.start(cwd)).current === 'flash' && (await legacy.selectModel('pro')).current === 'pro', '兼容旧版 ACP 模型列表和切换')
  } finally { await legacy.close() }

  const auth = start('auth').session
  try {
    await assert.rejects(auth.start(cwd), /agy acp --login/)
    ok(true, '未登录时提示使用官方 CLI 登录')
  } finally { await auth.close() }

  const probe = start().session
  try {
    const discovered = await probe.start(cwd, undefined, { discoverOnly: true })
    ok(discovered.mode === 'auto' && discovered.available.length === 3, '发现模型时只读取 CLI 配置')
    await assert.rejects(probe.prompt('未在当前会话选定自动审批档'), /权限档/)
    ok(true, '拒绝沿用 CLI 全局自动模式')
  } finally { await probe.close() }

  for (const [args, startOpts, checkFn, label] of [
    [['start-default'], { defaultMode: ANTIGRAVITY_DEFAULT_MODE }, (m) => m.mode === 'auto', '未显式指定权限档时，现代 CLI 默认切到 Auto'],
    [[], { mode: 'default', defaultMode: ANTIGRAVITY_DEFAULT_MODE }, (m) => m.mode === 'default', '显式传入权限档时优先保留原选择'],
    [['legacy'], { defaultMode: ANTIGRAVITY_DEFAULT_MODE }, (m) => m.current === 'flash' && m.mode === undefined, '未公布权限档的旧版 CLI 平稳回退']
  ]) {
    const target = start(...args).session
    try {
      const models = await target.start(cwd, undefined, startOpts)
      ok(checkFn(models), label, JSON.stringify(models))
    } finally { await target.close() }
  }

  {
    const first = start()
    let savedAcpId = ''
    try {
      await first.session.start(cwd)
      savedAcpId = first.session.acpSessionId
      await first.session.selectModel('pro')
      await first.session.prompt('记住夹具暗号：砚石')
    } finally {
      await first.session.close()
    }
    const resumed = start()
    try {
      const models = await resumed.session.start(cwd, undefined, { resumeSessionId: savedAcpId, mode: 'plan' })
      ok(resumed.session.resumed === true && resumed.session.acpSessionId === savedAcpId && models.mode === 'plan', '重连优先经 session/resume 原生续接同一 ACP 会话并应用权限档')
      resumed.events.length = 0
      await resumed.session.prompt('检查续接方式', 'pro', 'high', 'plan')
      const replyText = resumed.events.filter((e) => e.type === 'text').map((e) => e.text).join('')
      resumed.events.length = 0
      await resumed.session.prompt('检查上下文', 'pro', 'high', 'plan')
      const ctxText = resumed.events.filter((e) => e.type === 'text').map((e) => e.text).join('')
      ok(replyText.startsWith('原生续接') && ctxText === '上下文收到 · pro', '原生续接保留原会话上下文且无需冷交接 JSON', JSON.stringify({ replyText, ctxText }))
    } finally {
      await resumed.session.close()
    }
    const loadFallback = start('load-only')
    try {
      await loadFallback.session.start(cwd, undefined, { resumeSessionId: savedAcpId })
      ok(
        loadFallback.session.resumed === true &&
        loadFallback.session.context?.used === 480 &&
        !loadFallback.events.some((e) => e.type === 'text' && e.text.includes('回放噪音')),
        '不支持 session/resume 时回退 session/load，同时屏蔽历史回放噪音并保留上下文读数',
        JSON.stringify({ resumed: loadFallback.session.resumed, ctx: loadFallback.session.context, events: loadFallback.events })
      )
    } finally {
      await loadFallback.session.close()
    }
    const mismatchedResume = start('wrong-resume-id')
    try {
      await mismatchedResume.session.start(cwd, undefined, { resumeSessionId: savedAcpId })
      ok(mismatchedResume.session.resumed && mismatchedResume.session.acpSessionId === savedAcpId && mismatchedResume.session.context?.used === 480 &&
        !mismatchedResume.events.some((e) => e.type === 'text'), 'resume 确认了不匹配的 ID 时回退 load，丢弃失败续接的回放和上下文')
    } finally { await mismatchedResume.session.close() }
    const missingResume = start('wrong-resume-id')
    try {
      await missingResume.session.start(cwd, undefined, { resumeSessionId: 'missing-session-id' })
      ok(missingResume.session.resumed === false && missingResume.session.acpSessionId && missingResume.session.acpSessionId !== 'missing-session-id', '旧 ACP 会话不存在时平稳回退 session/new')
    } finally {
      await missingResume.session.close()
    }
    const authResume = start('auth')
    try {
      await assert.rejects(authResume.session.start(cwd, undefined, { resumeSessionId: savedAcpId }), /agy acp --login/)
      ok(true, 'session/resume 遇到登录认证错误时直接报错，不静默新建会话')
    } finally {
      await authResume.session.close()
    }
  }

  {
    const { session, events } = start()
    const request = (prompt, mode) => {
      events.length = 0
      return session.prompt(prompt, 'flash', 'low', mode)
    }
    const receipt = () => events.filter((e) => e.type === 'text').map((e) => e.text).join('')
    const permission = () => events.find((e) => e.type === 'permission')
    const prompts = ['检查 MCP 权限', '检查命令权限', '检查文件权限']
    try {
      const mcpConfig = [{ name: 'inkstone-pi', command: process.execPath, args: [], env: [] }]
      await session.start(cwd, mcpConfig, { mode: 'auto' })
      for (const prompt of prompts) {
        const pending = request(prompt, 'auto')
        await wait(() => permission() || receipt())
        const asked = permission()
        if (asked) session.reply(asked.id, 'deny')
        ok(await pending === 'end_turn' && !asked && receipt() === '审批结果 · once', `Auto 档自动允许一次且不发审批事件：${prompt}`)
      }

      for (const prompt of ['详情缺失']) {
        const pending = request(prompt, 'auto')
        const asked = await wait(() => permission() || receipt())
        if (permission()) {
          session.reply(asked.id, 'once')
          session.reply(asked.id, 'deny')
        }
        ok(await pending === 'end_turn' && asked.options?.map((option) => option.id).join() === 'deny' &&
          receipt() === '审批结果 · deny', `Auto 档仅可拒绝，不自动放行：${prompt}`)
      }

      for (const prompt of ['详情超限', '大工具载荷']) {
        const pending = request(prompt, 'auto')
        await wait(() => permission() || receipt())
        const asked = permission()
        if (asked) session.reply(asked.id, 'deny')
        ok(await pending === 'end_turn' && !asked && receipt() === '审批结果 · once', `Auto 档放行超长详情且不弹审批：${prompt}`)
      }

      for (const mode of ['default', 'accept-edits', 'plan']) {
        await session.selectMode(mode)
        for (const prompt of prompts) {
          const pending = request(prompt, mode)
          const asked = await wait(() => permission() || receipt())
          if (permission()) session.reply(asked.id, 'deny')
          ok(await pending === 'end_turn' && asked.options?.map((option) => option.id).join() === 'once,deny' &&
            receipt() === '审批结果 · deny', `${mode} 档保留单次审批：${prompt}`)
        }
      }
    } finally {
      await session.close()
    }
  }

  {
    const slowServer = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { echoed: parsed.method } }))
        }, 250)
      })
    })
    await new Promise((done) => slowServer.listen(0, '127.0.0.1', done))
    const port = slowServer.address().port
    const token = `Bearer ${'a'.repeat(64)}`
    const bridge = spawn(process.execPath, [resolve('resources/pi-extensions/antigravity-pi-mcp.mjs')], {
      env: { ...process.env, INKSTONE_PI_MCP_URL: `http://127.0.0.1:${port}/mcp`, INKSTONE_PI_MCP_AUTH: token },
      windowsHide: true
    })
    const replies = []
    const reader = createInterface({ input: bridge.stdout })
    reader.on('line', (line) => replies.push(JSON.parse(line)))
    try {
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })}\n`)
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
      await wait(() => replies.length === 2)
      ok(replies[0].id === 2 && !replies[0].error && replies[1].id === 1 && replies[1].result?.echoed === 'tools/call', 'MCP stdio 桥并发处理请求，慢调用不阻塞 ping 心跳', JSON.stringify(replies))
    } finally {
      bridge.stdin.end()
      await new Promise((done) => bridge.once('exit', done))
      slowServer.close()
      slowServer.closeAllConnections()
    }
  }

  {
    const { openAntigravityDelegation } = await compile('src/main/antigravity-delegation.ts')
    const controller = new AbortController()
    let mode = 'plan'
    const calls = []
    const sharedOwned = new Set()
    const confirmCalls = []
    const mockMcpTools = [{ name: 'codegraph_explore', description: 'Explore codegraph', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]
    const mockManager = {
      list: () => [],
      listToolsRaw: async () => mockMcpTools,
      listToolsCached: async () => mockMcpTools,
      pinConnection: () => undefined,
      callTool: async (_serverId, toolName, args) => ({ content: [{ type: 'text', text: `${toolName}:${args.query}` }] })
    }
    const bridge = await openAntigravityDelegation(
      resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
      () => ({
        signal: controller.signal,
        mode,
        run: async (command, params) => {
          calls.push({ command, params })
          if (command === 'subagent.get') {
            return {
              summary: { id: params.id, status: 'done', latestActivity: '已完成' },
              data: { model: 'openai-codex/gpt-6.2-sol', thinkingLevel: 'high', finalMessage: '审查结论', changedFiles: ['src/a.ts'] }
            }
          }
          return { summary: { id: 'sub-11112222', status: 'running', model: params.model, thinkingLevel: params.thinkingLevel } }
        }
      }),
      {
        delegate: true,
        services: [{ name: 'codegraph', manager: mockManager }],
        commandHost: {
          cwd: () => cwd,
          mcpConnectionManager: () => mockManager,
          mcpConfigError: () => undefined,
          permissionMode: async () => 'danger',
          confirmDanger: async (req) => { confirmCalls.push(req); return { decision: 'allow', choice: 'once' } },
          approvalOwner: () => ({})
        },
        owned: sharedOwned
      }
    )
    try {
      const env = Object.fromEntries(bridge.configs[0].env.map(({ name, value }) => [name, value]))
      const cgEnv = Object.fromEntries(bridge.configs.find(({ name }) => name === 'codegraph').env.map(({ name, value }) => [name, value]))
      const callMcp = async (url, auth, method, params) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
        return (await res.json()).result
      }
      const [http, codegraphHttp] = bridge.httpConfigs
      assert.deepEqual(http, { type: 'http', name: 'inkstone-pi', url: env.INKSTONE_PI_MCP_URL, headers: [{ name: 'Authorization', value: env.INKSTONE_PI_MCP_AUTH }] })
      assert.deepEqual(codegraphHttp, { type: 'http', name: 'codegraph', url: cgEnv.INKSTONE_PI_MCP_URL, headers: [{ name: 'Authorization', value: cgEnv.INKSTONE_PI_MCP_AUTH }] })
      assert.equal((await fetch(http.url, { method: 'POST' })).status, 403)
      assert.equal((await fetch(http.url, { method: 'POST', headers: { Authorization: env.INKSTONE_PI_MCP_AUTH, Origin: 'http://localhost' } })).status, 403)
      const listed = await callMcp(http.url, http.headers[0].value, 'tools/list', {})
      ok(listed.tools.length === 2, 'HTTP 配置直接调用挂载的 loopback MCP，未改动 stdio 配置和鉴权防线')
      const direct = start('http-mcp')
      try {
        const fakeBridgeDoesNotExist = { ...bridge.configs[0], command: join(cwd, 'nonexistent-fixture-bridge') }
        await direct.session.start(cwd, { stdio: [fakeBridgeDoesNotExist], http: bridge.httpConfigs })
        await direct.session.prompt('后台派 Pi 子代理')
        assert.ok(direct.events.some((event) => event.text?.startsWith('已派发后台子代理 · sub-11112222')))
        ok(calls.length === 1, '声明 HTTP 能力的夹具可绕过 stdio 可执行项直接委派')
        calls.length = 0
      } finally { await direct.session.close() }
      const startSchema = listed.tools.find((tool) => tool.name === 'start_pi_subagent')?.inputSchema
      ok(Array.isArray(startSchema?.properties?.thinkingLevel?.enum) && startSchema.properties.thinkingLevel.enum.includes('high') && startSchema.properties.thinkingLevel.enum.includes('max'), 'start_pi_subagent 工具模式公开合法 thinkingLevel 枚举')
      const cgListed = await callMcp(cgEnv.INKSTONE_PI_MCP_URL, cgEnv.INKSTONE_PI_MCP_AUTH, 'tools/list', {})
      ok(cgListed.tools.some((tool) => tool.name === 'codegraph_explore') && bridge.knownTools().has('codegraph_explore'), '同步 MCP 暴露的工具名同步登记到 knownTools')
      const cgPlanDenied = await callMcp(cgEnv.INKSTONE_PI_MCP_URL, cgEnv.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'q' } })
      ok(cgPlanDenied.isError === true && confirmCalls.length === 0, 'Plan 模式下拦截非只读同步 MCP 工具')
      mode = 'default'
      const cgDefault = await callMcp(cgEnv.INKSTONE_PI_MCP_URL, cgEnv.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'q1' } })
      ok(!cgDefault.isError && confirmCalls.length === 1, 'default 档下同步 MCP 工具仍触发宿主审批')
      mode = 'auto'
      const cgAuto = await callMcp(cgEnv.INKSTONE_PI_MCP_URL, cgEnv.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'q2' } })
      ok(!cgAuto.isError && cgAuto.content?.[0]?.text === 'codegraph_explore:q2' && confirmCalls.length === 1, 'Auto 档下同步 MCP 工具关闭宿主审批，直接执行返回结果', JSON.stringify({ cgAuto, confirmCalls: confirmCalls.length }))
      mode = 'plan'
      const denied = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'edit files' } })
      ok(denied.isError === true && calls.length === 0, 'Plan 模式下拒绝派发可写 Pi 子代理')
      const badThinking = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'inspect files', readOnly: true, thinkingLevel: 'turbo' } })
      ok(badThinking.isError === true && calls.length === 0, '拒绝非法 thinkingLevel 参数')
      const allowed = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'start_pi_subagent', arguments: { task: 'inspect files', model: 'openai-codex/gpt-6.2-sol', thinkingLevel: ' HIGH ', readOnly: true } })
      const startedPayload = JSON.parse(allowed.content[0].text)
      ok(!allowed.isError && calls.length === 1 && calls[0].params.thinkingLevel === 'high' && startedPayload.thinkingLevel === 'high', 'Plan 模式下允许派发只读 Pi 子代理并透传 thinkingLevel', JSON.stringify({ calls, startedPayload }))
      const fetched = await callMcp(env.INKSTONE_PI_MCP_URL, env.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-11112222' } })
      const fetchedPayload = JSON.parse(fetched.content[0].text)
      ok(!fetched.isError && fetchedPayload.thinkingLevel === 'high' && fetchedPayload.latestActivity === '已完成' && fetchedPayload.changedFiles?.[0] === 'src/a.ts', 'get_pi_subagent 返回思考档位、最新进度和改动文件', JSON.stringify(fetchedPayload))

      const reconnected = await openAntigravityDelegation(
        resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
        () => ({
          signal: controller.signal,
          mode,
          run: async () => ({
            summary: { id: 'sub-11112222', status: 'done' },
            data: { model: 'openai-codex/gpt-6.2-sol', thinkingLevel: 'high', finalMessage: '压缩后可读' }
          })
        }),
        { delegate: true, services: [], commandHost: { cwd: () => cwd, mcpConnectionManager: () => ({ list: () => [] }), mcpConfigError: () => undefined, permissionMode: async () => 'danger', confirmDanger: async () => null, approvalOwner: () => ({}) }, owned: sharedOwned }
      )
      try {
        const env2 = Object.fromEntries(reconnected.configs[0].env.map(({ name, value }) => [name, value]))
        const afterReconnect = await callMcp(env2.INKSTONE_PI_MCP_URL, env2.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-11112222' } })
        const stranger = await callMcp(env2.INKSTONE_PI_MCP_URL, env2.INKSTONE_PI_MCP_AUTH, 'tools/call', { name: 'get_pi_subagent', arguments: { id: 'sub-99999999' } })
        ok(!afterReconnect.isError && JSON.parse(afterReconnect.content[0].text).finalMessage === '压缩后可读' && stranger.isError === true, 'ACP 重连或压缩后仍可读取本会话已派发的 Pi 子代理，且继续拦截陌生子代理')
      } finally {
        await reconnected.close()
      }
    } finally {
      await bridge.close()
    }
  }

  {
    const prefRoot = mkdtempSync(join(tmpdir(), 'inkstone-acp-pref-'))
    const prevYanDir = process.env.YAN_DATA_DIR
    process.env.YAN_DATA_DIR = prefRoot
    try {
      const prefs = await compile('src/main/antigravity-preferences.ts')
      await prefs.saveAntigravityPreference('sess-acp-1', {
        model: { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        acpSessionId: 'acp-uuid-123',
        acpCwd: 'E:\\pi-desktop',
        acpHeadEntryId: 'entry-99'
      })
      const file = prefs.antigravityPreferencePath(prefRoot, 'sess-acp-1')
      const loadedPref = prefs.readAntigravityPreference('sess-acp-1')
      ok(
        existsSync(file) &&
        loadedPref?.model.id === 'gemini-4-neon' &&
        loadedPref.acpSessionId === 'acp-uuid-123' &&
        loadedPref.acpCwd === 'E:\\pi-desktop' &&
        loadedPref.acpHeadEntryId === 'entry-99',
        'Antigravity 偏好可保存并回读模型与原生续接会话锚点'
      )
      await prefs.saveAntigravityPreference('sess-acp-1', null)
      ok(!existsSync(file) && prefs.readAntigravityPreference('sess-acp-1') === undefined, '切回 Pi 时删除偏好文件，不残留 null 文件')
    } finally {
      if (prevYanDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevYanDir
      rmSync(prefRoot, { recursive: true, force: true })
    }
  }

  {
    const { groupIntoTurns } = await compile('src/shared/turns.ts')
    const { projectSessionMetrics } = await compile('src/shared/session-metrics.ts')
    const { toolCategory } = await compile('src/renderer/src/features/session/tool-run-model.ts')
    const { extractGeminiProgressHeadings, splitTurnProcess, withGeminiProgressNotes } = await compile('src/renderer/src/features/session/turn-process.ts')

    ok(
      toolCategory({ name: '读取配置', args: {}, details: { antigravity: true, kind: 'read' } }) === 'read' &&
      toolCategory({ name: '执行测试', args: {}, details: { antigravity: true, kind: 'execute' } }) === 'command' &&
      toolCategory({ name: '新建文件', args: {}, details: { antigravity: true, kind: 'edit', antigravityDiffs: [{ status: 'created' }] } }) === 'create',
      'ACP 工具按 details.kind 正确归类到过程摘要'
    )

    const multiStep = [
      { id: 'u1', role: 'user', text: '检查项目', timestamp: 1000 },
      { id: 'a1', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '正在检查配置。', thinking: '**检查配置**\n\n先读 package.json', toolCalls: [{ id: 't1', name: '读取 package.json', status: 'ok', args: {}, details: { antigravity: true, kind: 'read' } }], timestamp: 1001 },
      { id: 'a2', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '检查完成。', antigravity: { usage: { input: 80, output: 20, cacheRead: 20, cacheWrite: 0, totalTokens: 120 } }, turnTiming: { logicalTurnId: 'u1', startedAt: 1000, endedAt: 2000, elapsedMs: 1000, terminalReason: 'completed' }, timestamp: 1002 }
    ]
    const [_, turn] = groupIntoTurns(multiStep)
    ok(turn.kind === 'assistant' && turn.commentary.length === 1 && turn.commentary[0].text === '正在检查配置。' && turn.response?.text === '检查完成。', 'Antigravity 多步回合把工具前文本归为进度报告，最后一步为最终答复')
    const metrics = projectSessionMetrics(multiStep, null, { antigravity: true })
    ok(metrics.partial === false && metrics.total === 120 && Math.round(metrics.hitRate) === 20, 'Antigravity 多步回合的用量与缓存命中率不被中间步误判为部分数据', JSON.stringify(metrics))

    const withoutWrite = structuredClone(multiStep)
    delete withoutWrite[2].antigravity.usage.cacheWrite
    const noWriteMetrics = projectSessionMetrics(withoutWrite, null, { antigravity: true })
    ok(noWriteMetrics.cacheWrite === null && noWriteMetrics.hitRate === 20 && noWriteMetrics.latestHitRate === 20,
      'Antigravity 未上报缓存写入时仍计算整会话及最近回合命中率')

    const headings = extractGeminiProgressHeadings('**检查登录逻辑**\n\n细节如下：\n```\n**代码块里的星号不是标题**\n```\n**准备修改文件**：\n继续分析')
    ok(headings.join('|') === '检查登录逻辑|准备修改文件', '从 Gemini 思考摘要提取阶段标题并忽略代码块', JSON.stringify(headings))

    const geminiSilentTools = [
      { id: 'u2', role: 'user', text: '修 bug', timestamp: 2000 },
      { id: 'g1', role: 'assistant', model: 'google/gemini-3.1-pro', text: '', thinking: '**定位根因**\n\n先读取相关文件。', toolCalls: [{ id: 'gt1', name: 'read', status: 'ok', args: { path: 'a.ts' } }], timestamp: 2001 },
      { id: 'g2', role: 'assistant', model: 'google/gemini-3.1-pro', text: '已修复。', timestamp: 2002 }
    ]
    const [, gTurn] = groupIntoTurns(geminiSilentTools)
    const gSplit = splitTurnProcess(gTurn.segments, { keepThinking: true })
    const withProgress = withGeminiProgressNotes(gSplit.process, gTurn.model)
    ok(withProgress[0].commentary.length === 1 && withProgress[0].commentary[0].text === '定位根因', 'Pi 原生 Gemini 缺少正文进度句时，从思考标题生成步骤进度报告')

    const claudeSplit = withGeminiProgressNotes(gSplit.process, 'anthropic/claude-opus-5-5')
    ok(claudeSplit[0].commentary.length === 0, '非 Gemini 模型不触发 Gemini 思考标题提取')

    const acpWithNote = splitTurnProcess(turn.segments, { keepThinking: true })
    const acpProgress = withGeminiProgressNotes(acpWithNote.process, turn.model)
    ok(acpProgress[0].commentary.length === 1 && acpProgress[0].commentary[0].text === '正在检查配置。', 'Gemini 已有正文进度句时不重复叠加思考标题')

    const { stepDecode } = await compile('src/shared/session-metrics.ts')
    const thinkingStep = {
      id: 'a-speed',
      role: 'assistant',
      model: 'antigravity/gemini-4-neon',
      text: '这是一段足够长的最终输出回复，用来验证思考档在缺少 visibleOutputTokens 时仍可回退估算输出速度。',
      thinking: '**分析**\n\n思考过程',
      generationTiming: { startEvent: 'turn_start', ttftMs: 200, decodeMs: 1200, outputDecodeMs: 500, durationMs: 1400 }
    }
    const decoded = stepDecode(thinkingStep)
    ok(decoded !== null && decoded.ms === 500 && decoded.tokens > 0, 'Antigravity 开启思考档且未单报 visibleOutputTokens 时回退 generationTiming 估算速度', JSON.stringify(decoded))

    const { classifyModelError, modelErrorCause } = await compile('src/shared/model-errors.ts')
    const { errorCardModel } = await compile('src/renderer/src/features/session/turn-lines.ts')
    const saveErr = '回复未能保存到会话：原生操作 append_antigravity_turn 超时（15000ms）'
    const saveCard = errorCardModel(saveErr)
    ok(
      classifyModelError(saveErr).kind === 'hostSave' &&
      modelErrorCause(saveErr) === 'hostSave' &&
      saveCard?.kind === 'hostSave' &&
      saveCard.actions.length === 0,
      '本地保存失败不误判为模型超时，也不诱导重跑模型',
      JSON.stringify(saveCard)
    )

    const { contextPaneData, contextPaneToolCalls } = await compile('src/renderer/src/features/workbench/context-pane-view.ts')
    const acpCtxSession = { model: { provider: 'antigravity', id: 'gemini-4-neon', name: 'Gemini 4 Neon', contextWindow: 100000 } }
    const acpCtxStats = { contextUsage: { modelKey: 'antigravity/gemini-4-neon', tokens: 25000, contextWindow: 100000, percent: 25, availability: 'known' } }
    const acpCtxMsgs = [
      { id: 'u-ctx', role: 'user', text: '分析这段代码', timestamp: 1000 },
      { id: 'a-ctx', role: 'assistant', model: 'antigravity/gemini-4-neon', text: '分析完成', toolCalls: [{ id: 'tc-1', name: 'read', args: { path: 'src/main/agent.ts' }, output: 'x'.repeat(2000), status: 'ok', details: { antigravity: true, kind: 'read' } }], timestamp: 1001 }
    ]
    const ctxData = contextPaneData({ session: acpCtxSession, stats: acpCtxStats, messages: acpCtxMsgs })
    const ctxTools = contextPaneToolCalls({ session: acpCtxSession, stats: acpCtxStats, messages: acpCtxMsgs })
    ok(ctxData.usage.known && ctxData.parts.length >= 2 && ctxData.parts.every((p) => p.approx === true) && ctxTools.length === 1, 'Antigravity 展开上下文明细展示分类估算与大工具排行', JSON.stringify({ parts: ctxData.parts, tools: ctxTools.length }))
    const ctxCapped = contextPaneData({
      session: { ...acpCtxSession, autoCompactionEnabled: true },
      stats: { contextUsage: { modelKey: 'antigravity/gemini-4-neon', tokens: 200_000, contextWindow: 1_048_576, percent: 19, availability: 'known' } },
      messages: acpCtxMsgs,
      autoCompactLimit: 400_000
    })
    ok(ctxCapped.usage.cappedByLimit && ctxCapped.usage.windowSize === 400_000 && Math.round(ctxCapped.usage.percent ?? 0) === 50, 'Antigravity 上下文同步 Inkstone 自动压缩上限（如 400K）', JSON.stringify(ctxCapped.usage))

    const { SessionItemProjector } = await compile('src/main/session-items/projector.ts')
    const projector = new SessionItemProjector()
    projector.appendPersisted({
      role: 'assistant',
      provider: 'antigravity',
      model: 'gemini-4-neon',
      content: [{ type: 'text', text: '完成' }],
      yanAntigravityTools: [{ id: 'acp-1', name: 'File /a.ts', status: 'ok', args: { Path: 'E:\\pi-desktop\\a.ts' }, details: { antigravity: true, kind: 'read' } }],
      timestamp: 1002
    })
    const persisted = projector.uiMessages()
    ok(persisted.length === 1 && persisted[0].toolCalls?.[0]?.cancelled !== true, '冷恢复持久化 Antigravity 工具不被误标为 cancelled', JSON.stringify(persisted[0]?.toolCalls))

    const { toolStepTitle } = await compile('src/renderer/src/features/session/tool-title.ts')
    const { toolRunningLabel } = await compile('src/renderer/src/features/session/tool-summary.ts')
    const acpSegs = withGeminiProgressNotes([{
      id: 's-acp-1',
      sourceMessageId: 'm-acp-1',
      thinking: "I'm thinking through how to approach this.\n\nChecking the uncommitted git diff and recent session transcript to find why images are blocked.\n\nPreparing to patch composer-submit.ts next.",
      thinkingLive: false,
      tools: [{ id: 't-1', name: 'git status', status: 'ok', args: { CommandLine: 'git status', toolSummary: 'Check git status' }, details: { antigravity: true, kind: 'execute' } }],
      texts: [],
      commentary: [],
      response: null
    }], 'antigravity/gemini-4-neon')
    ok(acpSegs[0].commentary.length === 2 && acpSegs[0].commentary[0].text.includes('Checking the uncommitted git diff'), '无粗体标题的 Antigravity 思考段在有工具调用时提取清晰进度文字', JSON.stringify(acpSegs[0].commentary))
    const ttStub = (key) => ({ stepRead: '已读取', stepReadRunning: '正在读取', stepRan: '已运行', stepRunning: '正在运行' }[key] ?? key)
    const acpReadTitle = toolStepTitle({ name: 'File /E:/pi-desktop/src/main/agent.ts', status: 'running', args: { Path: 'E:\\pi-desktop\\src\\main\\agent.ts' }, details: { antigravity: true, kind: 'read' } }, ttStub)
    const acpCmdLabel = toolRunningLabel({ id: 't-2', name: 'git status --short', status: 'running', args: { CommandLine: 'git status --short', toolSummary: 'Check git status' }, details: { antigravity: true, kind: 'execute' } }, '生成参数中', ttStub)
    ok(acpReadTitle.label === '正在读取' && acpReadTitle.meta === 'agent.ts' && acpCmdLabel === 'Check git status', 'Antigravity 工具行标题与运行中进度标签识别 kind、Path 和 toolSummary', JSON.stringify({ acpReadTitle, acpCmdLabel }))
  }

  {
    const bridgeMod = await import(new URL('../resources/pi-extensions/native-session-bridge.js', import.meta.url))
    const { NativeSessionRuntime } = await compile('src/main/native-session-runtime.ts')
    const { YAN_DIR } = await compile('src/main/paths.ts')
    const prevYanDir = process.env.YAN_DATA_DIR
    process.env.YAN_DATA_DIR = YAN_DIR
    let handler
    let leaf = null
    const appended = []
    const emitted = []
    const piStub = {
      on() {},
      registerCommand(_name, spec) { handler = spec.handler },
      setLabel() {}
    }
    const prevBridgeEnv = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    bridgeMod.default(piStub)
    const runtime = new NativeSessionRuntime({
      async command(_type, payload) {
        const argText = String(payload?.message ?? '').replace(/^\/__inkstone_native\s+/, '')
        const ctx = {
          isIdle: () => true,
          ui: { notify: (msg) => { emitted.push(msg); runtime.handleNotify(msg) } },
          sessionManager: {
            getSessionId: () => 'sess-big-1',
            getLeafId: () => leaf,
            resetLeaf: () => { leaf = null },
            branch: (id) => { leaf = id },
            appendMessage: (msg) => {
              const id = `entry-${appended.length + 1}`
              appended.push({ id, msg })
              leaf = id
              return id
            }
          },
          navigateTree: async (targetId) => { leaf = targetId; return { cancelled: false } }
        }
        void handler(argText, ctx)
        return { success: true, data: { disposition: 'handled' } }
      }
    }, 5_000)
    try {
      runtime.handleNotify(bridgeMod.buildReceipt({ id: 'hello-1', op: 'hello', ok: true, result: { capabilities: ['append_antigravity_turn'] } }))
      const hugeTools = Array.from({ length: 150 }, (_, i) => ({
        id: `tool-${i}`,
        name: `read_file_${i}`,
        status: 'ok',
        args: { path: `src/file-${i}.ts` },
        output: 'A'.repeat(2200)
      }))
      const saved = await runtime.appendAntigravityTurn({
        sessionId: 'sess-big-1',
        user: '超大回合测试',
        userImages: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        steps: [{ text: '完成了 150 次工具调用', tools: hugeTools, genTiming: { startEvent: 'turn_start', ttftMs: 100, decodeMs: 600, outputDecodeMs: 400, durationMs: 700 }, timestamp: 2000 }],
        model: 'gemini-4-neon',
        startedAt: 1000,
        endedAt: 2000,
        status: 'stop'
      })
      const userEntry = appended.find((e) => e.id === saved.userId)?.msg
      const assistantEntry = appended.find((e) => e.id === saved.assistantId)?.msg
      ok(
        appended.length === 2 &&
        Array.isArray(userEntry?.content) && userEntry.content.some((c) => c.type === 'image') &&
        assistantEntry?.yanAntigravityTools?.length === 150 &&
        assistantEntry?.yanAntigravityGenTiming?.outputDecodeMs === 400,
        '超大回合（> 256 KB、150 次工具调用）经临时文件成功落盘并保存图片与速度计时',
        JSON.stringify({ saved, count: appended.length })
      )

      const contSaved = await runtime.appendAntigravityTurn({
        sessionId: 'sess-big-1',
        continuation: true,
        steps: [{ text: '后台续跑完成', timestamp: 2500 }],
        model: 'gemini-4-neon',
        startedAt: 2100,
        endedAt: 2500,
        status: 'stop'
      })
      ok(
        appended.length === 3 &&
        contSaved.userId === undefined &&
        appended[2].msg.role === 'assistant' &&
        appended[2].msg.content?.[0]?.text === '后台续跑完成',
        'append_antigravity_turn 支持无伪造用户消息的助手续跑落盘',
        JSON.stringify(contSaved)
      )

      let errWithId
      try {
        const oversized = Buffer.from(JSON.stringify({ v: 1, host: 'inkstone', id: 'req-oversized-1', op: 'noop', args: { pad: 'x'.repeat(300_000) } }), 'utf8').toString('base64url')
        bridgeMod.parseEnvelope(oversized)
      } catch (err) {
        errWithId = err
      }
      ok(errWithId?.requestId === 'req-oversized-1', 'parseEnvelope 超限时仍能提取原请求 ID，避免丢回执假超时', String(errWithId?.requestId))
    } finally {
      if (prevBridgeEnv === undefined) delete process.env.YAN_NATIVE_BRIDGE
      else process.env.YAN_NATIVE_BRIDGE = prevBridgeEnv
      if (prevYanDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevYanDir
    }
  }

  {
    const compactMod = await compile('src/main/antigravity-compact.ts')
    const { readSessionMessages } = await compile('src/main/session-reader.ts')
    const { measuredAfterCompaction } = await compile('src/main/compaction.ts')
    const { contextUsageSummary } = await compile('src/renderer/src/features/workbench/context-pane-view.ts')
    const msgs = [
      { id: 'm1', entryId: 'e1', role: 'user', text: '先读 README 并分析架构', timestamp: 1000 },
      { id: 'm2', entryId: 'e2', role: 'assistant', model: 'antigravity/pro', text: 'x'.repeat(90_000), timestamp: 1001 },
      { id: 'm3', entryId: 'e3', role: 'user', text: '继续修第二个问题', timestamp: 1002 },
      { id: 'm4', entryId: 'e4', role: 'assistant', model: 'antigravity/pro', text: '已完成', antigravity: { context: { used: 420_000, size: 1_000_000 } }, timestamp: 1003 }
    ]
    const plan = compactMod.planAntigravityCompaction(msgs, { keepRecentTokens: 20_000 })
    ok(plan.ok && plan.toSummarize.length === 2 && plan.kept.length === 2 && plan.firstKeptEntryId === 'e3', 'Antigravity 压缩规划按最近 token 预算并对齐用户回合边界', JSON.stringify({ toSum: plan.toSummarize?.length, firstKept: plan.firstKeptEntryId }))

    const singleHuge = [
      { id: 'm1', entryId: 'e1', role: 'user', text: '一个超长任务', timestamp: 1000 },
      { id: 'm2', entryId: 'e2', role: 'assistant', model: 'antigravity/pro', text: 'y'.repeat(120_000), timestamp: 1001 }
    ]
    const fullPlan = compactMod.planAntigravityCompaction(singleHuge, { keepRecentTokens: 20_000 })
    ok(fullPlan.ok && fullPlan.toSummarize.length === 2 && fullPlan.kept.length === 0 && !fullPlan.firstKeptEntryId, '单回合超限时允许整段压缩而不拒绝', JSON.stringify({ toSum: fullPlan.toSummarize?.length, kept: fullPlan.kept?.length }))

    const chunks = compactMod.serializeCompactChunks(msgs, 40_000)
    ok(chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 40_000), '压缩分块把超大消息切分在块上限之内', String(chunks.length))
    const denseChinese = [{ id: 'm-zh', entryId: 'e-zh', role: 'assistant', model: 'antigravity/pro', text: '砚'.repeat(55_000), timestamp: 1005 }]
    const zhChunks = compactMod.serializeCompactChunks(denseChinese)
    ok(zhChunks.length >= 2 && zhChunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 100_000), '压缩分块对高字节中文按 UTF-8 字节上限切分，避免超过 CLI 截断线', JSON.stringify(zhChunks.map((c) => Buffer.byteLength(c, 'utf8'))))
    const keptBytesPlan = compactMod.planAntigravityCompaction([
      { id: 'u1', entryId: 'e1', role: 'user', text: '开头', timestamp: 1000 },
      { id: 'u2', entryId: 'e2', role: 'user', text: '砚'.repeat(35_000), timestamp: 1001 },
      { id: 'a2', entryId: 'e3', role: 'assistant', model: 'antigravity/pro', text: '完成', timestamp: 1002 }
    ], { keepRecentTokens: 200_000 })
    ok(keptBytesPlan.ok && keptBytesPlan.kept.length === 1 && keptBytesPlan.firstKeptEntryId === 'e3', '压缩保留区间同时受序列化字节预算约束，确保压缩后冷交接不超限', JSON.stringify({ kept: keptBytesPlan.kept?.length, firstKept: keptBytesPlan.firstKeptEntryId }))
    ok(compactMod.detectCompactLanguage(msgs)?.includes('Chinese'), '根据用户消息识别中文压缩摘要语言')

    const withSummary = antigravityPrompt('继续', plan.kept, '## Goal\n修好压缩')
    ok(withSummary.includes('<prior-compaction-summary>\n## Goal\n修好压缩\n</prior-compaction-summary>') && withSummary.includes('继续修第二个问题') && !withSummary.includes('先读 README'), '交接提示词只携带压缩摘要与保留消息', withSummary.slice(0, 120))
    const summaryOnly = antigravityPrompt('继续', [], '## Goal\n全部已压缩')
    ok(summaryOnly.includes('<prior-compaction-summary>') && !summaryOnly.includes('[]'), '无保留消息时仅附带压缩摘要')

    const measured = measuredAfterCompaction(
      { status: 'completed', reason: 'threshold', startedAt: 1000, endedAt: 1050, beforeTokens: 450_000, afterTokens: 25_000, afterMeasured: false },
      [{ id: 'm5', entryId: 'e5', role: 'assistant', model: 'antigravity/pro', text: '下一轮', antigravity: { context: { used: 35_000, size: 1_000_000 } }, timestamp: 2000 }]
    )
    ok(measured?.afterMeasured === true && measured.afterTokens === 35_000, '压缩后下一轮 Antigravity 回合回填实测 token 数')

    const afterSummaryView = contextUsageSummary(
      {
        model: { provider: 'antigravity', id: 'pro', name: 'Gemini Pro', contextWindow: 0 },
        autoCompactionEnabled: true,
        lastCompaction: { status: 'completed', reason: 'manual', startedAt: 1000, endedAt: 1050, beforeTokens: 450_000, afterTokens: 24_000, afterMeasured: false }
      },
      { contextUsage: { modelKey: 'antigravity/pro', tokens: null, contextWindow: 1_000_000, percent: null, availability: 'known' } },
      400_000
    )
    ok(afterSummaryView.known && afterSummaryView.estimated && afterSummaryView.tokens === 24_000 && afterSummaryView.windowSize === 400_000, 'Antigravity 压缩后立即展示估算剩余用量', JSON.stringify(afterSummaryView))

    const tmpSessionDir = mkdtempSync(join(tmpdir(), 'inkstone-acp-compact-'))
    try {
      const sessionPath = join(tmpSessionDir, 'compact.jsonl')
      const lines = [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-c1', timestamp: new Date(1000).toISOString(), cwd }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: new Date(1001).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '旧问题' }], timestamp: 1001 } }),
        JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date(1002).toISOString(), message: { role: 'assistant', api: 'antigravity-acp', provider: 'antigravity', model: 'pro', content: [{ type: 'text', text: '旧回答' }], timestamp: 1002 } }),
        JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'a1', timestamp: new Date(1003).toISOString(), summary: '## Goal\n摘要内容', firstKeptEntryId: 'c1', tokensBefore: 420_000 }),
        JSON.stringify({ type: 'message', id: 'u2', parentId: 'c1', timestamp: new Date(1004).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '新问题' }], timestamp: 1004 } })
      ]
      writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8')
      const read = await readSessionMessages(sessionPath, { fullText: true })
      const sliced = compactMod.sliceInContextMessages(read.messages, read.compaction)
      ok(read.compaction?.summary === '## Goal\n摘要内容' && sliced.length === 1 && sliced[0].text === '新问题', 'readSessionMessages 提取活动分支压缩摘要并准确切片保留消息', JSON.stringify({ summary: read.compaction?.summary, sliced: sliced.map((m) => m.text) }))
    } finally {
      rmSync(tmpSessionDir, { recursive: true, force: true })
    }

    const bridgeMod = await import(new URL('../resources/pi-extensions/native-session-bridge.js', import.meta.url))
    const { NativeSessionRuntime } = await compile('src/main/native-session-runtime.ts')
    let handler
    let leaf = 'a1'
    const compactions = []
    const prevBridgeEnv = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    bridgeMod.default({ on() {}, registerCommand(_name, spec) { handler = spec.handler }, setLabel() {} })
    const runtime = new NativeSessionRuntime({
      async command(_type, payload) {
        const argText = String(payload?.message ?? '').replace(/^\/__inkstone_native\s+/, '')
        const ctx = {
          isIdle: () => true,
          ui: { notify: (msg) => runtime.handleNotify(msg) },
          sessionManager: {
            getSessionId: () => 'sess-c2',
            getLeafId: () => leaf,
            resetLeaf: () => { leaf = null },
            branch: (id) => { leaf = id },
            appendCompaction: (summary, firstKeptEntryId, tokensBefore, details, fromHook) => {
              const id = `comp-${compactions.length + 1}`
              compactions.push({ id, summary, firstKeptEntryId, tokensBefore, details, fromHook })
              leaf = id
              return id
            }
          },
          navigateTree: async (targetId) => { leaf = targetId; return { cancelled: false } }
        }
        void handler(argText, ctx)
        return { success: true, data: { disposition: 'handled' } }
      }
    }, 5_000)
    try {
      runtime.handleNotify(bridgeMod.buildReceipt({ id: 'hello-c', op: 'hello', ok: true, result: { capabilities: ['append_antigravity_compaction'] } }))
      const saved = await runtime.appendAntigravityCompaction({
        sessionId: 'sess-c2',
        summary: '## Goal\n压缩摘要',
        firstKeptEntryId: 'u2',
        tokensBefore: 410_000,
        details: { antigravity: true, reason: 'manual' }
      })
      ok(saved.entryId === 'comp-1' && compactions.length === 1 && compactions[0].tokensBefore === 410_000 && compactions[0].fromHook === true, 'append_antigravity_compaction 写入 Pi 原生压缩条目并同步分支', JSON.stringify(saved))
    } finally {
      if (prevBridgeEnv === undefined) delete process.env.YAN_NATIVE_BRIDGE
      else process.env.YAN_NATIVE_BRIDGE = prevBridgeEnv
    }
  }

  {
    const { AgentController } = await compile('src/main/agent.ts', agentTestBuildOptions)
    const { AntigravitySubagentRpc } = await compile('src/main/antigravity-subagent-rpc.ts')
    const { session } = start()
    const models = await session.start(cwd, undefined, { mode: 'auto' })
    const pushed = []
    const saved = []
    const ctl = new AgentController({ cwd, push: (event) => pushed.push(event) })
    ctl.refreshState = async () => {}
    ctl.refreshStats = async () => {}
    ctl.maybeGenerateTitle = async () => {}
    ctl.confirmExecutionAdmission = () => true
    ctl.state = { sessionId: randomUUID(), cwd, isStreaming: false, autoCompactionEnabled: false }
    const connection = ctl.acpConnection = { sessionId: ctl.state.sessionId, model: { id: 'flash', name: 'Flash', provider: 'antigravity' }, thinking: models.thinking, mode: models.mode, modes: models.modes, session, hasContext: true }
    const native = ctl.nativeRuntime = {
      bridgeCapabilities: ['append_antigravity_turn', 'append_antigravity_compaction'],
      appendAntigravityTurn: async (turn) => { saved.push(turn); return { userId: 'eu-' + saved.length, assistantId: 'ea-' + saved.length } }
    }
    ctl.bindAntigravity(connection, session)
    const askReq = () => pushed.filter((event) => event.ch === 'ui-request').at(-1)?.payload
    const send = (text) => {
      ctl.startAntigravityTurn({ connection, session, native, owner: ctl.asyncOwner(), userText: text, prompt: text })
      return ctl.acpTurn
    }
    try {
      const t1 = send('ACP单选表单')
      const r1 = await wait(() => askReq())
      assert.equal(r1.method, 'select')
      assert.deepEqual(r1.options, ['选项 A', '选项 B', '选项 C', '选项 D'])
      await ctl.answerUiRemotely(r1.id, { value: '选项 C' })
      await t1.done
      await wait(() => saved.length === 1 && !ctl.acpTurn)
      assert.equal(saved[0].steps[0].text, '提问表单结果 · {"action":"accept","content":{"q0":"opt_c"}}')

      const t2 = send('ACP单选表单')
      const r2 = await wait(() => askReq()?.id !== r1.id ? askReq() : null)
      await ctl.answerUiRemotely(r2.id, { value: '自定义内容' })
      await t2.done
      await wait(() => saved.length === 2 && !ctl.acpTurn)
      assert.equal(saved[1].steps[0].text, '提问表单结果 · {"action":"accept","content":{"q0_other":"自定义内容"}}')

      const t3 = send('ACP多选表单')
      const r3 = await wait(() => askReq()?.id !== r2.id ? askReq() : null)
      assert.equal(r3.method, 'input')
      assert.equal(r3.form?.length, 3)
      assert.deepEqual(r3.form.map((f) => f.kind), ['multi', 'choice', 'choice'])
      await ctl.answerUiRemotely(r3.id, { value: JSON.stringify({ q_0: ['标签 1', '手写补充'], q_1: '同名 (2)', q_2: '是' }) })
      await t3.done
      await wait(() => saved.length === 3 && !ctl.acpTurn)
      assert.deepEqual(
        JSON.parse(saved[2].steps[0].text.replace(/^提问表单结果 · /, '')),
        { action: 'accept', content: { q0: ['m1'], q0_other: '手写补充', q1: 's2', q2: true } }
      )

      const t4 = send('ACP链接表单')
      await t4.done
      await wait(() => saved.length === 4 && !ctl.acpTurn)
      assert.equal(saved[3].steps[0].text, '提问表单结果 · {"action":"decline"}')

      const t5 = send('ACP单选表单')
      const r5 = await wait(() => askReq()?.id !== r3.id ? askReq() : null)
      await ctl.abort()
      await t5.done
      await wait(() => saved.length === 5 && !ctl.acpTurn)
      assert.equal(saved[4].status, 'aborted')
      assert.ok(pushed.some((event) => event.ch === 'ui-resolved' && event.payload?.id === r5.id))
      ok(true, 'ACP ask_question (elicitation/create) 适配单选、自定义写入、多选多题表单、不支持的 URL 拒绝及取消清理')
    } finally {
      await ctl.closeAntigravity()
    }

    const child = new AntigravitySubagentRpc(cwd, 'flash', async () => true, { launch: () => start().session })
    const childEvents = []
    child.on('event', (event) => childEvents.push(event))
    child.spawn()
    try {
      assert.equal((await child.command('get_state', undefined, { timeoutMs: 2500 })).success, true)
      await child.command('prompt', { message: 'ACP单选表单' })
      await wait(() => childEvents.some((e) => e.type === 'agent_settled'))
      const msg = childEvents.findLast((e) => e.type === 'message_end').message
      assert.ok(msg.content.some((b) => b.text === '提问表单结果 · {"action":"cancel"}'))
      ok(true, 'Antigravity 子代理自动取消 elicitation/create 不阻塞')
    } finally {
      await child.close()
    }
  }

  {
    const root = mkdtempSync(join(tmpdir(), 'inkstone-acp-mcp-refresh-'))
    const agentDir = join(root, 'pi-agent')
    const projectDir = join(root, 'project')
    const mcpServersPath = join(root, 'mcp-servers.json')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    const dynamicServerScript = join(root, 'dynamic-mcp.mjs')
    writeFileSync(dynamicServerScript, `
      import { createInterface } from 'node:readline'
      let connected = false
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
      for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        if (!line.trim()) continue
        const req = JSON.parse(line)
        if (req.method === 'initialize') {
          send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dynamic-colab', version: '1.0.0' } } })
        } else if (req.method === 'tools/list') {
          const tools = [
            { name: 'connect_browser', description: 'Connect', inputSchema: { type: 'object', properties: {} } },
            ...(connected ? [{ name: 'run_cell', description: 'Run cell', inputSchema: { type: 'object', properties: {} } }] : [])
          ]
          send({ jsonrpc: '2.0', id: req.id, result: { tools } })
        } else if (req.method === 'tools/call') {
          if (req.params?.name === 'connect_browser' && !connected) {
            connected = true
            send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} })
          }
          send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(process.pid) }] } })
        }
      }
    `, 'utf8')
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'dynamic-colab': { command: process.execPath, args: [dynamicServerScript] },
        'oauth-ignored': { url: 'https://example.com/mcp', oauth: { clientId: 'x' } }
      }
    }), 'utf8')

    const { McpConnectionManager } = await compile('src/main/mcp/connection-manager.ts', agentTestBuildOptions)
    const { antigravityMcpFingerprint, antigravityMcpServices, watchAntigravityMcpFiles } = await compile('src/main/antigravity-mcp.ts', agentTestBuildOptions)
    const { openAntigravityDelegation } = await compile('src/main/antigravity-delegation.ts', agentTestBuildOptions)

    const fpInitial = await antigravityMcpFingerprint({ agentDir, cwd: projectDir, trusted: false, hostConfigs: [] })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'dynamic-colab': { command: process.execPath, args: [dynamicServerScript], toolExposure: { run_cell: 'hidden' } },
        'oauth-ignored': { url: 'https://example.com/mcp', oauth: { clientId: 'y' } }
      }
    }), 'utf8')
    const fpHidden = await antigravityMcpFingerprint({ agentDir, cwd: projectDir, trusted: false, hostConfigs: [] })
    assert.notEqual(fpHidden, fpInitial, 'toolExposure 变更会改变 Antigravity MCP 指纹')
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'dynamic-colab': { command: process.execPath, args: [dynamicServerScript] },
        'oauth-ignored': { url: 'https://example.com/mcp', oauth: { clientId: 'z' } }
      }
    }), 'utf8')
    assert.equal(await antigravityMcpFingerprint({ agentDir, cwd: projectDir, trusted: false, hostConfigs: [] }), fpInitial, '未挂载的 oauth 条目变化不会误触发刷新')

    const hostMgr = new McpConnectionManager([])
    const nativeMgr = new McpConnectionManager([])
    const listChangedEvents = []
    let watchHits = 0
    const watcher = watchAntigravityMcpFiles([join(agentDir, 'mcp.json'), join(projectDir, '.pi', 'mcp.json'), mcpServersPath], () => { watchHits++ })
    try {
      mkdirSync(join(projectDir, '.pi'), { recursive: true })
      writeFileSync(join(projectDir, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { 'proj-only': { url: 'https://proj.example/mcp' } } }), 'utf8')
      await wait(() => watchHits >= 1, 2500)
      const fpUntrusted = await antigravityMcpFingerprint({ agentDir, cwd: projectDir, trusted: false, hostConfigs: [] })
      const fpTrusted = await antigravityMcpFingerprint({ agentDir, cwd: projectDir, trusted: true, hostConfigs: [] })
      assert.equal(fpUntrusted, fpInitial)
      assert.notEqual(fpTrusted, fpInitial)
      rmSync(join(projectDir, '.pi'), { recursive: true, force: true })

      const firstMcp = await antigravityMcpServices({
        agentDir,
        cwd: projectDir,
        trusted: false,
        host: hostMgr,
        native: nativeMgr,
        onToolsListChanged: (id) => listChangedEvents.push(id)
      })
      const commandHost = {
        cwd: () => projectDir,
        mcpConnectionManager: () => hostMgr,
        mcpConfigError: () => undefined,
        permissionMode: async () => 'all',
        confirmDanger: async () => ({ decision: 'allow', choice: 'once' }),
        approvalOwner: () => ({})
      }
      const controller = new AbortController()
      const bridge1 = await openAntigravityDelegation(
        resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
        () => ({ signal: controller.signal, mode: 'auto' }),
        { delegate: false, services: firstMcp.services, commandHost }
      )
      const callBridge = async (cfg, method, params) => {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: { Authorization: cfg.headers[0].value, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
        return (await res.json()).result
      }
      try {
        const colabHttp1 = bridge1.httpConfigs.find((c) => c.name === 'dynamic-colab')
        const list1 = await callBridge(colabHttp1, 'tools/list', {})
        assert.deepEqual(list1.tools.map((t) => t.name), ['connect_browser'])
        const call1 = await callBridge(colabHttp1, 'tools/call', { name: 'connect_browser', arguments: {} })
        const pid1 = call1.content[0].text
        await wait(() => listChangedEvents.includes('dynamic-colab'))

        await bridge1.close()
        await firstMcp.close()

        const secondMcp = await antigravityMcpServices({
          agentDir,
          cwd: projectDir,
          trusted: false,
          host: hostMgr,
          native: nativeMgr,
          onToolsListChanged: (id) => listChangedEvents.push(id)
        })
        const bridge2 = await openAntigravityDelegation(
          resolve('resources/pi-extensions/antigravity-pi-mcp.mjs'),
          () => ({ signal: controller.signal, mode: 'auto' }),
          { delegate: false, services: secondMcp.services, commandHost }
        )
        try {
          const colabHttp2 = bridge2.httpConfigs.find((c) => c.name === 'dynamic-colab')
          const list2 = await callBridge(colabHttp2, 'tools/list', {})
          assert.deepEqual(list2.tools.map((t) => t.name), ['connect_browser', 'run_cell'])
          const call2 = await callBridge(colabHttp2, 'tools/call', { name: 'connect_browser', arguments: {} })
          assert.equal(call2.content[0].text, pid1, 'Antigravity 重连刷新工具列表时保留原 MCP 进程状态（PID 不变）')
        } finally {
          await bridge2.close()
          await secondMcp.close()
        }
        ok(true, 'tools/list_changed 通知可穿透到 Antigravity 服务桥并保留存活的 stdio MCP 连接')
      } finally {
        await bridge1.close().catch(() => undefined)
        await firstMcp.close().catch(() => undefined)
      }
    } finally {
      watcher.close()
      await hostMgr.close()
      await nativeMgr.close()
    }

    const prevEnv = { YAN_DATA_DIR: process.env.YAN_DATA_DIR, YAN_PI_DIR: process.env.YAN_PI_DIR, YAN_MCP_SERVERS_FILE: process.env.YAN_MCP_SERVERS_FILE }
    process.env.YAN_DATA_DIR = join(root, 'yan-data')
    process.env.YAN_PI_DIR = agentDir
    process.env.YAN_MCP_SERVERS_FILE = mcpServersPath
    writeFileSync(mcpServersPath, '[]', 'utf8')
    try {
      const { AgentController } = await compile('src/main/agent.ts', agentTestBuildOptions)
      const ctl = new AgentController({ cwd: projectDir, push: () => {} })
      ctl.refreshState = async () => {}
      ctl.refreshStats = async () => {}
      ctl.maybeGenerateTitle = async () => {}
      ctl.confirmExecutionAdmission = () => true
      ctl.state = { sessionId: randomUUID(), cwd: projectDir, isStreaming: false, autoCompactionEnabled: false }
      ctl.nativeRuntime = {
        bridgeCapabilities: ['append_antigravity_turn', 'append_antigravity_compaction'],
        appendAntigravityTurn: async () => ({ userId: 'u-1', assistantId: 'a-1' })
      }
      let selects = 0
      const liveSession = start().session
      await liveSession.start(projectDir, undefined, { mode: 'auto' })
      ctl.acpConnection = {
        sessionId: ctl.state.sessionId,
        model: { id: 'flash', name: 'Flash', provider: 'antigravity' },
        mode: 'auto',
        mcpFingerprint: await ctl.currentAntigravityMcpFingerprint(),
        session: liveSession,
        hasContext: true
      }
      ctl.selectAntigravity = async () => {
        selects++
        ctl.acpConnection.mcpStale = false
        ctl.acpConnection.mcpToolsStale = false
        ctl.acpConnection.mcpFingerprint = await ctl.currentAntigravityMcpFingerprint()
        return { ok: true }
      }
      try {
        await ctl.reloadMcpServers()
        await wait(() => ctl.acpConnection.mcpStale === false)
        assert.equal(selects, 0, '配置未实质变化时不误重连')

        writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
          mcpServers: {
            'dynamic-colab': { command: process.execPath, args: [dynamicServerScript] },
            'extra-srv': { url: 'https://extra.example/mcp' }
          }
        }), 'utf8')
        await ctl.reloadMcpServers()
        assert.equal(ctl.acpConnection.mcpStale, true)
        await wait(() => selects === 1 && ctl.acpConnection.mcpStale === false)

        writeFileSync(mcpServersPath, JSON.stringify([{ id: 'windows-mcp', transport: 'stdio', command: 'uvx', args: [] }]), 'utf8')
        assert.equal((await ctl.sendAntigravity('使用 windows-mcp')).ok, true)
        await ctl.acpTurn?.done
        assert.equal(selects, 2, 'sendAntigravity 在发送前检测配置指纹漂移并自动重连刷新 MCP')

        ctl.markAntigravityMcpChanged('tools')
        await wait(() => selects === 3 && ctl.acpConnection.mcpStale === false)
        assert.equal((await ctl.reloadAntigravityMcp()).ok, true)
        assert.equal(selects, 4)

        const { registerCapabilitiesIpc } = await compile('src/main/ipc/capabilities-ipc.ts', {
          external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
          plugins: [{
            name: 'caps-ipc-electron',
            setup(builder) {
              builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'caps-electron' }))
              builder.onLoad({ filter: /.*/, namespace: 'caps-electron' }, () => ({
                contents: `
                  export const shell = { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} }
                  export const app = { getLocale: () => 'zh-CN', getPath: () => ${JSON.stringify(join(root, 'yan-data'))} }
                `
              }))
            }
          }]
        })
        const ipcHandlers = new Map()
        let ipcReloadCalls = 0
        let ipcAcpReloadCalls = 0
        let ipcNativeReloadCalls = 0
        const fakeIpcAgent = {
          capabilityProjectId: null,
          getState: () => ({ sessionId: ctl.state.sessionId, isAgentRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }),
          hasRunningBash: () => false,
          getPendingUiCount: () => 0,
          nativeBootWitness: () => null,
          reloadMcpServers: async () => { ipcReloadCalls++ },
          nativeReload: async () => { ipcNativeReloadCalls++ },
          reloadAntigravityMcp: async () => { ipcAcpReloadCalls++; return { ok: true } },
          listCommands: async () => []
        }
        registerCapabilitiesIpc({ handle: (name, fn) => ipcHandlers.set(name, fn) }, {
          currentAgent: () => fakeIpcAgent,
          registry: () => ({
            activeRunner: () => ({ id: 'r-1', cwd: projectDir }),
            runtimeOf: () => ({ generation: 1 }),
            agents: () => [fakeIpcAgent],
            reloadMcpServers: async () => { ipcReloadCalls++ }
          }),
          thinExtensionPaths: () => [],
          settings: async () => ({ projects: [] }),
          isProjectTrusted: async () => false
        })
        const snap = await ipcHandlers.get('yan:capabilities:mcpServices')()
        const changed = await ipcHandlers.get('yan:capabilities:changeMcpService')({
          context: snap.context,
          revision: snap.revision,
          scope: 'global',
          action: 'add',
          name: 'added-via-ui',
          owner: 'pi',
          config: { url: 'https://added.example/mcp' }
        })
        assert.equal(changed.ok, true)
        await wait(() => ipcReloadCalls === 1)
        const applied = await ipcHandlers.get('yan:capabilities:applyMcpServices')({
          context: snap.context,
          expectedSessionId: ctl.state.sessionId
        })
        assert.equal(applied.ok, true)
        assert.equal(ipcReloadCalls, 2)
        assert.equal(ipcNativeReloadCalls, 1)
        assert.equal(ipcAcpReloadCalls, 1)
        ok(true, 'AgentController 与 capabilities-ipc 支持空闲自动刷新、发送前指纹兜底刷新及应用到当前会话')
      } finally {
        await ctl.closeAntigravity()
      }
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
})
