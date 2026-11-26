#!/usr/bin/env node
import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-browser-script-'))
const outfile = join(dir, 'script-runner.mjs')
await build({ entryPoints: [join(ROOT, 'src/main/browser/script-runner.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { runBrowserScript, SCRIPT_GUIDE, disposeScriptRuntimes, scriptRuntimeCount, isLocalPageUrl, localEvaluateExpression } = await import(pathToFileURL(outfile).href)
const vm = await import('node:vm')
await rm(dir, { recursive: true, force: true })

let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

function fakeBrowser() {
  const calls = []
  const state = { url: 'about:blank', title: '', activeTabId: 't1', tabs: [{ id: 't1', url: 'about:blank', title: '' }] }
  let text = ''
  let typed = ''
  const observation = () => ({
    generationId: 'g:0', url: state.url, title: state.title, text,
    elements: [
      { ref: 'g:0:e1', role: 'textbox', name: 'Customer name', box: [0, 0, 1, 1], ...(typed ? { value: typed } : {}) },
      { ref: 'g:0:e2', role: 'button', name: 'Submit order', box: [0, 0, 1, 1] },
      ...(state.links ? [
        { ref: 'g:0:e3', role: 'link', name: 'checks', href: '/o/r/actions/workflows/check.yml', box: [0, 0, 1, 1] },
        { ref: 'g:0:e4', role: 'link', name: 'checks', href: '/o/r/actions/runs/5/job/7', box: [0, 0, 1, 1] }
      ] : [])
    ],
    accessibilityNodeCount: 2
  })
  const ok = (extra = {}) => ({ ok: true, observation: observation(), ...extra })
  return {
    calls,
    setText: (value) => { text = value },
    browser: {
      navigate: async (url) => { calls.push(['navigate', url]); state.url = url; state.title = 'Example'; return { ok: true } },
      observe: async () => { calls.push(['observe']); return observation() },
      click: async (ref, options) => {
        calls.push(['click', ref, options])
        if (ref === 'missing') return { ok: false, code: 'STALE_ELEMENT', error: '元素引用已失效' }
        return ok({ receipt: options?.dialog ? { dialogs: [{ type: 'confirm', message: 'sure?', accepted: options.dialog === 'accept' }] } : {} })
      },
      type: async (ref, value, options) => { calls.push(['type', ref, value, options]); typed = value; return ok({ receipt: { value } }) },
      select: async (ref, value) => { calls.push(['select', ref, value]); return ok() },
      press: async (key, options) => { calls.push(['press', key, options]); return ok() },
      scroll: async (dx, dy) => { calls.push(['scroll', dx, dy]); return ok({ receipt: { scroll: { x: 0, y: dy, maxY: 5000 } } }) },
      back: async () => ({ ok: true }),
      forward: async () => ({ ok: true }),
      reload: async () => ({ ok: true }),
      state: () => state,
      newTab: async (url) => { calls.push(['newTab', url]); state.tabs.push({ id: 't2', url: url ?? 'about:blank', title: '' }); state.activeTabId = 't2'; state.url = url ?? 'about:blank'; return state },
      switchTab: async (id) => { calls.push(['switchTab', id]); state.activeTabId = id; return state },
      closeTab: async (id) => { calls.push(['closeTab', id]); return state }
    }
  }
}

await check('脚本：await 页面动作，return 值与 console.log 都带回', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript("await page.goto('https://example.com'); console.log('标题', await page.title()); return { title: page.title(), n: 2 }", fake.browser)
  assert.deepEqual(out.result, { title: 'Example', n: 2 })
  assert.deepEqual(out.logs, ['标题 Example'])
  assert.equal(out.url, 'https://example.com')
})

await check('脚本：find 按名称找 ref，fill / click 走宿主动作，弹窗选项原样传递', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript(`
    const name = await page.find({ name: 'customer' })
    const filled = await page.fill(name, 'Test User')
    const clicked = await page.click(await page.find({ name: 'Submit order', exact: true }), { dialog: 'accept' })
    return { name, value: filled.receipt.value, dialogs: clicked.receipt.dialogs }
  `, fake.browser)
  assert.equal(out.result.name, 'g:0:e1')
  assert.equal(out.result.value, 'Test User')
  assert.deepEqual(out.result.dialogs, [{ type: 'confirm', message: 'sure?', accepted: true }])
  assert.deepEqual(fake.calls.find((c) => c[0] === 'click'), ['click', 'g:0:e2', { dialog: 'accept' }])
})

await check('脚本：动作失败抛出带错误码的异常，脚本可以捕获', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript("try { await page.click('missing') } catch (e) { return e.message }", fake.browser)
  assert.match(out.result, /^STALE_ELEMENT: /)
  await assert.rejects(runBrowserScript("await page.click('missing')", fake.browser), (error) => error.code === 'STALE_ELEMENT')
})

await check('脚本：沙箱里没有 require / process / fetch', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript('return [typeof require, typeof process, typeof fetch, typeof page, typeof task, typeof sleep]', fake.browser)
  assert.deepEqual(out.result, ['undefined', 'undefined', 'undefined', 'object', 'object', 'function'])
})

await check('脚本：拿不到宿主 process，也拿不到 API 的内部通道', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript(`return [
    page.url.constructor('return typeof process')(),
    page.goto.constructor('return typeof require')(),
    sleep.constructor('return typeof process')(),
    console.log.constructor('return typeof process')(),
    this === undefined ? 'strict' : this.constructor.constructor('return typeof process')(),
    Object.keys(globalThis).sort().join()
  ]`, fake.browser)
  assert.deepEqual(out.result.slice(0, 4), ['undefined', 'undefined', 'undefined', 'undefined'])
  assert.notEqual(out.result[4], 'object')
  assert.equal(out.result[5], 'console,page,sleep,task')
})

await check('脚本：进程环境里没有密钥，文件和子进程被拒绝', async () => {
  const fake = fakeBrowser()
  process.env.YAN_TEST_SECRET_FOR_SCRIPT = 'must-not-leak'
  const { spawnSync } = await import('node:child_process')
  const probe = `
    const report = { secret: process.env.YAN_TEST_SECRET_FOR_SCRIPT ?? null }
    try { require('node:fs').readFileSync(process.execPath); report.read = 'allowed' } catch (e) { report.read = e.code }
    try { require('node:child_process').spawnSync(process.execPath, ['-v']); report.spawn = 'allowed' } catch (e) { report.spawn = e.code }
    console.log(JSON.stringify(report))`
  const res = spawnSync(process.execPath, ['--permission', '-e', probe], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot } })
  assert.deepEqual(JSON.parse(res.stdout), { secret: null, read: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED' })
  delete process.env.YAN_TEST_SECRET_FOR_SCRIPT
  assert.ok(typeof fake.browser.state === 'function')
})

await check('脚本：await 之后的死循环不冻住主进程，超时后被杀掉', async () => {
  const fake = fakeBrowser()
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 20)
  const started = Date.now()
  await assert.rejects(
    runBrowserScript('await sleep(1); while (true) {}', fake.browser, { timeoutMs: 800 }),
    (error) => error.code === 'script_timeout'
  )
  clearInterval(timer)
  assert.ok(Date.now() - started < 5000, '超时按时生效')
  assert.ok(ticks >= 10, `主线程事件循环没有被卡住：${ticks}`)
})

await check('脚本：不 await 的失败动作和抛出普通异常都不会弄坏运行器', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript("page.click('missing'); await sleep(50); return 'ok'", fake.browser)
  assert.equal(out.result, 'ok')
  await assert.rejects(runBrowserScript("throw new Error('boom')", fake.browser), (error) => error.code === 'script_error' && /boom/.test(error.message))
})

await check('脚本：sleep 之后 page.url 读到最新地址，日志有上限', async () => {
  const fake = fakeBrowser()
  setTimeout(() => { fake.browser.state().url = 'https://later.example/' }, 400)
  const out = await runBrowserScript("for (let i = 0; i < 500; i++) console.log('line', i); await sleep(900); return page.url()", fake.browser)
  assert.equal(out.result, 'https://later.example/')
  assert.equal(out.logs.length, 200)
})

await check('脚本：超时后报 script_timeout，之后的动作不再执行', async () => {
  const fake = fakeBrowser()
  await assert.rejects(
    runBrowserScript("await sleep(200); await page.press('Enter')", fake.browser, { timeoutMs: 50 }),
    (error) => error.code === 'script_timeout'
  )
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(fake.calls.some((c) => c[0] === 'press'), false)
})

await check('脚本：取消信号立即结束，语法错误报 script_error', async () => {
  const fake = fakeBrowser()
  const controller = new AbortController()
  const running = runBrowserScript('await sleep(1000)', fake.browser, { signal: controller.signal })
  controller.abort()
  await assert.rejects(running, (error) => error.code === 'script_aborted')
  await assert.rejects(runBrowserScript('return (', fake.browser), (error) => error.code === 'script_error')
})

await check('脚本：waitFor 轮询观察直到文本出现，scroll 返回位置，task 管理标签', async () => {
  const fake = fakeBrowser()
  setTimeout(() => fake.setText('Hello World!'), 300)
  const out = await runBrowserScript(`
    await page.waitFor({ text: 'Hello World!', timeout: 3000 })
    const pos = await page.scroll(800)
    const opened = await task.newPage('https://example.org')
    return { pos, opened, pages: task.pages().length }
  `, fake.browser)
  assert.deepEqual(out.result.pos, { x: 0, y: 800, maxY: 5000 })
  assert.deepEqual(out.result.opened, { id: 't2', url: 'https://example.org' })
  assert.equal(out.result.pages, 2)
})

await check('脚本：接口说明列出 page / task 方法且不提 ego Space', async () => {
  for (const name of ['page.goto', 'page.find', 'page.snapshot', 'page.text', 'page.fill', 'page.waitFor', 'task.newPage', 'globalThis', '--code -']) assert.ok(SCRIPT_GUIDE.includes(name), name)
  assert.ok(!/Space|ego/i.test(SCRIPT_GUIDE))
})

await check('脚本：find 支持文字、正则与角色，text 支持分段与查找，snapshot 返回短行', async () => {
  const fake = fakeBrowser()
  fake.setText('Order 42 shipped\nOrder 43 pending')
  const out = await runBrowserScript(`
    return {
      byText: await page.find('submit'),
      byRegex: await page.find(/^customer/i),
      byRole: (await page.findAll({ role: 'button' })).map((e) => e.ref),
      missing: await page.find({ regex: 'nothing-here' }),
      slice: await page.text({ offset: 6, maxChars: 2 }),
      orders: (await page.text({ find: /Order (\\d+)/ })).map((m) => m.offset),
      snap: await page.snapshot()
    }
  `, fake.browser)
  assert.equal(out.result.byText, 'g:0:e2')
  assert.equal(out.result.byRegex, 'g:0:e1')
  assert.deepEqual(out.result.byRole, ['g:0:e2'])
  assert.equal(out.result.missing, null)
  assert.equal(out.result.slice, '42')
  assert.deepEqual(out.result.orders, [0, 17])
  assert.match(out.result.snap, /^url: about:blank\ntitle: \ng:0:e1 textbox "Customer name"\ng:0:e2 button "Submit order"$/)
})

await check('脚本：动作目标可直接写查询，唯一才动作，多个或没有匹配时报错', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript(`
    await page.click({ role: 'button', name: 'submit' })
    await page.fill(/customer/i, 'Ann')
    const errors = []
    try { await page.click(/e/i) } catch (e) { errors.push(e.code) }
    try { await page.click({ name: 'nope' }) } catch (e) { errors.push(e.code) }
    return errors
  `, fake.browser)
  assert.deepEqual(out.result, ['AMBIGUOUS_TARGET', 'TARGET_NOT_FOUND'])
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'click' || c[0] === 'type').map((c) => c[1]), ['g:0:e2', 'g:0:e1'])
})

await check('脚本：同名链接按 href 区分，name 可写正则，写错字段报 INVALID_QUERY', async () => {
  const fake = fakeBrowser()
  fake.browser.state().links = true
  const out = await runBrowserScript(`
    await page.click({ role: 'link', href: '/job/' })
    const errors = []
    try { await page.click({ role: 'link', name: 'checks' }) } catch (e) { errors.push(e.code, /→ \\/o\\/r\\/actions\\/runs/.test(e.message)) }
    return {
      byRegexName: (await page.findAll({ role: 'link', name: /^checks$/ })).length,
      byRegexHref: await page.find({ href: /workflows\\/check/ }),
      nameRegexNoMatch: await page.find({ name: /^nothing$/ }),
      errors,
      invalid: await page.find({ title: 'x' }).catch((e) => e.code),
      roleRegex: await page.find({ role: /link/ }).catch((e) => e.code)
    }
  `, fake.browser)
  assert.equal(fake.calls.find((c) => c[0] === 'click')[1], 'g:0:e4')
  assert.deepEqual(out.result.errors, ['AMBIGUOUS_TARGET', true])
  assert.equal(out.result.byRegexName, 2)
  assert.equal(out.result.byRegexHref, 'g:0:e3')
  assert.equal(out.result.nameRegexNoMatch, null)
  assert.equal(out.result.invalid, 'INVALID_QUERY')
  assert.equal(out.result.roleRegex, 'INVALID_QUERY')
})

await check('脚本：动作结果带变化摘要', async () => {
  const fake = fakeBrowser()
  const out = await runBrowserScript("await page.snapshot(); const r = await page.fill(await page.find('customer'), 'Ann'); return r.changes", fake.browser)
  assert.deepEqual(out.result, ['~ g:0:e1 textbox "Customer name" ="Ann"'])
})

await check('脚本：同一会话同一代次内 globalThis 变量保留，换代次后清空', async () => {
  const fake = fakeBrowser()
  let scope = 'tab-1:gen-0'
  const browser = { ...fake.browser, scope: () => scope }
  const first = await runBrowserScript('globalThis.rows = [1, 2]; counter = 1; return typeof rows', browser, { persistKey: 'session-a' })
  assert.equal(first.runtime, 'new')
  assert.equal(scriptRuntimeCount(), 1)
  const second = await runBrowserScript('counter += 1; return { rows: globalThis.rows, counter }', browser, { persistKey: 'session-a' })
  assert.equal(second.runtime, 'kept')
  assert.deepEqual(second.result, { rows: [1, 2], counter: 2 })
  const other = await runBrowserScript('return typeof globalThis.rows', browser, { persistKey: 'session-b' })
  assert.equal(other.result, 'undefined', '另一个会话看不到这些变量')
  scope = 'tab-1:gen-1'
  const third = await runBrowserScript('return typeof globalThis.rows', browser, { persistKey: 'session-a' })
  assert.equal(third.runtime, 'new')
  assert.equal(third.result, 'undefined')
  disposeScriptRuntimes()
  assert.equal(scriptRuntimeCount(), 0)
})

await check('脚本：上一次运行没 await 的动作不会在下一次运行里继续执行', async () => {
  const fake = fakeBrowser()
  const browser = { ...fake.browser, scope: () => 'same' }
  await runBrowserScript("(async () => { await sleep(300); await page.press('Enter') })(); return 'started'", browser, { persistKey: 'session-c' })
  const out = await runBrowserScript('await sleep(600); return 1', browser, { persistKey: 'session-c' })
  assert.equal(out.runtime, 'kept')
  assert.equal(fake.calls.some((c) => c[0] === 'press'), false)
  disposeScriptRuntimes()
})

await check('脚本：常驻运行时最多保留 4 个，按最近使用淘汰，可按会话回收', async () => {
  const fake = fakeBrowser()
  const browser = { ...fake.browser, scope: () => 'same' }
  for (const key of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) await runBrowserScript('globalThis.v = 1; return 1', browser, { persistKey: key })
  assert.equal(scriptRuntimeCount(), 4)
  assert.equal((await runBrowserScript('return typeof globalThis.v', browser, { persistKey: 'k1' })).runtime, 'new', '最早的被淘汰')
  assert.equal((await runBrowserScript('return typeof globalThis.v', browser, { persistKey: 'k6' })).runtime, 'kept')
  disposeScriptRuntimes('k6')
  assert.equal(scriptRuntimeCount(), 3)
  assert.equal((await runBrowserScript('return typeof globalThis.v', browser, { persistKey: 'k6' })).result, 'undefined', '按 key 回收后变量不再存在')
  disposeScriptRuntimes()
})

await check('脚本：复用前做就绪探测，卡死的常驻进程不复用', async () => {
  const fake = fakeBrowser()
  const browser = { ...fake.browser, scope: () => 'same' }
  const first = await runBrowserScript('const spin = async () => { for (let i = 0; i < 50; i++) await null; while (true) {} }; spin(); return 1', browser, { persistKey: 'stuck', timeoutMs: 5000 })
  assert.equal(first.result, 1)
  const started = Date.now()
  const second = await runBrowserScript('return 2', browser, { persistKey: 'stuck', timeoutMs: 5000 })
  assert.equal(second.result, 2)
  assert.equal(second.runtime, 'new')
  assert.ok(Date.now() - started < 4000, `探测失败后很快重开：${Date.now() - started}ms`)
  disposeScriptRuntimes()
})

await check('脚本：宿主动作在指定的会话上下文里执行', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage()
  const fake = fakeBrowser()
  const seen = []
  const browser = { ...fake.browser, scope: () => 'same', navigate: async (url) => { seen.push(als.getStore()); return fake.browser.navigate(url) } }
  await runBrowserScript("await page.goto('https://a.example')", browser, { persistKey: 'scoped', withSession: (work) => als.run('session-x', work) })
  await runBrowserScript("await page.goto('https://b.example')", browser, { persistKey: 'scoped', withSession: (work) => als.run('session-x', work) })
  assert.deepEqual(seen, ['session-x', 'session-x'])
  disposeScriptRuntimes()
})

await check('脚本：超时后常驻运行时被杀掉，下一次重新开始', async () => {
  const fake = fakeBrowser()
  const browser = { ...fake.browser, scope: () => 'same' }
  await runBrowserScript('globalThis.kept = 1; return 1', browser, { persistKey: 'session-d' })
  await assert.rejects(runBrowserScript('await sleep(1); while (true) {}', browser, { persistKey: 'session-d', timeoutMs: 500 }), (error) => error.code === 'script_timeout')
  const out = await runBrowserScript('return typeof globalThis.kept', browser, { persistKey: 'session-d' })
  assert.equal(out.runtime, 'new')
  assert.equal(out.result, 'undefined')
  disposeScriptRuntimes()
})

await check('page.evaluate：只认 http(s) 的 localhost、127.0.0.1、[::1]', async () => {
  for (const url of ['http://127.0.0.1:8188/', 'https://localhost/x', 'http://[::1]:3000/']) assert.equal(isLocalPageUrl(url), true, url)
  for (const url of ['https://example.com/', 'http://127.0.0.1.nip.io/', 'http://localhost.evil.com/', 'http://192.168.1.2/', 'file:///C:/a.html', 'about:blank', 'data:text/html,x', '']) assert.equal(isLocalPageUrl(url), false, url)
})

await check('page.evaluate：页面里的守卫按 location 严格判断，篡改原型也绕不过', async () => {
  const run = async (href, poison = false) => {
    const url = new URL(href)
    const context = vm.createContext({ location: Object.freeze({ protocol: url.protocol, hostname: url.hostname, href: url.href }), app: { graphToPrompt: async () => ({ output: { 1: 'ok' } }) } })
    if (poison) vm.runInContext("String.prototype.toLowerCase = () => 'localhost'; String.prototype.endsWith = () => true; Set.prototype.has = () => true; RegExp.prototype.test = () => true", context)
    return JSON.parse(JSON.stringify(await vm.runInContext(localEvaluateExpression('(() => app.graphToPrompt())()'), context)))
  }
  assert.deepEqual(await run('http://127.0.0.1:8188/'), { denied: false, value: { output: { 1: 'ok' } } })
  assert.deepEqual(await run('https://example.com/', true), { denied: true, url: 'https://example.com/' })
  assert.equal((await run('http://localhost.evil.com/', true)).denied, true)
  const thrown = vm.runInContext(localEvaluateExpression('(() => { throw new Error("boom") })()'), vm.createContext({ location: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/' } }))
  await assert.rejects(thrown, /boom/)
})

await check('page.evaluate：函数按源码和参数送到宿主，非本机页面在调用前就拒绝', async () => {
  const fake = fakeBrowser()
  const seen = []
  const browser = { ...fake.browser, evaluate: async (expression) => { seen.push(expression); return { nodes: 12 } } }
  await assert.rejects(runBrowserScript('return await page.evaluate(() => 1)', browser), (error) => error.code === 'EVALUATE_NOT_LOCAL')
  assert.equal(seen.length, 0)
  await runBrowserScript("await page.goto('http://127.0.0.1:8188/')", browser)
  const out = await runBrowserScript("return await page.evaluate((n) => app.graph(n), { depth: 2 })", browser)
  assert.deepEqual(out.result, { nodes: 12 })
  assert.equal(seen[0], '((n) => app.graph(n))({"depth":2})')
  await runBrowserScript("return await page.evaluate('document.title')", browser)
  assert.equal(seen[1], 'document.title')
  await assert.rejects(runBrowserScript('return await page.evaluate(42)', browser), (error) => error.code === 'EVALUATE_INVALID')
  await assert.rejects(runBrowserScript('return await page.evaluate(() => 1)', { ...fake.browser }), (error) => error.code === 'EVALUATE_UNSUPPORTED')
  assert.ok(SCRIPT_GUIDE.includes('page.evaluate'))
  disposeScriptRuntimes()
})

console.log(`\n${pass} 项通过`)
