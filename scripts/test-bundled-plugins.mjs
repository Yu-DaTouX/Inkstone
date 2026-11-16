import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-bundled-plugins-'))
const env = { ...process.env }
let plugins, server
let checks = 0
const ok = (value, message) => { assert.ok(value, message); checks++ }
try {
  const bundle = join(root, 'host.mjs')
  await build({ stdin: { contents: "export * from './src/main/bundled-plugins.ts'; export { CapabilityServer } from './src/main/capability-server.ts'", resolveDir: process.cwd(), sourcefile: 'plugin-interface.ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { BundledPlugins, CapabilityServer, pluginEnvironment, pluginConfiguredEnvironment, pluginRunEvent } = await import(pathToFileURL(bundle).href)
  const clean = pluginEnvironment({ PATH: 'fixture', OPENAI_API_KEY: 'secret', YAN_REMOTE_TOKEN: 'secret', NODE_OPTIONS: '--require unsafe' })
  assert.deepEqual(clean, { PATH: 'fixture' }); checks++
  assert.deepEqual(pluginConfiguredEnvironment(['YAN_COMFYUI_DIR', 'YAN_REMOTE_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'], { YAN_COMFYUI_DIR: 'fixture', YAN_REMOTE_TOKEN: 'secret', NODE_OPTIONS: 'inject', ELECTRON_RUN_AS_NODE: '1' }), { YAN_COMFYUI_DIR: 'fixture' }); checks++
  const event = pluginRunEvent({ upsert: [{ runId: 'r1', sessionId: 's1', kind: 'session', prompt: 'secret', phase: { kind: 'needs-you', request: { id: 'a', summary: 'secret', arguments: 'secret' } } }], remove: [] })
  ok(!JSON.stringify(event).includes('secret'), 'run subscription excludes text, approval details and tool arguments')
  const sources = join(root, 'sources'), source = join(sources, 'fixture'), dataDir = join(root, 'data')
  await mkdir(join(source, 'skills', 'fixture'), { recursive: true }); await mkdir(dataDir)
  await writeFile(join(source, 'inkstone-plugin.json'), JSON.stringify({ id: 'fixture', version: '1', process: 'plugin.mjs', extension: 'extension.mjs', skills: ['fixture'], capabilities: ['runs', 'text.complete', 'window.show'], publicActions: ['echo', 'hang'], commands: { 'fixture.echo': 'echo' } }))
  await writeFile(join(source, 'extension.mjs'), 'export default function() {}')
  await writeFile(join(source, 'skills', 'fixture', 'SKILL.md'), 'fixture')
  await writeFile(join(source, 'plugin.mjs'), `
let event
let seq = 0
const pending = new Map()
function capability(capability, params) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); process.send({ type: 'capability', id, capability, params }) })
}
process.on('message', async message => {
  if (message.type === 'event') event = message.payload
  if (message.type === 'capability-result') {
    const p = pending.get(message.id); if (p) { pending.delete(message.id); if (message.error) p.reject(new Error(message.error)); else p.resolve(message.value) }
  }
  if (message.type !== 'request') return
  try {
    let value
    if (message.action === 'hang') return
    else if (message.action === 'status') value = { installed: true, event }
    else if (message.action === 'echo') value = message.params
    else if (message.action === 'environment') value = { secret: process.env.OPENAI_API_KEY, remote: process.env.YAN_REMOTE_TOKEN }
    else if (message.action === 'complete') value = await capability('text.complete', { model: 'fixture/model', system: '', prompt: 'hi' })
    else if (message.action === 'denied') value = await capability('secrets.read', {})
    else if (message.action === 'window') value = await capability('window.show', {})
    else throw new Error('unknown')
    process.send({ type: 'response', id: message.id, value })
  } catch (error) { process.send({ type: 'response', id: message.id, error: error.message }) }
})
process.on('disconnect', () => process.exit(0))
process.send({ type: 'ready' })
`)
  process.env.OPENAI_API_KEY = 'fixture-secret'
  process.env.YAN_REMOTE_TOKEN = 'fixture-remote-token'
  let shown = 0, completions = 0
  plugins = new BundledPlugins({ sources: [join(root, 'missing'), sources], dataDir, runtime: process.execPath, complete: async (model, system, prompt) => { completions++; assert.equal(model, 'fixture/model'); return prompt + '-done' }, showWindow: () => { shown++ } })
  assert.deepEqual(plugins.extensionPaths(), []); checks++
  ok(!(await plugins.action('../outside', 'install')).ok, 'reject traversal plugin identifiers')
  ok(!(await plugins.action('unknown', 'install')).ok, 'reject unknown source')
  ok((await plugins.action('fixture', 'status')).installed === false, 'status does not execute uninstalled plugins')
  ok((await plugins.action('fixture', 'install')).ok, 'copy and start a bundled plugin')
  ok(plugins.extensionPaths().length === 1 && plugins.skillPaths().length === 1, 'generic pi extension and skill discovery')
  assert.deepEqual(await plugins.invoke('fixture', 'environment'), {}); checks++
  assert.deepEqual(await plugins.invoke('fixture', 'echo', { hello: 1 }), { hello: 1 }); checks++
  ok(await plugins.invoke('fixture', 'complete') === 'hi-done' && completions === 1, 'scoped text completion works without exporting credentials')
  await assert.rejects(plugins.invoke('fixture', 'denied'), /未授权/); checks++
  await plugins.invoke('fixture', 'window'); ok(shown === 1, 'declared window capability')
  await assert.rejects(plugins.command('plugin.invoke', { plugin: 'fixture', action: 'complete' }, { cwd: resolve(root) }), /没有公开/); checks++
  const result = await plugins.command('fixture.echo', { value: 1 }, { cwd: resolve(root) })
  ok(result.data.input.value === 1 && result.data.context.cwd === resolve(root), 'legacy aliases resolve through manifests with host-owned context')
  let hostCalls = 0
  server = new CapabilityServer({ opsDir: join(root, 'ops'), handlers: { run: (command, params, _context, signal) => {
    hostCalls++
    return plugins.command(command, params, { cwd: resolve(root) }, signal)
  } } })
  const endpoint = await server.start({ sessionId: 'session', projectId: 'project' })
  const post = (token, sessionId = 'session') => fetch(endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, sessionId, projectId: 'project', command: 'plugin.invoke', params: { plugin: 'fixture', action: 'echo', input: { probe: true } } })
  })
  ok((await post('wrong-token')).status === 401, 'plugin API rejects wrong token')
  ok((await post(endpoint.token, 'other-session')).status === 403, 'plugin API rejects a foreign session')
  ok(hostCalls === 0, 'invalid identity never reaches plugin execution')
  const response = await (await post(endpoint.token)).json()
  const apiResult = JSON.parse(await readFile(response.resultFile, 'utf8'))
  ok(response.ok && apiResult.input.probe === true && apiResult.context.cwd === resolve(root) && hostCalls === 1, 'authenticated capability API reaches the plugin using host-owned project context')
  server.stop()
  const cancel = new AbortController()
  const hang = plugins.command('plugin.invoke', { plugin: 'fixture', action: 'hang' }, { cwd: resolve(root) }, cancel.signal)
  const rejected = assert.rejects(hang, /取消/)
  cancel.abort(); await rejected; checks++
  plugins.publishRuns({ upsert: [{ runId: 'r1', sessionId: 's1', kind: 'session', text: 'private', phase: { kind: 'done' } }], remove: [] })
  const status = await plugins.invoke('fixture', 'status')
  ok(status.event.upsert[0].runId === 'r1' && !JSON.stringify(status.event).includes('private'), 'process receives redacted events')
  const userFile = join(dataDir, 'plugins', 'fixture', 'user-data.json')
  await writeFile(userFile, 'keep')
  ok((await plugins.action('fixture', 'install')).ok && await readFile(userFile, 'utf8') === 'keep', 'updates preserve user data')
  ok((await plugins.action('fixture', 'remove')).ok && await readFile(userFile, 'utf8') === 'keep', 'removal preserves user data')
  ok(plugins.extensionPaths().length === 0 && !existsSync(join(dataDir, 'plugins', 'fixture', 'plugin')), 'removal unregisters code, extension and skill')
  await mkdir(join(dataDir, 'plugins', 'fixture', 'plugin'))
  await writeFile(join(dataDir, 'plugins', 'fixture', 'plugin', 'unowned'), 'keep')
  ok(!(await plugins.action('fixture', 'install')).ok, 'unowned installation directory is not overwritten')

  const proxied = join(sources, 'proxied')
  await mkdir(proxied)
  await writeFile(join(proxied, 'inkstone-plugin.json'), JSON.stringify({ id: 'proxied', version: '1', process: 'plugin.mjs', capabilities: ['system.proxy'] }))
  await writeFile(join(proxied, 'plugin.mjs'), `
process.on('message', message => {
  if (message.type === 'request') process.send({ type: 'response', id: message.id, value: { pid: process.pid, proxy: process.env.HTTPS_PROXY ?? null } })
})
process.on('disconnect', () => process.exit(0))
process.send({ type: 'ready' })
`)
  const proxyHost = () => new BundledPlugins({ sources: [sources], dataDir, runtime: process.execPath, complete: async () => '', showWindow: () => undefined, proxyEnvironment: async () => ({ HTTPS_PROXY: 'http://127.0.0.1:9' }) })
  const installer = proxyHost()
  ok((await installer.action('proxied', 'install')).ok && installer.installed('proxied') && !installer.installed('fixture'), 'installed() reflects the install marker')
  installer.close()
  const fresh = proxyHost()
  const [first, second] = await Promise.all([fresh.invoke('proxied', 'probe'), fresh.invoke('proxied', 'probe')])
  ok(first.pid === second.pid, 'concurrent first calls share one plugin process')
  ok(first.proxy === 'http://127.0.0.1:9', 'plugins declaring system.proxy receive the system proxy')
  await fresh.close()
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  ok(!alive(first.pid), 'close() 返回 Promise，resolve 时插件进程已结束')

  const upgradeSource = join(sources, 'upgrade')
  await mkdir(upgradeSource)
  const writeUpgrade = async (version, setup) => {
    await writeFile(join(upgradeSource, 'inkstone-plugin.json'), JSON.stringify({ id: 'upgrade', version, process: 'plugin.mjs', setup: 'setup', publicActions: [] }))
    await writeFile(join(upgradeSource, 'version.txt'), version)
    await writeFile(join(upgradeSource, 'plugin.mjs'), `
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const version = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'version.txt'), 'utf8')
process.on('message', message => {
  if (message.type !== 'request') return
  if (message.action === 'setup') {
    ${setup}
  }
  process.send({ type: 'response', id: message.id, value: message.action === 'status' ? { version, pid: process.pid } : { ok: true } })
})
process.on('disconnect', () => process.exit(0))
process.send({ type: 'ready' })
`)
  }
  const upgradeHost = new BundledPlugins({ sources: [sources], dataDir, runtime: process.execPath, complete: async () => '', showWindow: () => undefined })
  const installedVersion = async () => (await readFile(join(dataDir, 'plugins', 'upgrade', 'plugin', 'version.txt'), 'utf8'))
  const leftovers = async () => (await import('node:fs/promises')).readdir(join(dataDir, 'plugins', 'upgrade')).then(names => names.filter(name => /\.(old|new)$/.test(name)))
  await writeUpgrade('v1', '')
  const installV1 = await upgradeHost.action('upgrade', 'install')
  ok(installV1.ok && installV1.status.version === 'v1', '升级基线：v1 安装成功')
  const pidV1 = installV1.status.pid

  await writeUpgrade('v2', "process.send({ type: 'response', id: message.id, value: { ok: false, error: 'setup refused' } }); return")
  const refused = await upgradeHost.action('upgrade', 'install')
  ok(!refused.ok && refused.installed === true && /setup refused/.test(refused.error), '升级 setup 返回失败：报告失败并带原因', refused.error)
  ok(await installedVersion() === 'v1' && (await leftovers()).length === 0, '升级 setup 失败：旧版本目录恢复，没有残留 .old/.new')
  const afterRefused = await upgradeHost.invoke('upgrade', 'status')
  ok(afterRefused.version === 'v1' && afterRefused.pid !== pidV1, '升级 setup 失败：旧版本进程已重启并可调用')

  await writeUpgrade('v3', "console.error('setup exploded: missing dependency'); process.exit(3)")
  const crashed = await upgradeHost.action('upgrade', 'install')
  ok(!crashed.ok && /setup exploded: missing dependency/.test(crashed.error) && /已退出|exited/.test(crashed.error), '升级时插件进程崩溃：错误里附带 stderr 尾部', crashed.error)
  ok(await installedVersion() === 'v1' && (await leftovers()).length === 0, '升级时插件进程崩溃：恢复旧版本')
  ok((await upgradeHost.invoke('upgrade', 'status')).version === 'v1', '升级时插件进程崩溃：旧进程重启')

  await writeUpgrade('v4', '')
  const upgraded = await upgradeHost.action('upgrade', 'install')
  ok(upgraded.ok && upgraded.status.version === 'v4' && await installedVersion() === 'v4' && (await leftovers()).length === 0, '升级成功：新版本生效，旧版本目录删除')

  if (process.platform === 'win32') {
    const orphan = join(sources, 'orphan')
    await mkdir(orphan)
    await writeFile(join(orphan, 'inkstone-plugin.json'), JSON.stringify({ id: 'orphan', version: '1', process: 'plugin.mjs' }))
    await writeFile(join(orphan, 'plugin.mjs'), `
import { spawn } from 'node:child_process'
process.on('message', message => {
  if (message.type !== 'request') return
  if (message.action !== 'orphan') { process.send({ type: 'response', id: message.id, value: {} }); return }
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  process.send({ type: 'response', id: message.id, value: { grandchild: grandchild.pid, pid: process.pid } })
  setTimeout(() => process.disconnect(), 100)
})
process.send({ type: 'ready' })
`)
    const orphanHost = new BundledPlugins({ sources: [sources], dataDir, runtime: process.execPath, complete: async () => '', showWindow: () => undefined })
    ok((await orphanHost.action('orphan', 'install')).ok, '进程树基线：安装成功')
    const spawned = await orphanHost.invoke('orphan', 'orphan')
    await new Promise(resolve => setTimeout(resolve, 600))
    ok(alive(spawned.pid) && alive(spawned.grandchild), '进程树基线：插件已断开 IPC 但进程与子进程都还在')
    await orphanHost.close()
    await new Promise(resolve => setTimeout(resolve, 300))
    ok(!alive(spawned.pid) && !alive(spawned.grandchild), 'IPC 已断开的插件被关闭时在 win32 上结束整棵进程树')
  }
  await upgradeHost.close()
  console.log(`bundled-plugins: ${checks} checks passed (isolated subprocess, no network/model)`)
} finally {
  server?.stop()
  plugins?.close()
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]
  Object.assign(process.env, env)
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
