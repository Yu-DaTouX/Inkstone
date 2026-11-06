import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const work = await mkdtemp(join(tmpdir(), 'yan-error-surface-'))
const cliPath = join(root, 'resources', 'yan-cli', 'yan.mjs')

await build({
  entryPoints: ['src/main/capability-server.ts', 'src/main/artifact-preview-command.ts', 'src/main/plugin-commands.ts'],
  outdir: join(work, 'out'),
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const load = (name) => import(pathToFileURL(join(work, 'out', 'main', name)).href)
const { CapabilityServer, CapabilityCommandError, CAPABILITY_API_VERSION } = await load('capability-server.js')
const { runArtifactPreview } = await load('artifact-preview-command.js')
const { configurePluginCommands, runPluginCommand } = await load('plugin-commands.js')

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

try {
  const seen = []
  const trap = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push(JSON.parse(body))
      const text = JSON.stringify({ ok: true, summary: {} })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, YAN_CLI_URL: `http://127.0.0.1:${trap.address().port}/rpc`, YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's', YAN_PROJECT_ID: 'p' }

  const file = async (name, value) => {
    const path = join(work, name)
    await writeFile(path, JSON.stringify(value))
    return path
  }
  const queryFile = await file('q.json', { queryText: '搜索词' })
  const listFile = await file('qs.json', { queries: ['a', 'b'] })
  const describeFile = await file('d.json', { serverId: 'srv', toolName: 'tool' })
  const docsFile = await file('docs.json', { library: 'react', queryText: 'useEffect' })
  const emptyFile = await file('empty.json', {})

  for (const [args, command, label] of [
    [['search', 'query', '--query-file', queryFile], 'search.query', 'search query --query-file 驼峰键'],
    [['search', 'query', '--request-file', listFile], 'search.query', 'search query --request-file queries 数组'],
    [['search', 'docs', '--request-file', docsFile], 'search.docs', 'search docs --request-file'],
    [['mcp', 'describe', '--request-file', describeFile], 'mcp.describe', 'mcp describe --request-file serverId/toolName']
  ]) {
    seen.length = 0
    const out = await runCli(args, env)
    assert.equal(out.status, 0, `${label}：不被参数门禁拦下（${out.stderr}）`)
    assert.equal(seen.at(-1)?.command, command, `${label}：请求到达宿主`)
  }

  seen.length = 0
  const missing = await runCli(['search', 'query', '--query-file', emptyFile], env)
  assert.equal(missing.status, 2, '真缺参数仍然报用法错误')
  const missingBody = JSON.parse(missing.stderr)
  assert.equal(missingBody.code, 'usage_error', 'CLI 层错误带 code')
  assert.match(missingBody.error, /缺少参数/)
  assert.equal(seen.length, 0, '真缺参数不发请求')

  const unreachable = await runCli(['search', 'query', '--query-text', 'x'], { ...env, YAN_CLI_URL: 'http://127.0.0.1:1/rpc' })
  assert.equal(unreachable.status, 3)
  const unreachableBody = JSON.parse(unreachable.stderr)
  assert.equal(unreachableBody.code, 'host_unavailable')
  assert.ok(unreachableBody.hint, '连不上宿主时给出下一步')
  trap.close()

  const opsDir = join(work, 'ops')
  const server = new CapabilityServer({
    opsDir,
    onlyCommands: ['search.query', 'artifact.preview'],
    handlers: {
      async run(command) {
        if (command === 'search.query') throw new CapabilityCommandError('STALE_ELEMENT', '元素失效')
        return { summary: { ok: true }, data: { big: 1 } }
      }
    }
  })
  const endpoint = await server.start({ sessionId: 's', projectId: 'p' })
  const rpc = async (command) => (await fetch(endpoint.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, sessionId: 's', projectId: 'p', command, params: {} })
  })).json()
  try {
    const closed = await rpc('browser.click')
    assert.equal(closed.ok, false)
    assert.equal(closed.code, 'command_not_available', '已登记但本会话未开放的命令有明确错误码')
    assert.match(closed.hint, /未开放 browser/, 'hint 说明哪组命令没开放')
    assert.match(closed.hint, /search\.query/, 'hint 列出本会话开放的命令')

    const unknown = await rpc('totally.unknown')
    assert.equal(unknown.error, 'unknown_command')
    assert.equal(unknown.code, undefined, '完全未知的命令没有 code')

    const upper = await rpc('search.query')
    assert.equal(upper.ok, false)
    assert.equal(upper.code, 'stale_element', '对外错误码统一小写')

    await rm(opsDir, { recursive: true, force: true })
    await writeFile(opsDir, 'blocks the directory')
    const unwritten = await rpc('artifact.preview')
    assert.equal(unwritten.ok, true)
    assert.equal(unwritten.resultFile, undefined)
    assert.match(unwritten.resultError, /没能写盘/, '结果写盘失败要说出来')
  } finally {
    server.stop()
  }

  const html = join(work, 'page.html')
  const preview = (path) => runArtifactPreview(async () => { throw new Error('preview_read') }, path, work)
  await assert.rejects(preview('nope.html'), (error) => {
    assert.equal(error.code, 'artifact_not_found')
    assert.ok(error.message.includes(join(work, 'nope.html')), '回显解析后的绝对路径')
    return true
  })
  await mkdir(html)
  await assert.rejects(preview('page.html'), (error) => {
    assert.equal(error.code, 'artifact_unreadable', '存在但读不了和不存在是两种错误')
    assert.ok(error.message.includes(html))
    return true
  })

  configurePluginCommands(async () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }) })
  await assert.rejects(runPluginCommand('x.y', {}, { cwd: work }), (error) => error.code === 'ENOENT', '插件错误码不再丢失')
  configurePluginCommands(async () => { throw Object.assign(new Error('boom'), { code: 'schema-changed' }) })
  await assert.rejects(runPluginCommand('x.y', {}, { cwd: work }), (error) => error.code === 'schema-changed')

  console.log('capability-error-surface: ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
