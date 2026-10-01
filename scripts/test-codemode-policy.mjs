import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import codemodePolicy from '../resources/pi-extensions/codemode-policy.js'
import workMode from '../resources/pi-extensions/work-mode.js'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-codemode-policy-'))
process.env.YAN_DATA_DIR = dir
process.env.YAN_SESSION_ID = 'fixture'
const desktop = join(dir, 'desktop.json')
const hooks = new Map()
let active = ['read', 'bash', 'edit', 'write', 'custom']
let available = [...active, 'codemode']
const pi = {
  on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]) },
  getActiveTools: () => active,
  getAllTools: () => available.map(name => ({ name })),
  setActiveTools(names) { active = [...names] }
}
const before = () => hooks.get('before_agent_start').forEach(handler => handler({}))
const blocked = () => hooks.get('tool_call').some(handler => handler({ toolName: 'codemode' })?.block)
codemodePolicy(pi)
workMode(pi)
before()
assert(active.includes('codemode') && active.includes('custom'), 'default enables codemode without replacing other tools')
await writeFile(desktop, JSON.stringify({ codemodeEnabled: false }))
assert(blocked(), 'a live opt-out blocks calls even before the next turn')
active.push('codemode') // MCP or a restored session may reactivate the tool.
before()
assert(!active.includes('codemode') && active.includes('custom'))
await writeFile(desktop, JSON.stringify({ codemodeEnabled: true }))
before()
assert(active.includes('codemode') && !blocked())
await mkdir(join(dir, 'work-mode'))
const modeFile = join(dir, 'work-mode', 'fixture.json')
await writeFile(modeFile, JSON.stringify({ mode: 'clarify' }))
before()
assert(!active.includes('codemode') && !active.includes('write') && blocked())
await writeFile(desktop, JSON.stringify({ codemodeEnabled: false }))
await writeFile(modeFile, JSON.stringify({ mode: 'standard' }))
before()
assert(!active.includes('codemode') && active.includes('write') && active.includes('custom'), 'plan exit does not restore a disabled codemode')
await writeFile(desktop, JSON.stringify({ codemodeEnabled: true }))
available = available.filter(name => name !== 'codemode')
before()
assert(!active.includes('codemode'), 'native extension disable is respected')
available.push('codemode')
await writeFile(desktop, '{broken')
before()
assert(!active.includes('codemode') && blocked(), 'unreadable preference cannot undo an opt-out')

// Exercise the actual settings store with an isolated directory and a locale stub.
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
console.log(`PASS: Codemode default, hot toggle, execution gate, plan restore, native disable, fail-closed settings and persistence; isolated data: ${dir}`)
