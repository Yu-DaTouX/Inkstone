import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-core-cli-'))
const checks = []
const pass = name => checks.push(name)
try {
  const repeat = (await import(pathToFileURL(resolve('resources/pi-extensions/repeat-guard.js')).href + `?t=${Date.now()}`)).default
  const hooks = new Map()
  repeat({ on: (name, fn) => hooks.set(name, fn) })
  for (let i = 0; i < 3; i++) hooks.get('tool_call')({ toolName: 'read', input: { path: 'x' } })
  const local = hooks.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: 'keep' }] } }, { model: { provider: 'local' } })
  assert.equal(local.messages.length, 1)
  assert.match(local.messages[0].content, /^keep\n\n/)
  const remoteHooks = new Map()
  repeat({ on: (name, fn) => remoteHooks.set(name, fn) })
  for (let i = 0; i < 3; i++) remoteHooks.get('tool_call')({ toolName: 'read', input: { path: 'x' } })
  const remote = remoteHooks.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: 'keep' }] } }, { model: { provider: 'openai' } })
  assert.equal(remote.messages[0].role, 'system')
  pass('repeat guard local reminder appends to user without changing message prefix')

  const { isAllowedBashCommand } = await import(pathToFileURL(resolve('resources/pi-extensions/work-mode.js')).href + `?t=${Date.now()}`)
  assert.equal(isAllowedBashCommand('yan goal status'), true)
  assert.equal(isAllowedBashCommand('"relative\\yan" goal status'), false)
  assert.equal(isAllowedBashCommand('"C:\\Program Files\\Inkstone\\yan.exe" goal status'), true)
  assert.equal(isAllowedBashCommand('/opt/inkstone/resources/yan-cli/yan.mjs goal status'), true)
  pass('work mode accepts bare or absolute host CLI only, rejects relative quoted prefix')

  const lockOut = join(temp, 'lock.mjs')
  await build({ entryPoints: ['src/core/data-root-lock.ts'], outfile: lockOut, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { lockDataRoot } = await import(pathToFileURL(lockOut).href)
  const root = join(temp, 'lock-root')
  await mkdir(join(root, '.runtime-writer'), { recursive: true })
  await assert.rejects(lockDataRoot(root), /未知写入者/)
  pass('ownerless data-root lock fails closed rather than reclaiming a possibly live owner')

  const cli = resolve('resources/yan-cli/yan.mjs')
  const runCli = (args, env = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, YAN_CLI_URL: '', YAN_CLI_TOKEN: '', YAN_SESSION_ID: '', YAN_PROJECT_ID: '', ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value)
    child.on('error', reject); child.on('close', code => resolveRun({ code, stdout, stderr }))
  })
  const missing = await runCli(['browser', 'navigate', '--url'])
  assert.equal(missing.code, 2); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /缺少参数/)
  const help = await runCli(['browser', 'navigate', '--help'])
  assert.equal(help.code, 0); assert.match(help.stdout, /navigate/)
  const overwriteFlag = await runCli(['browser', 'state', '--overwrite'])
  assert.equal(overwriteFlag.code, 2); assert.match(overwriteFlag.stderr, /不支持覆盖/)
  const source = join(temp, 'source.json'), target = join(temp, 'occupied.json')
  await writeFile(source, '{"ok":true}')
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, resultFile: source })) }) })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    await writeFile(target, 'do not replace')
    const copied = await runCli(['browser', 'state', '--output', target], { YAN_CLI_URL: `http://127.0.0.1:${server.address().port}`, YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's', YAN_PROJECT_ID: 'p' })
    assert.equal(copied.code, 0); assert.equal(await readFile(target, 'utf8'), 'do not replace')
    assert.match(copied.stdout, /copyError/)
  } finally { await new Promise(resolveClose => server.close(resolveClose)) }
  pass('CLI missing values report on stderr, action help works, output cannot overwrite')

  const { fileTransportOperations } = await import(pathToFileURL(resolve('resources/pi-extensions/shell-transport.js')).href + `?t=${Date.now()}`)
  const transportDir = join(temp, 'transport'); await mkdir(transportDir)
  const base = { async exec() { assert.equal((await readdir(transportDir)).length, 1); return 'closed' } }
  const ops = fileTransportOperations(base, { dir: transportDir })
  assert.equal(await ops.exec('echo ok', temp), 'closed'); assert.deepEqual(await readdir(transportDir), [])
  const broken = fileTransportOperations({ async exec() { throw new Error('process exit') } }, { dir: transportDir })
  await assert.rejects(broken.exec('echo fail', temp), /process exit/); assert.deepEqual(await readdir(transportDir), [])
  pass('shell transport removes this invocation file on normal close and rejected process exit')
  console.log(`review2 core-cli: ${checks.length} behavior checks passed`)
} finally {
  const { rm } = await import('node:fs/promises')
  await rm(temp, { recursive: true, force: true })
}
