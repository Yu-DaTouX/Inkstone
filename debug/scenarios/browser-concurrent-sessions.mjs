import { createServer } from 'node:http'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommands, readOut } from './browser-agent-control.mjs'

export const meta = { description: '两个会话同时用内置浏览器：A、B 并发打开、点击、下载，脚本时间段重叠且没有 waiting_resource；下载回执与 download --wait 各归各；A 交给用户时 B 照常操作，A 改页面被拒，交还后恢复；不调用真实模型' }

function fixture() {
  return createServer((req, res) => {
    const tag = /^\/(a|b)\b/.exec(req.url ?? '')?.[1] ?? 'x'
    if ((req.url ?? '').includes('/dl')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="report-${tag}.bin"` })
      res.end(Buffer.alloc(2048, tag))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>page-${tag}</title><body style="font:20px sans-serif"><h1>page-${tag}</h1><a href="/${tag}/dl">Download ${tag.toUpperCase()}</a> <button onclick="document.getElementById('s').textContent='clicked-${tag}'">Press ${tag.toUpperCase()}</button><p id="s"></p></body>`)
  })
}

const script = (tag, holdMs, out = tag) => `yan browser run --code - > ba/${out}-run.json 2>&1 <<'JS'
const t0 = Date.now()
const pressed = await page.click({ role: 'button', name: 'Press ${tag.toUpperCase()}' })
const dl = await page.click({ name: 'Download ${tag.toUpperCase()}' })
await sleep(${holdMs})
return { t0, t1: Date.now(), pressed: pressed.changes, download: dl.receipt.downloadStarted ?? null }
JS`

export default async function run(ctx) {
  const { cdp, box, check, log, newSession, turn, waitFor, sleep, shot } = ctx
  const ev = (expr) => cdp.evaluate(expr)
  const server = fixture()
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const base = `http://127.0.0.1:${port}`
  const parse = (name) => {
    const out = readOut(ctx, name).json
    try { return { out, result: JSON.parse(out?.summary?.result ?? 'null') } } catch { return { out, result: null } }
  }
  const sid = () => ev(`window.__yanStore.getState().session?.sessionId ?? null`)
  const file = () => ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
  const browserOf = (id) => ev(`window.yan.browser.getState(${JSON.stringify(id)}).then((st) => ({ open: st.open, url: st.url, userControl: !!st.userControl, reason: st.userControlRequest?.reason ?? '', tabs: st.tabs.map((t) => t.url), ids: st.tabs.map((t) => t.id), active: st.activeTabId ?? null }))`)
  const running = '!!(s.session?.isStreaming || s.session?.isAgentRunning)'
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true, permissionMode: 'all' })`)

    await newSession(box.project)
    await turn('先落盘 A')
    const a = await sid()
    const aFile = await file()
    await newSession(box.project)
    await turn('先落盘 B')
    const b = await sid()
    const bFile = await file()
    check('A、B 是两个会话', a && b && a !== b, { a, b })

    const commandsFor = (tag) => [
      `yan browser open --url ${base}/${tag} > ba/${tag}-open.json 2>&1`,
      script(tag, 6000),
      `yan browser download --wait --timeout 15000 > ba/${tag}-download.json 2>&1`,
      `yan browser state > ba/${tag}-state.json 2>&1`
    ]
    mkdirSync(join(box.project, 'ba'), { recursive: true })
    const listFile = (tag) => {
      const path = join(box.project, 'ba', `${tag}-cmds.json`).replace(/\\/g, '/')
      writeFileSync(path, JSON.stringify(commandsFor(tag)))
      return path
    }
    const aList = listFile('a')
    const bList = listFile('b')

    await ev(`window.__yanStore.getState().send(${JSON.stringify(`CMDFILE=${bList}`)})`)
    await waitFor(running, 20000, 50)
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(aFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(a)} && !s.switchLoading`, 15000)
    await ev(`window.__yanStore.getState().send(${JSON.stringify(`CMDFILE=${aList}`)})`)
    await waitFor(running, 20000, 50)
    await waitFor(`!(${running})`, 180000, 200)
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(bFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(b)} && !s.switchLoading`, 15000)
    await waitFor(`!(${running})`, 180000, 200)
    await sleep(800)

    const runA = parse('a-run.json')
    const runB = parse('b-run.json')
    log('run', { a: runA.result, b: runB.result, aCode: runA.out?.code, bCode: runB.out?.code })
    const overlap = runA.result && runB.result && runA.result.t0 < runB.result.t1 && runB.result.t0 < runA.result.t1
    check('两个会话的浏览器脚本时间段重叠（并发执行，没有互相排队）', overlap, { a: runA.result && [runA.result.t0, runA.result.t1], b: runB.result && [runB.result.t0, runB.result.t1] })
    const outputs = ['a-open.json', 'b-open.json', 'a-run.json', 'b-run.json', 'a-download.json', 'b-download.json'].map((name) => readOut(ctx, name).raw).join('\n')
    check('并发期间没有任何 waiting_resource', !/waiting_resource/i.test(outputs) && runA.out?.ok === true && runB.out?.ok === true, outputs.slice(0, 400))
    check('两个会话的点击各自生效', runA.result?.pressed?.some((line) => line.includes('clicked-a')) && runB.result?.pressed?.some((line) => line.includes('clicked-b')), { a: runA.result?.pressed, b: runB.result?.pressed })
    check('下载回执各归各：A 只看到 report-a，B 只看到 report-b', runA.result?.download === 'report-a.bin' && runB.result?.download === 'report-b.bin', { a: runA.result?.download, b: runB.result?.download })
    const dlA = readOut(ctx, 'a-download.json').json
    const dlB = readOut(ctx, 'b-download.json').json
    check('download --wait 返回本会话的文件', dlA?.summary?.filename === 'report-a.bin' && dlB?.summary?.filename === 'report-b.bin', { a: dlA?.summary, b: dlB?.summary })
    const saved = readdirSync(box.downloads)
    check('两个文件都落到下载目录', saved.some((name) => name.endsWith('report-a.bin')) && saved.some((name) => name.endsWith('report-b.bin')), saved)
    const stA = await browserOf(a)
    const stB = await browserOf(b)
    check('各自的浏览器状态只含本会话页面', stA.tabs.every((url) => url.startsWith(`${base}/a`)) && stB.tabs.every((url) => url.startsWith(`${base}/b`)), { stA, stB })

    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(aFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(a)} && !s.switchLoading`, 15000)
    await runCommands(ctx, 'a-handoff', [
      `yan browser request-user-control --reason 请登录 > ba/a-handoff.json 2>&1; yan browser open --url ${base}/a?again=1 > ba/a-blocked.json 2>&1`
    ])
    const blocked = readOut(ctx, 'a-blocked.json').json
    check('A 接管期间 A 的改页面操作被拒', blocked?.ok === false && /waiting_resource|user_control_active/i.test(blocked?.code ?? ''), blocked)
    const handA = await browserOf(a)
    const handB = await browserOf(b)
    check('A 交给用户后只有 A 显示接管', handA.userControl && handA.reason === '请登录' && !handB.userControl, { handA, handB })
    await shot('a-handoff')

    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(bFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(b)} && !s.switchLoading`, 15000)
    const aTab = (await browserOf(a)).active
    check('拿到 A 的标签 id', typeof aTab === 'string' && aTab.startsWith('tab-'), aTab)
    await runCommands(ctx, 'b-during', [
      script('b', 200, 'b2'),
      `yan browser close-tab --id ${aTab} > ba/b-close-a.json 2>&1`,
      `yan browser switch-tab --id ${aTab} > ba/b-switch-a.json 2>&1`
    ])
    const closeForeign = readOut(ctx, 'b-close-a.json').json
    const switchForeign = readOut(ctx, 'b-switch-a.json').json
    check('B 用 A 的标签 id 关闭被拒（tab_not_found）', closeForeign?.ok === false && closeForeign?.code === 'tab_not_found', closeForeign)
    check('B 用 A 的标签 id 切换被拒（tab_not_found）', switchForeign?.ok === false && switchForeign?.code === 'tab_not_found', switchForeign)
    const afterForeign = await browserOf(a)
    const bAfter = await browserOf(b)
    check('A 的标签仍在且仍是 A 的当前标签，B 的标签里没有 A 的', afterForeign.ids.includes(aTab) && afterForeign.active === aTab && !bAfter.ids.includes(aTab), { afterForeign, bAfter })
    const during = parse('b2-run.json')
    log('b during handoff', during.out?.code, during.result)
    check('A 接管期间 B 会话照常点击和下载', during.out?.ok === true && during.result?.download === 'report-b.bin', during.out)
    const stillA = await browserOf(a)
    check('B 会话发消息不会交还 A 的接管，A 页面没被改', stillA.userControl && !/again=1/.test(stillA.url), stillA)

    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(aFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(a)} && !s.switchLoading`, 15000)
    await ev(`window.yan.browser.releaseUserControl(${JSON.stringify(a)})`)
    await sleep(300)
    const released = await browserOf(a)
    check('界面交还后 A 不再显示接管', !released.userControl, released)
    await runCommands(ctx, 'a-after', [`yan browser open --url ${base}/a?again=2 > ba/a-after.json 2>&1`])
    const after = readOut(ctx, 'a-after.json').json
    check('交还后 A 会话可以继续操作', after?.ok === true && /again=2/.test(after?.summary?.url ?? ''), after?.summary ?? after)
    await shot('after-release')
  } finally {
    server.close()
  }
}
