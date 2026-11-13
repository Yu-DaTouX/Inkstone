import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import codemodePolicy, { binaryAvailable, codemodeMode, codemodeWanted, configuredIndirectMcp, searchToolsToAdd } from '../resources/pi-extensions/codemode-policy.js'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-codemode-policy-'))
process.env.YAN_DATA_DIR = dir
process.env.YAN_SESSION_ID = 'fixture'
process.env.PI_CODING_AGENT_DIR = join(dir, 'empty-agent')
const desktop = join(dir, 'desktop.json')
const GRAMMAR = { compat: { supportsOpenAIGrammarTools: true } }
const PLAIN = { compat: {} }
const save = settings => writeFile(desktop, JSON.stringify(settings))
const hooks = new Map()
let model = GRAMMAR
let active = ['read', 'bash', 'edit', 'write', 'custom']
let available = [...active, 'codemode']
let deferred = []
const pi = {
  on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]) },
  getActiveTools: () => active,
  getAllTools: () => [...available.map(name => ({ name })), ...deferred],
  setActiveTools(names) { active = [...names] }
}
const before = () => hooks.get('before_agent_start').forEach(handler => handler({}, { model }))
const blocked = () => hooks.get('tool_call').some(handler => handler({ toolName: 'codemode' })?.block)
codemodePolicy(pi)

assert.equal(codemodeMode(), 'auto', 'no settings file means auto')
before()
assert(active.includes('codemode') && active.includes('custom') && !blocked(), 'auto enables codemode for a model with grammar tools without replacing other tools')
model = PLAIN
before()
assert(!active.includes('codemode') && active.includes('custom') && !blocked(), 'auto leaves codemode off for other models without blocking calls')
model = undefined
before()
assert(!active.includes('codemode'), 'auto stays off while the model is unknown')
await save({ codemode: 'on' })
model = PLAIN
before()
assert(active.includes('codemode') && !blocked(), 'on enables codemode for any model')
await save({ codemode: 'off' })
assert(blocked(), 'a live opt-out blocks calls even before the next turn')
model = GRAMMAR
before()
assert(!active.includes('codemode') && active.includes('custom'), 'off wins over a grammar-capable model')

for (const legacy of [false, true]) {
  await save({ codemodeEnabled: legacy })
  assert.equal(codemodeMode(), 'auto', `the legacy flag (${legacy}) is ignored: everyone starts from auto`)
  model = GRAMMAR
  before()
  assert(active.includes('codemode') && !blocked())
  model = PLAIN
  before()
  assert(!active.includes('codemode') && !blocked())
}
await save({ codemodeEnabled: false, codemode: 'on' })
assert.equal(codemodeMode(), 'on', 'only the new key decides')
await save({ codemodeEnabled: true, codemode: 'off' })
assert.equal(codemodeMode(), 'off')
await save({ codemode: 'sometimes' })
assert.equal(codemodeMode(), 'auto', 'unknown values fall back to auto')
assert.equal(codemodeWanted(GRAMMAR, 'auto'), true)
assert.equal(codemodeWanted(PLAIN, 'auto'), false)
assert.equal(codemodeWanted({ compat: { supportsOpenAIGrammarTools: 'yes' } }, 'auto'), false)
assert.equal(codemodeWanted(undefined, 'on'), true)
assert.equal(codemodeWanted(GRAMMAR, 'off'), false)

model = GRAMMAR
await save({ codemode: 'auto' })
before()
assert(active.includes('codemode'))
available = available.filter(name => name !== 'codemode')
before()
assert(!active.includes('codemode'), 'native extension disable is respected')
available.push('codemode')
await writeFile(desktop, '{broken')
before()
assert(!active.includes('codemode') && blocked(), 'unreadable preference cannot undo an opt-out')

await save({ codemode: 'off' })
available.push('tool_search')
before()
assert(!active.includes('tool_search'), 'tool_search stays inactive without deferred tools')
deferred = [{ name: 'phone_ui', exposure: 'deferred' }, { name: 'phone_tap', exposure: 'deferred' }]
before()
assert(!active.includes('tool_search'), 'phone tools alone do not activate tool_search, so the fixed prefix does not grow')
deferred = [{ name: 'mcp__hosted__note', exposure: 'deferred' }]
before()
assert(active.includes('tool_search') && !active.includes('codemode') && !active.includes('mcp__hosted__note'), 'deferred tools stay reachable through tool_search when codemode is off')
active.push('mcp__hosted__note')
before()
assert(active.includes('mcp__hosted__note') && active.filter(name => name === 'tool_search').length === 1, 'tools loaded by tool_search survive the next turn without duplicating tool_search')
await save({ codemode: 'on' })
before()
assert(active.includes('tool_search') && active.includes('codemode'), 'codemode and tool_search coexist')
available = available.filter(name => name !== 'tool_search')
active = active.filter(name => name !== 'tool_search')
before()
assert(!active.includes('tool_search'), 'a replaced tool-search extension is not activated')
deferred = []

{
  const agent = join(dir, 'mcp-agent')
  const project = join(dir, 'mcp-project')
  await mkdir(agent, { recursive: true })
  await mkdir(join(project, '.pi'), { recursive: true })
  const env = { PI_CODING_AGENT_DIR: agent }
  assert.equal(configuredIndirectMcp(project, env), false, 'no mcp.json means no indirect MCP tools')
  await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { graph: { command: 'graph' } } }))
  assert.equal(configuredIndirectMcp(project, env), true, 'a default codemode server counts before it connects')
  await writeFile(join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { graph: { enabled: false } } }))
  assert.equal(configuredIndirectMcp(project, env), false, 'a project override that disables the server wins')
  assert.equal(configuredIndirectMcp(undefined, env), true, 'without a cwd only the global file counts')
  await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { graph: { command: 'graph', exposure: 'direct' }, only: { exposure: 'codemode' } } }))
  assert.equal(configuredIndirectMcp(undefined, env), false, 'direct servers and override-only entries do not count')
  await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { graph: { url: 'https://example.com', exposure: 'direct', toolExposure: { a: 'deferred' } } } }))
  assert.equal(configuredIndirectMcp(undefined, env), true, 'a single deferred tool counts')
  await writeFile(join(agent, 'mcp.json'), '{broken')
  assert.equal(configuredIndirectMcp(undefined, env), false, 'an unreadable mcp.json counts as none')

  process.env.PI_CODING_AGENT_DIR = agent
  await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { graph: { command: 'graph' } } }))
  await save({ codemode: 'off' })
  available.push('tool_search')
  active = active.filter(name => name !== 'tool_search')
  before()
  assert(active.includes('tool_search'), 'tool_search is active on the first turn, before the MCP server connects, so the tool list does not change later')
  process.env.PI_CODING_AGENT_DIR = join(dir, 'empty-agent')
  available = available.filter(name => name !== 'tool_search')
  active = active.filter(name => name !== 'tool_search')
}

{
  const has = (...names) => (name) => names.includes(name)
  assert.deepEqual(searchToolsToAdd(['read', 'bash'], has('grep', 'find', 'ls'), has('rg', 'fd')), ['grep', 'find', 'ls'], 'rg/fd 都在时候选是 grep/find/ls')
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
  const path = process.env.PATH
  process.env.PATH = ''
  process.env.PI_CODING_AGENT_DIR = join(dir, 'pi-agent')
  let tools = ['read', 'bash', 'edit', 'write']
  const session = (all) => {
    const loaded = new Map()
    codemodePolicy({
      on(name, handler) { loaded.set(name, handler) },
      getActiveTools: () => tools,
      getAllTools: () => all.map(name => ({ name })),
      setActiveTools(names) { tools = [...names] }
    })
    return (current) => loaded.get('before_agent_start')({}, { model: current })
  }

  await save({ codemode: 'on' })
  const noCodemode = session(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  noCodemode(GRAMMAR)
  assert(tools.includes('grep'), 'pi 下载目录里有 rg 就开 grep')
  assert(!tools.includes('ls') && !tools.includes('find'), '没有 codemode 时不补 ls/find')
  tools = tools.filter(name => name !== 'read')
  noCodemode(GRAMMAR)
  assert(!tools.includes('read'), '受限工具集保持原样')

  tools = ['read', 'bash', 'edit', 'write', 'codemode']
  const withCodemode = session(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'codemode'])
  withCodemode(PLAIN)
  assert(tools.includes('codemode') && tools.includes('grep') && tools.includes('ls') && !tools.includes('find'), 'codemode 开着时补齐 grep 与 ls，缺 fd 不开 find')
  assert.equal(tools.filter(name => name === 'codemode').length, 1)
  await save({ codemode: 'off' })
  withCodemode(PLAIN)
  assert(!tools.includes('codemode') && !tools.includes('ls') && tools.includes('grep'), '关掉 codemode 后收回自己补的 ls，grep 保留')
  await save({ codemode: 'auto' })
  withCodemode(PLAIN)
  assert(!tools.includes('codemode') && !tools.includes('ls'), '自动模式下不支持的模型保持关闭')
  withCodemode(GRAMMAR)
  assert(tools.includes('codemode') && tools.includes('ls') && tools.includes('grep'), '换到支持的模型后重新补齐')

  tools = ['read', 'bash', 'ls']
  const preset = session(['read', 'bash', 'grep', 'find', 'ls', 'codemode'])
  preset(PLAIN)
  assert(tools.includes('ls') && tools.includes('grep') && !tools.includes('codemode'), '原本就在活动工具里的 ls 不收回')
  delete process.env.PI_CODING_AGENT_DIR
  process.env.PATH = path
}

await save({ theme: 'light', codemodeEnabled: false })
const outfile = resolve('out/test/codemode-settings.mjs')
await build({ entryPoints: ['src/main/settings.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'electron-locale', setup(build) {
  build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app = { getLocale: () => "zh-CN" };', loader: 'js' }))
} }] })
const settings = await import(pathToFileURL(outfile))
const migratedOff = await settings.getSettings()
assert.equal(migratedOff.codemode, 'auto', 'a saved legacy opt-out is overridden by the new default')
assert.equal('codemodeEnabled' in migratedOff, false, 'the legacy flag is not carried forward')
await save({ theme: 'light', codemodeEnabled: true })
assert.equal((await settings.patchSettings({ theme: 'dark' })).codemode, 'auto', 'the old default-on flag migrates to auto')
const migrated = JSON.parse(await readFile(desktop, 'utf8'))
assert.equal(migrated.codemode, 'auto')
assert.equal('codemodeEnabled' in migrated, false, 'the legacy flag is dropped on the next save')
assert.equal((await settings.patchSettings({ codemode: 'off' })).codemode, 'off')
await settings.patchSettings({ theme: 'light' })
assert.equal(JSON.parse(await readFile(desktop, 'utf8')).codemode, 'off', 'an unrelated patch preserves the explicit opt-out')
assert.equal((await settings.patchSettings({ codemode: 'on' })).codemode, 'on')
assert.equal((await settings.patchSettings({ codemode: 'invalid' })).codemode, 'auto')
assert.throws(() => settings.validateRendererSettingsPatch({ codemodeEnabled: true }), 'the renderer can no longer write the legacy flag')
assert.deepEqual(settings.validateRendererSettingsPatch({ codemode: 'on' }), { codemode: 'on' })
console.log(`PASS: Codemode auto/on/off, legacy migration, hot toggle, execution gate, native disable, fail-closed settings, codemode-only search tools, deferred-tool search and persistence; isolated data: ${dir}`)
