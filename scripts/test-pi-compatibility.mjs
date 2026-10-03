import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { comparePiVersions, requirePiUpgrade } from './lib/pi-upgrade-policy.mjs'
import * as danger from '../resources/pi-extensions/danger-guard.js'
import profile from '../resources/pi-extensions/profile.js'
import { runDangerGuardTests } from './test-danger-guard.mjs'

let checks = 0
const check = (condition, message) => { assert(condition, message); checks++ }
const root = await mkdtemp(join(tmpdir(), 'inkstone-pi-compat-'))
const modules = {}
for (const [name, file] of Object.entries({ normalize: 'src/main/normalize.ts', tree: 'src/shared/tool-call-tree.ts' })) {
  const outfile = resolve(`out/test/pi-compat-${name}.mjs`)
  await build({ entryPoints: [resolve(file)], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  modules[name] = await import(pathToFileURL(outfile))
}
runDangerGuardTests(check, danger)
check(comparePiVersions('0.99.10', '0.99.2') > 0, 'numeric patch ordering')
check(comparePiVersions('1.0.0', '0.99.2') > 0, 'major release ordering')
check(comparePiVersions('0.99.2-rc.10', '0.99.2-rc.2') > 0, 'numeric prerelease ordering')
check(comparePiVersions('0.99.2+build', '0.99.2') === 0, 'build metadata does not downgrade')
check(comparePiVersions('0.99.2-rc.1', '0.99.2') < 0, 'prerelease is older')
for (const version of ['unknown', '0.99', '0.99.2-beta..1', '0.99.2-01']) assert.throws(() => requirePiUpgrade('0.99.1', version))
assert.throws(() => requirePiUpgrade('0.99.2', '0.87.1'), /拒绝/)
requirePiUpgrade('0.99.2', '0.87.1', true)
requirePiUpgrade(undefined, '0.99.2')
requirePiUpgrade('0.99.1', '0.99.2')
const fakeSource = join(root, 'old-source')
await mkdir(join(fakeSource, 'dist/bundle'), { recursive: true })
await writeFile(join(fakeSource, 'package.json'), JSON.stringify({ version: '0.0.0' }))
await writeFile(join(fakeSource, 'dist/bundle/cli.js'), '// deliberately unusable old source')
const currentManifest = resolve('resources/pi-runtime/current.json')
const before = await readFile(currentManifest).catch(() => null)
if (before) {
  for (const [file, args] of [['scripts/upgrade-pi.mjs', ['--force']], ['scripts/vendor-pi.mjs', []]]) {
    const blocked = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, YAN_PI_SRC: fakeSource }, timeout: 10000 })
    check(blocked.status === 1 && /拒绝.*降级/.test(blocked.stdout + blocked.stderr), `${file} rejects downgrade before extraction`)
    check((await readFile(currentManifest)).equals(before), 'rejected downgrade preserves selected generation')
  }
}

const { normalizeHistory, collapseSkillInvocation } = modules.normalize
const skillBody = ['<skill name="capabilities" location="C:/repo/SKILL.md">', 'References are relative.', '', '# body', '</skill>'].join(String.fromCharCode(10))
check(collapseSkillInvocation(skillBody) === '/skill:capabilities', 'skill block collapses to the typed command')
check(collapseSkillInvocation(skillBody + String.fromCharCode(10, 10) + '找个画图能力') === '/skill:capabilities 找个画图能力', 'skill block keeps the user arguments')
check(collapseSkillInvocation('<skill name="x"> not a pi block') === '<skill name="x"> not a pi block', 'non-matching text is left alone')
check(normalizeHistory([{ role: 'user', content: [{ type: 'text', text: skillBody }], timestamp: 1 }])[0].text === '/skill:capabilities', 'history shows the collapsed skill command')
const parent = { role: 'assistant', content: [{ type: 'toolCall', id: 'code', name: 'codemode', arguments: { code: 'fixture' } }], timestamp: 1 }
const result = { role: 'toolResult', toolCallId: 'code', toolName: 'codemode', content: [{ type: 'text', text: 'selected output' }], details: { truncated: true }, nestedCalls: { complete: false, calls: [
  { id: 'code/1', name: 'read', arguments: { path: 'a.txt' }, status: 'ok', durationMs: 3 },
  { id: 'code/2', name: 'powershell', arguments: { command: 'fixture' }, status: 'error', error: 'blocked' },
  { id: 'code/2/1', name: 'read', status: 'unfinished' },
  { id: 'unrelated', name: 'write', status: 'ok' },
  { id: 'code/1', name: 'duplicate', status: 'ok' },
  null
] }, timestamp: 2 }
const history = normalizeHistory([{ role: 'system', content: 'prompt' }, parent, result], undefined, ['system', 'assistant-entry', 'result-entry'])
check(history.length === 1 && history[0].entryId === 'assistant-entry', 'nested summaries preserve message and fork anchor')
const calls = history[0].toolCalls
check(calls.length === 4 && calls[1].parentToolCallId === 'code', 'bounded summaries restore valid unique children')
check(calls[3].parentToolCallId === 'code/2' && calls[3].incomplete === true && !calls[3].cancelled, 'unfinished record does not claim a user cancellation')
check(calls[0].nestedCallsIncomplete === true && calls[1].historySummary === true, 'incomplete and summary-only records are explicit')
check(calls[1].output === undefined && calls[2].output === 'blocked', 'history does not invent successful child output')
check(calls[0].details.truncated === true && calls[0].output === 'selected output', 'parent result details restored')
check(normalizeHistory([result])[0].toolCalls.length === 4, 'orphan parent result retains nested summary')
check(normalizeHistory([parent, { ...result, nestedCalls: { calls: 'bad' } }])[0].toolCalls.length === 1, 'malformed nested record safely ignored')
const many = Array.from({ length: 300 }, (_, i) => ({ id: `code/${i + 1}`, name: 'read', status: 'ok' }))
check(normalizeHistory([parent, { ...result, nestedCalls: { calls: many } }])[0].toolCalls.length === 257, 'at most 256 child summaries restored')
const tree = modules.tree.projectToolCallTree(calls, new Set(['code/2/1']))
check(tree.map(row => row.call.id).join(',') === 'code,code/2,code/2/1' && tree[2].depth === 2, 'visible nested child retains ancestor order')
const cycle = [{ id: 'a', parentToolCallId: 'b', name: 'read' }, { id: 'b', parentToolCallId: 'a', name: 'read' }]
check(modules.tree.projectToolCallTree(cycle, new Set(['a'])).length === 2, 'cyclic history cannot hang the renderer')

const previous = { data: process.env.YAN_DATA_DIR, session: process.env.YAN_SESSION_ID }
try {
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'runner'
  await mkdir(join(root, 'agent-profile'))
  const snapshot = join(root, 'agent-profile/runner.json')
  await writeFile(snapshot, JSON.stringify({ profile: 'daily', activity: 'research', deniedTools: ['mcp__fixture__echo'] }))
  const hooks = new Map()
  profile({ on: (name, fn) => hooks.set(name, fn) })
  check(hooks.get('tool_call')({ toolName: 'mcp__fixture__echo', parentToolCallId: 'code' }).block === true, 'profile blocks undeclared nested tools at execution')
  check(hooks.get('tool_call')({ toolName: 'read' }) === undefined, 'profile allows unrelated tools')
  await writeFile(snapshot, JSON.stringify({ profile: 'daily', activity: 'compose', deniedTools: [] }))
  check(hooks.get('tool_call')({ toolName: 'mcp__fixture__echo' }) === undefined, 'execution rechecks changed policy')
} finally {
  for (const [name, value] of [['YAN_DATA_DIR', previous.data], ['YAN_SESSION_ID', previous.session]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
}
console.log(`PASS: ${checks} assertions plus version rejection cases; pi upgrade, shell guard, nested history/tree and deferred-tool policy`)
