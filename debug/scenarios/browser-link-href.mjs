import { createServer } from 'node:http'
import { runCommands, readOut } from './browser-agent-control.mjs'

export const meta = { description: '内置浏览器：observe 链接行带地址、--find 按地址找、脚本按 href 点击同名链接、正则名称与写错字段报 INVALID_QUERY；本地夹具页，不调用真实模型' }

const PAGE = `<!doctype html><meta charset="utf-8"><title>Links</title><body>
<p><a href="/runs/5/workflow">checks</a> <a href="/runs/5/job/7#step:7:17">checks</a> <a href="https://other.example/x?token=abc&page=2">Other</a></p>
</body>`

export default async function run(ctx) {
  const { box, check, log, newSession } = ctx
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url?.startsWith('/runs/5/job/7') ? '<!doctype html><title>Job 7</title><h1>Job log</h1>' : PAGE)
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const url = `http://127.0.0.1:${port}/`
  try {
    await newSession(box.project)
    await runCommands(ctx, 'links', [
      `yan browser open --url ${url} > ba/l1-open.json 2>&1`,
      'yan browser observe > ba/l2-observe.json 2>&1',
      'yan browser observe --find "job/7" > ba/l3-find.json 2>&1',
      `yan browser run --code - > ba/l4-run.json 2>&1 <<'JS'\nconst out = {}\ntry { await page.click({ role: 'link', name: 'checks' }) } catch (e) { out.ambiguous = e.code; out.hint = e.message }\nout.regexName = (await page.findAll({ role: 'link', name: /^checks$/ })).length\ntry { await page.find({ title: 'x' }) } catch (e) { out.invalid = e.code }\nconst r = await page.click({ role: 'link', href: '/job/' })\nout.url = r.url\nreturn out\nJS`
    ])
    const items = readOut(ctx, 'l2-observe.json').json?.summary?.items ?? []
    log('items', items)
    check('observe 同站链接行尾带路径与锚点', items.some((line) => line.endsWith('link "checks" → /runs/5/job/7#step:7:17')), items)
    check('外站链接写全地址并遮住凭据参数', items.some((line) => line.includes('→ https://other.example/x?token=%E2%80%A2&page=2')), items)
    const found = readOut(ctx, 'l3-find.json').json?.summary?.items ?? []
    check('--find 按链接地址找到唯一元素', found.length === 1 && found[0].includes('/job/7'), found)
    const runOut = readOut(ctx, 'l4-run.json').json
    const result = (() => { try { return JSON.parse(runOut?.summary?.result ?? 'null') } catch { return null } })()
    log('run', result ?? runOut)
    check('同名链接歧义提示带地址', result?.ambiguous === 'AMBIGUOUS_TARGET' && /→ \/runs\/5\/job\/7/.test(result?.hint ?? ''), result)
    check('name 写正则生效', result?.regexName === 2, result)
    check('写错查询字段报 INVALID_QUERY', result?.invalid === 'INVALID_QUERY', result)
    check('按 href 点到作业页', /\/runs\/5\/job\/7/.test(result?.url ?? ''), result)
  } finally {
    server.close()
  }
}
