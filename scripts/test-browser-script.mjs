#!/usr/bin/env node
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
const { runBrowserScript, SCRIPT_GUIDE } = await import(pathToFileURL(outfile).href)
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
  const observation = () => ({
    generationId: 'g:0', url: state.url, title: state.title, text,
    elements: [
      { ref: 'g:0:e1', role: 'textbox', name: 'Customer name', box: [0, 0, 1, 1] },
      { ref: 'g:0:e2', role: 'button', name: 'Submit order', box: [0, 0, 1, 1] }
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
      type: async (ref, value, options) => { calls.push(['type', ref, value, options]); return ok({ receipt: { value } }) },
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
  for (const name of ['page.goto', 'page.find', 'page.fill', 'page.waitFor', 'task.newPage']) assert.ok(SCRIPT_GUIDE.includes(name), name)
  assert.ok(!/Space|ego/i.test(SCRIPT_GUIDE))
})

console.log(`\n${pass} 项通过`)
