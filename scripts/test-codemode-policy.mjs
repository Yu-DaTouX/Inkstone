import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import codemodePolicy, { binaryAvailable, searchToolsToAdd } from '../resources/pi-extensions/codemode-policy.js'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-codemode-policy-'))
process.env.YAN_DATA_DIR = dir
process.env.YAN_SESSION_ID = 'fixture'
const desktop = join(dir, 'desktop.json')
const hooks = new Map()
let active = ['read', 'bash', 'edit', 'write', 'custom']
let available = [...active, 'codemode']
let deferred = []
const pi = {
  on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]) },
  getActiveTools: () => active,
  getAllTools: () => [...available.map(name => ({ name })), ...deferred],
  setActiveTools(names) { active = [...names] }
}
const before = () => hooks.get('before_agent_start').forEach(handler => handler({}))
const blocked = () => hooks.get('tool_call').some(handler => handler({ toolName: 'codemode' })?.block)
codemodePolicy(pi)
before()
assert(active.includes('codemode') && active.includes('custom'), 'default enables codemode without replacing other tools')
await writeFile(desktop, JSON.stringify({ codemodeEnabled: false }))
assert(blocked(), 'a live opt-out blocks calls even before the next turn')
active.push('codemode')
before()
assert(!active.includes('codemode') && active.includes('custom'))
await writeFile(desktop, JSON.stringify({ codemodeEnabled: true }))
before()
assert(active.includes('codemode') && !blocked())
await writeFile(desktop, JSON.stringify({ codemodeEnabled: true }))
available = available.filter(name => name !== 'codemode')
before()
assert(!active.includes('codemode'), 'native extension disable is respected')
available.push('codemode')
await writeFile(desktop, '{broken')
before()
assert(!active.includes('codemode') && blocked(), 'unreadable preference cannot undo an opt-out')

await writeFile(desktop, JSON.stringify({ codemodeEnabled: false }))
available.push('tool_search')
before()
assert(!active.includes('tool_search'), 'tool_search stays inactive without deferred tools')
deferred = [{ name: 'mcp__hosted__note', exposure: 'deferred' }]
before()
assert(active.includes('tool_search') && !active.includes('codemode') && !active.includes('mcp__hosted__note'), 'deferred tools stay reachable through tool_search when codemode is off')
active.push('mcp__hosted__note')
before()
assert(active.includes('mcp__hosted__note') && active.filter(name => name === 'tool_search').length === 1, 'tools loaded by tool_search survive the next turn without duplicating tool_search')
await writeFile(desktop, JSON.stringify({ codemodeEnabled: true }))
before()
assert(active.includes('tool_search') && active.includes('codemode'), 'codemode and tool_search coexist')
available = available.filter(name => name !== 'tool_search')
active = active.filter(name => name !== 'tool_search')
before()
assert(!active.includes('tool_search'), 'a replaced tool-search extension is not activated')
deferred = []

{
  const has = (...names) => (name) => names.includes(name)
  assert.deepEqual(searchToolsToAdd(['read', 'bash'], has('grep', 'find', 'ls'), has('rg', 'fd')), ['grep', 'find', 'ls'], 'rg/fd 都在时开 grep/find/ls')
  assert.deepEqual(searchToolsToAdd(['read', 'bash'], has('grep', 'find', 'ls'), has()), ['ls'], '缺 rg/fd 时不开，免得调用时现场下载')
  assert.deepEqual(searchToolsToAdd(['read', 'grep', 'bash'], has('grep', 'find', 'ls'), has('rg', 'fd')), ['find', 'ls'], '已有的不重复')
  assert.deepEqual(searchToolsToAdd(['bash'], has('grep', 'find', 'ls'), has('rg', 'fd')), [], '没有 read 的受限工具集不扩')
  assert.deepEqual(searchToolsToAdd(['read'], has(), has('rg', 'fd')), [], '工具未注册不开')

  const bin = join(dir, 'pi-agent', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'rg.exe'), '')
  assert.equal(binaryAvailable('rg', { PI_CODING_AGENT_DIR: join(dir, 'pi-agent'), PATH: '' }, 'win32'), true, 'pi 下载目录里的 rg 可用')
  assert.equal(binaryAvailable('fd', { PI_CODING_AGENT_DIR: join(dir, 'pi-agent'), PATH: '' }, 'win32'), false)
  assert.equal(binaryAvailable('rg', { PI_CODING_AGENT_DIR: join(dir, 'none'), PATH: bin }, 'win32'), true, 'PATH 里的 rg 可用')

  await writeFile(join(bin, 'rg'), '')
  let tools = ['read', 'bash', 'edit', 'write']
  const loaded = new Map()
  const path = process.env.PATH
  process.env.PATH = ''
  process.env.PI_CODING_AGENT_DIR = join(dir, 'pi-agent')
  codemodePolicy({
    on(name, handler) { loaded.set(name, handler) },
    getActiveTools: () => tools,
    getAllTools: () => ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].map(name => ({ name })),
    setActiveTools(names) { tools = [...names] }
  })
  loaded.get('before_agent_start')({})
  assert(tools.includes('grep'), 'pi 下载目录里有 rg 就开 grep')
  assert(tools.includes('ls') && !tools.includes('find'), '缺 fd 不开 find，ls 无依赖照开')
  tools = tools.filter(name => name !== 'read')
  loaded.get('before_agent_start')({})
  assert(!tools.includes('read'), '受限工具集保持原样')
  delete process.env.PI_CODING_AGENT_DIR
  process.env.PATH = path
}

await writeFile(desktop, JSON.stringify({ theme: 'light' }))
const outfile = resolve('out/test/codemode-settings.mjs')
await build({ entryPoints: ['src/main/settings.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'electron-locale', setup(build) {
  build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app = { getLocale: () => "zh-CN" };', loader: 'js' }))
} }] })
const settings = await import(pathToFileURL(outfile))
assert.equal((await settings.getSettings()).codemodeEnabled, true, 'existing settings migrate to default on')
assert.equal((await settings.patchSettings({ codemodeEnabled: false })).codemodeEnabled, false)
await settings.patchSettings({ theme: 'dark' })
assert.equal(JSON.parse(await readFile(desktop, 'utf8')).codemodeEnabled, false, 'an unrelated patch preserves the explicit opt-out')
assert.equal((await settings.patchSettings({ codemodeEnabled: true })).codemodeEnabled, true)
assert.equal((await settings.patchSettings({ codemodeEnabled: 'invalid' })).codemodeEnabled, true)
console.log(`PASS: Codemode default, hot toggle, execution gate, plan restore, native disable, fail-closed settings, deferred-tool search and persistence; isolated data: ${dir}`)
