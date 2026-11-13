import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-session-transfer-'))
const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.stack : String(error)}\n`)
  }
}
const section = (name) => process.stdout.write(`\n▌${name}\n`)
const put = async (file, content) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: 'export const ipcMain = { handle() {} }' }))
  }
}
async function bundle(entry, name, extra = {}) {
  const outfile = join(root, `${name}.mjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub], ...extra })
  return import(pathToFileURL(outfile).href)
}

function captureRegistrar() {
  const handlers = new Map()
  return {
    ipc: { handle: (channel, fn) => handlers.set(channel, fn), rawHandle: () => undefined },
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`未注册的通道：${channel}`)
      return handler(...args)
    }
  }
}

try {
  const { exportSession, importSession, readSessionId, SESSION_TRANSFER_MAX_BYTES } = await bundle('src/main/session-transfer.ts', 'transfer')
  const { registerSessionTransferIpc } = await bundle('src/main/ipc/session-transfer-ipc.ts', 'transfer-ipc')

  section('会话导出 / 导入：生成新 id、不覆盖同名')
  const sourceSession = join(root, 'sessions-src', 'original.jsonl')
  const originalId = 'sess-original-0001'
  await put(sourceSession, [
    JSON.stringify({ type: 'session', id: originalId, cwd: 'C:/work' }),
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ type: 'message', id: 'e2', message: { role: 'assistant', content: '你好，有什么可以帮忙？' } })
  ].join('\n') + '\n')
  const exportResult = await exportSession(sourceSession, join(root, 'export', 'my-session'))
  await check('导出成功并生成会话包', () => {
    assert.equal(exportResult.ok, true, exportResult.error)
    assert.equal(existsSync(exportResult.path), true)
  })
  const importDir = join(root, 'sessions-import')
  await check('导入生成新 id，正文完整', async () => {
    const queue = ['sess-import-0001']
    const imported = await importSession(exportResult.path, importDir, { newId: () => queue.shift() ?? randomUUID() })
    assert.equal(imported.ok, true, imported.error)
    assert.equal(imported.sessionId, 'sess-import-0001')
    const text = await readFile(imported.path, 'utf8')
    assert.match(text, /sess-import-0001/)
    assert.match(text, /你好，有什么可以帮忙？/)
  })
  await check('同名时换新 id，不覆盖已有会话', async () => {
    const queue = ['sess-import-0001', 'sess-import-0002']
    const imported = await importSession(exportResult.path, importDir, { newId: () => queue.shift() ?? randomUUID() })
    assert.equal(imported.ok, true, imported.error)
    assert.equal(imported.sessionId, 'sess-import-0002')
    assert.equal(existsSync(join(importDir, 'sess-import-0001.jsonl')), true)
    assert.equal(existsSync(join(importDir, 'sess-import-0002.jsonl')), true)
  })
  await check('超过 64MB 的会话包拒绝导入，不落任何会话文件', async () => {
    const huge = join(root, 'huge-bundle.json')
    await writeFile(huge, JSON.stringify({ v: 1, kind: 'inkstone-session', exportedAt: 1, fileName: 'a.jsonl', content: 'x' }))
    await truncate(huge, SESSION_TRANSFER_MAX_BYTES + 1)
    const target = join(root, 'sessions-huge')
    const imported = await importSession(huge, target)
    assert.equal(imported.ok, false)
    assert.match(imported.error, /过大|too large/i)
    assert.equal(existsSync(target), false)
  })
  await check('超过 64MB 的会话拒绝导出，不写半份会话包', async () => {
    const hugeSession = join(root, 'sessions-src', 'huge.jsonl')
    await writeFile(hugeSession, JSON.stringify({ type: 'session', id: 'sess-huge' }))
    await truncate(hugeSession, SESSION_TRANSFER_MAX_BYTES + 1)
    const target = join(root, 'export', 'huge')
    const exported = await exportSession(hugeSession, target)
    assert.equal(exported.ok, false)
    assert.match(exported.error, /过大|too large/i)
    assert.equal(existsSync(`${target}.inkstone-session.json`), false)
  })

  section('会话头改写')
  const sessionRoot = join(root, 'sessions')
  const original = join(sessionRoot, 'original.jsonl')
  await put(original, 'original-safe')
  const importContent = async (content, ids = ['original', 'fresh']) => {
    const file = join(root, `session-${randomUUID()}.json`)
    await writeFile(file, JSON.stringify({ v: 1, kind: 'inkstone-session', content }))
    return importSession(file, sessionRoot, { newId: () => ids.shift() ?? randomUUID() })
  }
  for (const header of ['{"type": "session", "id": "original"}', '\t{ "id" : "original", "type"\t:\t"session" }\r', '{"type":"session","id":"original"}']) {
    await check(`合法 JSON 空白改写头 ${JSON.stringify(header)}`, async () => {
      const body = '\n{"type":"message","id":"m1","message":{"role":"user","content":"unchanged"}}\n'
      const id = randomUUID()
      const result = await importContent(`\n${header}${body}`, ['original', id])
      assert.equal(result.ok, true, result.error)
      assert.equal(result.sessionId, id)
      assert.equal(result.renamedFrom, 'original')
      const content = await readFile(result.path, 'utf8')
      assert.equal(readSessionId(content), id)
      assert.ok(content.endsWith(body))
      assert.equal(await readFile(original, 'utf8'), 'original-safe')
    })
  }
  for (const content of [' ', '{"type":"message","id":"original"}', '{"type":"session"}', '{"type":"session","id":"  "}', '{"type":"session","id":42}', '{"type":"session","id":"a"}\n{"type":"session","id":"b"}']) {
    await check(`无有效唯一会话头拒绝 ${content}`, async () => {
      const before = await readdir(sessionRoot)
      assert.equal((await importContent(content)).ok, false)
      assert.deepEqual(await readdir(sessionRoot), before)
    })
  }
  await check('即使源文件不存在也不复用原 ID', async () => {
    const result = await importContent('{"type": "session", "id": "absent-source"}', ['absent-source', 'different-id'])
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, 'different-id')
  })

  section('IPC：路径由对话框注入')
  const ipcRoot = join(root, 'ipc')
  const sessionsDir = join(ipcRoot, 'sessions')
  const exportDir = join(ipcRoot, 'export')
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(exportDir, { recursive: true })
  const sessionFile = join(ipcRoot, 'sess-original.jsonl')
  await put(sessionFile, [
    JSON.stringify({ type: 'session', id: 'orig-0001', v: 1 }),
    JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' } })
  ].join('\n') + '\n')
  const deps = {
    sessionsDir,
    pickExportPath: async (name) => join(exportDir, name),
    pickImportFile: async () => '',
    currentSessionPath: () => sessionFile
  }
  const register = (overrides = {}) => {
    const registrar = captureRegistrar()
    registerSessionTransferIpc(registrar.ipc, { ...deps, ...overrides })
    return registrar
  }
  let exportedPath = ''
  await check('导出用注入的保存路径写会话包', async () => {
    const result = await register().invoke('yan:sessionTransfer:export')
    assert.equal(result.ok, true, result.error)
    assert.equal(existsSync(result.path), true)
    assert.ok(result.bytes > 0)
    exportedPath = result.path
    const bundle = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(bundle.kind, 'inkstone-session')
    assert.equal(bundle.sourceSessionId, 'orig-0001')
  })
  await check('导出指定的会话路径优先于当前会话', async () => {
    const other = join(ipcRoot, 'sess-other.jsonl')
    await put(other, JSON.stringify({ type: 'session', id: 'other-0001' }) + '\n')
    const result = await register().invoke('yan:sessionTransfer:export', other)
    assert.equal(result.ok, true, result.error)
    assert.equal(JSON.parse(await readFile(result.path, 'utf8')).sourceSessionId, 'other-0001')
  })
  await check('没有当前会话时返回可读错误', async () => {
    const result = await register({ currentSessionPath: () => undefined }).invoke('yan:sessionTransfer:export')
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  })
  await check('导入用注入的会话包路径，生成新 id 且不覆盖同名', async () => {
    const result = await register({ pickImportFile: async () => exportedPath }).invoke('yan:sessionTransfer:import')
    assert.equal(result.ok, true, result.error)
    assert.notEqual(result.sessionId, 'orig-0001')
    assert.equal(existsSync(result.path), true)
    assert.ok(result.path.startsWith(sessionsDir))
    const content = await readFile(result.path, 'utf8')
    assert.match(content, new RegExp(`"type":"session","id":"${result.sessionId}"`))
  })
  await check('导入取消时不抛异常', async () => {
    const result = await register({ pickImportFile: async () => null }).invoke('yan:sessionTransfer:import')
    assert.deepEqual(result, { ok: false, cancelled: true })
  })
  await check('导出取消时不抛异常', async () => {
    const result = await register({ pickExportPath: async () => null }).invoke('yan:sessionTransfer:export')
    assert.deepEqual(result, { ok: false, cancelled: true })
  })
  section('多格式导出')
  const { sessionMarkdown } = await bundle('src/shared/session-markdown.ts', 'markdown')
  const history = [
    { id: 'u1', role: 'user', text: '帮我看看 README', images: [{ mimeType: 'image/png', data: 'x' }] },
    { id: 'n1', role: 'user', text: '<subagent-notification id="sub-1" status="done">\n完成\n</subagent-notification>' },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'read', args: { path: 'README.md' }, status: 'ok', output: '不该出现的工具输出' }, { id: 't2', name: 'bash', args: { command: 'echo `hi`' }, status: 'error' }, { id: 't3', name: 'read', args: { path: 'nested.md' }, status: 'ok', parentToolCallId: 't1' }] },
    { id: 'a2', role: 'assistant', text: '这是项目说明。', thinking: '不该出现的思考' },
    { id: 'x1', role: 'note', text: '不该出现的备注' },
    { id: 'b1', role: 'bash', text: 'ok\n', bash: { command: 'npm test', exitCode: 0, cancelled: false } }
  ]
  await check('Markdown：按说话人分段，工具只列名称与要点，不含思考、工具输出、宿主通知与备注', async () => {
    const text = sessionMarkdown(history, { title: '读文档', cwd: 'E:/demo', exportedAt: new Date(2026, 10, 13, 12, 5).getTime() })
    assert.ok(text.startsWith('# 读文档\n\n> 导出自 Inkstone · 2026-11-13 12:05 · `E:/demo`\n\n---\n\n**用户**\n\n帮我看看 README\n\n'), text)
    assert.equal(text.match(/^\*\*助手\*\*$/gm)?.length, 1, '连续的助手消息只出一个标签')
    assert.ok(!/^## /m.test(text), '说话人标签不占用标题层级')
    assert.ok(text.includes('- `read` `README.md`\n- `bash` `` echo `hi` ``（失败）'), text)
    assert.ok(text.includes('这是项目说明。'))
    assert.ok(text.includes('图片 1 张'))
    assert.ok(text.includes('```\n$ npm test\nok\n```'))
    for (const absent of ['不该出现', 'subagent-notification', 'nested.md']) assert.ok(!text.includes(absent), absent)
  })
  await check('按 Markdown 导出：用标题做文件名，写出 .md 并在文件管理器里定位', async () => {
    const picked = []
    const revealed = []
    const result = await register({
      pickExportPath: async (name, format) => (picked.push([name, format]), join(exportDir, name)),
      readMessages: async (path) => (path === sessionFile ? { messages: history, cwd: 'E:/demo' } : null),
      reveal: (path) => revealed.push(path)
    }).invoke('yan:sessionTransfer:export', sessionFile, { format: 'markdown', title: '读文档: a/b?', reveal: true })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(picked, [['读文档 a b.md', 'markdown']])
    assert.ok(result.path.endsWith('.md'))
    assert.deepEqual(revealed, [result.path])
    assert.ok((await readFile(result.path, 'utf8')).startsWith('# 读文档: a/b?\n'))
  })
  await check('取 Markdown 文本的通道：读得到返回文本，读不到返回可读错误', async () => {
    const readMessages = async (path) => (path === sessionFile ? { messages: history } : null)
    const found = await register({ readMessages }).invoke('yan:sessionTransfer:markdown', sessionFile, '读文档')
    assert.equal(found.ok, true, found.error)
    assert.ok(found.markdown.startsWith('# 读文档\n'))
    const missing = await register({ readMessages }).invoke('yan:sessionTransfer:markdown', join(ipcRoot, 'nope.jsonl'))
    assert.equal(missing.ok, false)
    assert.ok(missing.error.length > 0)
  })
  await check('按 HTML 导出：保存界面渲染好的页面；没有页面内容时不弹保存框', async () => {
    const saved = await register().invoke('yan:sessionTransfer:export', sessionFile, { format: 'html', html: '<!doctype html><p>hi</p>' })
    assert.equal(saved.ok, true, saved.error)
    assert.ok(saved.path.endsWith('sess-original.html'), saved.path)
    assert.equal(await readFile(saved.path, 'utf8'), '<!doctype html><p>hi</p>')
    let asked = 0
    const empty = await register({ pickExportPath: async () => (asked += 1, null) }).invoke('yan:sessionTransfer:export', sessionFile, { format: 'html' })
    assert.equal(empty.ok, false)
    assert.equal(asked, 0)
  })
  await check('HTML 页面：Markdown 渲染成标签，原始 HTML 与图片不进页面，标题转义', async () => {
    const { sessionHtmlDocument } = await bundle('src/renderer/src/features/sidebar/session-export-html.ts', 'export-html', { banner: { js: "import { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)" } })
    const page = await sessionHtmlDocument('# 标题\n\n## 用户\n\n**粗体** <script>alert(1)</script> ![x](https://example.com/a.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nlet a = 1 < 2\n```\n', '标题 <b>', 'zh-CN')
    assert.ok(page.startsWith('<!doctype html>\n<html lang="zh-CN">'))
    assert.ok(page.includes('<title>标题 &lt;b&gt;</title>'))
    assert.ok(page.includes('<h1>标题</h1>') && page.includes('<h2>用户</h2>') && page.includes('<strong>粗体</strong>'))
    assert.ok(page.includes('<table>') && page.includes('<pre><code class="language-js">let a = 1 &lt; 2'))
    assert.ok(!page.includes('<script') && !page.includes('<img'), page)
  })
  await check('读不到会话或格式不认识时不写文件；不认识的格式按会话包导出', async () => {
    const missing = await register({ readMessages: async () => null }).invoke('yan:sessionTransfer:export', sessionFile, { format: 'markdown', title: 'none' })
    assert.equal(missing.ok, false)
    assert.equal(existsSync(join(exportDir, 'none.md')), false)
    const fallback = await register().invoke('yan:sessionTransfer:export', sessionFile, { format: 'pdf', title: 'odd' })
    assert.equal(fallback.ok, true, fallback.error)
    assert.ok(fallback.path.endsWith('odd.inkstone-session.json'), fallback.path)
  })
  await check('导入损坏的会话包返回可读错误', async () => {
    const broken = join(ipcRoot, 'broken.json')
    await writeFile(broken, '{broken')
    const result = await register({ pickImportFile: async () => broken }).invoke('yan:sessionTransfer:import')
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 会话导入导出：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
