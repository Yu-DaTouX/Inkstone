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
async function bundle(entry, name) {
  const outfile = join(root, `${name}.mjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
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
