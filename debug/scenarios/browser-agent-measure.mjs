import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureServer, readOut, runCommands } from './browser-agent-control.mjs'

export const meta = { observation: true, description: '测量：本地夹具与几个真实网页上 observe 的 stdout 字符数，以及夹具上「搜索并核对结果」任务的命令次数与 stdout 总字符；改前改后各跑一次对比，不调用真实模型（真实网页需要联网）' }

const REAL_PAGES = [
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://news.ycombinator.com/',
  'https://github.com/microsoft/playwright',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input'
]

export default async function run(ctx) {
  const { cdp, box, log, newSession } = ctx
  const server = fixtureServer()
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const fixture = `http://127.0.0.1:${port}/`
  const result = { pages: [], tasks: {} }
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    await newSession(box.project)
    await runCommands(ctx, 'help', ['yan browser --help > ba/help.txt 2>&1'])
    const modern = /run --code -/.test(readOut(ctx, 'help.txt').raw)
    const pages = [fixture, ...REAL_PAGES]
    await runCommands(ctx, 'pages', pages.flatMap((url, i) => [
      `yan browser navigate --url ${url} > ba/p${i}-nav.json 2>&1; sleep 2`,
      `yan browser observe > ba/p${i}-observe.json 2>&1`,
      ...(modern ? [`yan browser observe --all > ba/p${i}-all.json 2>&1`] : [])
    ]), 600000)
    pages.forEach((url, i) => {
      const observe = readOut(ctx, `p${i}-observe.json`)
      const all = modern ? readOut(ctx, `p${i}-all.json`) : null
      const items = observe.json?.summary?.items ?? []
      const refChars = items.reduce((sum, line) => sum + line.split(' ')[0].length, 0)
      result.pages.push({ url, ok: observe.json?.ok === true, observeChars: observe.raw.length, items: items.length, refChars, elements: observe.json?.summary?.elements, offscreen: observe.json?.summary?.offscreen ?? 0, allChars: all?.raw.length ?? null, allItems: all?.json?.summary?.items?.length ?? null })
    })

    const steps = []
    const record = (name) => { const out = readOut(ctx, name); steps.push({ name, chars: out.raw.length, ok: out.json?.ok === true }); return out }
    await runCommands(ctx, 'task-a', [`yan browser navigate --url ${fixture} > ba/ta1.json 2>&1`, 'yan browser observe > ba/ta2.json 2>&1'])
    record('ta1.json')
    const items = record('ta2.json').json?.summary?.items ?? []
    const box1 = /^(\S+) textbox "Search"/m.exec(items.join('\n'))?.[1]
    const button = /^(\S+) button "Search"/m.exec(items.join('\n'))?.[1]
    await runCommands(ctx, 'task-b', [
      `yan browser type --ref ${box1} --text alpha > ba/ta3.json 2>&1`,
      `yan browser click --ref ${button} > ba/ta4.json 2>&1`,
      ...(modern ? [] : ['yan browser observe > ba/ta5.json 2>&1'])
    ])
    record('ta3.json')
    const clicked = record('ta4.json')
    const verified = modern ? JSON.stringify(clicked.json?.summary?.changes ?? '').includes('Results for alpha') : (record('ta5.json').json?.summary?.textChars ?? 0) > 0
    result.tasks.cli = { calls: steps.length, chars: steps.reduce((sum, step) => sum + step.chars, 0), verifiedInReceipt: modern && verified, steps }
    if (modern) {
      await runCommands(ctx, 'task-c', [`yan browser run --code - > ba/tc1.json 2>&1 <<'JS'\nawait page.goto(${JSON.stringify(fixture)})\nawait page.fill({ role: 'textbox', name: 'Search' }, 'alpha')\nconst r = await page.click({ role: 'button', name: 'Search', exact: true })\nreturn { changes: r.changes, hits: await page.text({ find: 'Results for alpha' }) }\nJS`])
      const out = readOut(ctx, 'tc1.json')
      result.tasks.script = { calls: 1, chars: out.raw.length, ok: out.json?.ok === true, verified: /Results for alpha/.test(out.raw) }
    }
    log('measure', result)
    writeFileSync(join(ctx.runDir, 'measure.json'), JSON.stringify({ modern, ...result }, null, 2))
  } finally {
    server.close()
  }
}
