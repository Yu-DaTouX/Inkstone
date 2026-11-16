import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: 'agent 浏览器控制：observe 短 ref 与视口过滤、--find、text 分段、动作回执变化摘要、run --code 内联脚本与跨次变量、遮挡时点击失败、导航后旧 ref 报 stale；本地夹具页，不调用真实模型' }

export const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Agent fixture</title>
<style>body{font:16px sans-serif;margin:0}.bar{position:relative;height:100px}.buy{position:absolute;left:20px;top:30px}#blocker{position:absolute;left:0;top:0;width:320px;height:90px;background:rgba(0,0,0,.6);color:#fff}</style></head>
<body><div class="bar"><button class="buy" onclick="document.getElementById('status').textContent='Bought it'">Buy</button><div id="blocker">Cookies <button onclick="this.parentNode.remove()">Accept all</button></div></div>
<form id="f"><input id="q" aria-label="Search"> <button type="submit">Search</button></form>
<p id="status"></p><ul id="results"></ul>
<div style="height:1600px">filler</div>
${Array.from({ length: 40 }, (_, i) => `<a href="#a${i}">Archive ${i}</a>`).join(' ')}
<p>Footer note: the end.</p><a href="/second">Second page</a>
<script>document.getElementById('f').addEventListener('submit',(e)=>{e.preventDefault();const v=document.getElementById('q').value;document.getElementById('status').textContent='Results for '+v;const li=document.createElement('li');li.innerHTML='<a href="#r">Result '+v+'</a>';document.getElementById('results').appendChild(li)})</script>
</body></html>`

export function fixtureServer() {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/second' ? '<!doctype html><title>Second</title><body><h1>Second</h1><a href="/">Back</a></body>' : FIXTURE)
  })
}

export async function runCommands(ctx, name, commands, timeout = 180000) {
  const dir = join(ctx.box.project, 'ba')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`).replace(/\\/g, '/')
  writeFileSync(file, JSON.stringify(commands))
  await ctx.turn(`CMDFILE=${file}`, { timeout })
}

export function readOut(ctx, name) {
  const path = join(ctx.box.project, 'ba', name)
  if (!existsSync(path)) return { raw: '', json: null }
  const raw = readFileSync(path, 'utf8').trim()
  const line = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop() ?? ''
  try { return { raw, json: JSON.parse(line) } } catch { return { raw, json: null } }
}

export default async function run(ctx) {
  const { cdp, box, check, log, newSession, shot } = ctx
  const server = fixtureServer()
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const url = `http://127.0.0.1:${port}/`
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    await newSession(box.project)
    await runCommands(ctx, 'batch1', [
      `yan browser open --url ${url} > ba/01-open.json 2>&1`,
      'yan browser observe > ba/02-observe.json 2>&1',
      'yan browser observe --find "Second page" > ba/03-find.json 2>&1',
      'yan browser text --max-chars 300 > ba/04-text.json 2>&1',
      `yan browser run --code - > ba/05-run.json 2>&1 <<'JS'\nawait page.fill({ role: 'textbox', name: 'Search' }, 'alpha')\nconst r = await page.click({ role: 'button', name: 'Search', exact: true })\nglobalThis.mark = 'kept-value'\nreturn { changes: r.changes, hits: await page.text({ find: 'Results for alpha' }) }\nJS`,
      "yan browser run --code 'return globalThis.mark' > ba/06-run.json 2>&1",
      `yan browser run --code - > ba/07-run.json 2>&1 <<'JS'\nconst out = {}\ntry { await page.click({ role: 'button', name: 'Buy', exact: true }); out.first = 'clicked' } catch (e) { out.first = e.code; out.message = e.message }\nout.beforeAccept = (await page.text({ find: 'Bought it' })).length\nawait page.click({ name: 'Accept all' })\nawait page.click({ role: 'button', name: 'Buy', exact: true })\nout.afterAccept = (await page.text({ find: 'Bought it' })).length\nreturn out\nJS`
    ])
    const observe = readOut(ctx, '02-observe.json').json
    const items = observe?.summary?.items ?? []
    log('observe', { chars: readOut(ctx, '02-observe.json').raw.length, items: items.length, offscreen: observe?.summary?.offscreen })
    check('observe 成功且 ref 是短编号', observe?.ok === true && items.length > 0 && items.every((line) => /^[a-z]{3}\d+ /.test(line)), items.slice(0, 4))
    check('默认只列视口内元素，视口外的计数并提示', (observe?.summary?.offscreen ?? 0) >= 40 && !items.some((line) => line.includes('Archive 39')), { offscreen: observe?.summary?.offscreen })
    const found = readOut(ctx, '03-find.json').json
    check('--find 找到视口外的元素', found?.summary?.items?.some((line) => line.includes('"Second page"')), found?.summary)
    const text = readOut(ctx, '04-text.json').json
    check('text 分段读并给出 nextOffset', text?.summary?.text?.length === 300 && text?.summary?.nextOffset === 300, text?.summary)
    const run1 = readOut(ctx, '05-run.json').json
    const result1 = (() => { try { return JSON.parse(run1?.summary?.result ?? 'null') } catch { return null } })()
    log('run1', run1?.summary)
    check('一段内联脚本完成 填写→点击→回读，变化摘要带新结果', run1?.ok === true && result1?.hits?.length === 1 && result1.changes.some((line) => line.includes('Result alpha')), result1)
    const run2 = readOut(ctx, '06-run.json').json
    check('同一页面的下一次 run 保留 globalThis 变量', run2?.summary?.result === 'kept-value' && run2?.summary?.runtime === 'kept', run2?.summary)
    const run3 = readOut(ctx, '07-run.json').json
    const result3 = (() => { try { return JSON.parse(run3?.summary?.result ?? 'null') } catch { return null } })()
    log('run3', result3)
    check('被遮挡的按钮不点，报 ELEMENT_OBSCURED 与遮挡者', result3?.first === 'ELEMENT_OBSCURED' && /blocker/.test(result3?.message ?? '') && result3?.beforeAccept === 0, result3)
    check('关掉遮挡后同一按钮可以点击', result3?.afterAccept === 1, result3)

    const searchRef = /^(\S+) textbox "Search"/m.exec(items.join('\n'))?.[1]
    check('清单里有搜索框 ref', !!searchRef, items)
    await runCommands(ctx, 'batch2', [
      'yan browser observe > ba/08-observe.json 2>&1',
      `yan browser type --ref ${searchRef} --text beta > ba/09-type.json 2>&1`,
      `yan browser navigate --url ${url}second > ba/10-nav.json 2>&1`,
      `yan browser click --ref ${searchRef} > ba/11-stale.json 2>&1`
    ])
    const typed = readOut(ctx, '09-type.json').json
    log('type', typed?.summary)
    check('动作回执带值变化，不再附整份清单', typed?.summary?.changes?.some((line) => line.startsWith(`~ ${searchRef} textbox "Search" ="beta"`)) && !('items' in (typed?.summary ?? {})), typed?.summary)
    const stale = readOut(ctx, '11-stale.json').json
    check('导航后旧 ref 报 stale_element，不会点到新页面的同号元素', stale?.ok === false && stale?.code === 'stale_element', stale)
    await shot('after')
  } finally {
    server.close()
  }
}
