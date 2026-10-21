import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'
import ts from 'typescript'
import { defaultLiveCases, localProviderCases, validateSyntheticSelection, syntheticEnvironment } from './lib/live-synthetic-isolation.mjs'

assert.deepEqual(defaultLiveCases({ ui: { cost: 0 }, paid: { cost: 1 }, quota: { cost: 0, needsCredentials: true }, install: { cost: 0, needsDownload: true } }), ['ui'])
const owned = {
  ui: { cost: 0 },
  isolation: { cost: 0, abSessions: true },
  hardkill: { cost: 0, hardKillAfterIntermediateTiming: true },
  restarting: { cost: 0, restart: { probe: 'scripts/probe/x.js' } }
}
assert.deepEqual(defaultLiveCases(owned), ['ui'], '默认集合不选独占本机 provider fixture 的场景')
assert.deepEqual(localProviderCases(['ui', 'isolation', 'hardkill', 'restarting'], owned), ['isolation', 'hardkill', 'restarting'])
assert.deepEqual(localProviderCases(['ui', 'missing'], owned), [], '没有场景表条目的名字不算独占 provider')
assert.deepEqual(
  localProviderCases(defaultLiveCases(owned), owned),
  [],
  '默认集合不会触发「本机 provider fixture 场景请分开运行」'
)
assert.doesNotThrow(() => validateSyntheticSelection(['ui'], { ui: { cost: 0 } }, true))
assert.throws(() => validateSyntheticSelection(['ui'], { ui: { cost: 0 } }, false), /isolated/)
assert.throws(() => validateSyntheticSelection(['model'], { model: { cost: 1 } }, true), /model-dependent/)
assert.throws(() => validateSyntheticSelection(['missing'], {}, true), /model-dependent/)
assert.throws(() => validateSyntheticSelection(['quota'], { quota: { cost: 0, needsCredentials: true } }, true), /model-dependent/)
const env = { PATH: 'keep', YAN_TEST_SYNTHETIC_ONLY: '1', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret',
  GOOGLE_APPLICATION_CREDENTIALS: 'personal.json', AWS_PROFILE: 'personal', AWS_SECRET_ACCESS_KEY: 'secret',
  AZURE_OPENAI_TOKEN: 'secret', COMMANDCODE_API_TOKEN: 'secret',
  SOME_AUTH_TOKEN: 'secret', ACCESS_TOKEN: 'secret', YAN_CLI_URL: 'host', YAN_SESSION_ID: 'real', ELECTRON_RUN_AS_NODE: '1' }
assert.deepEqual(syntheticEnvironment(env), { PATH: 'keep', YAN_TEST_SYNTHETIC_ONLY: '1', PI_OFFLINE: '1' })
assert.equal(env.OPENAI_API_KEY, 'secret', 'do not mutate caller environment')

const source = readFileSync(new URL('./test-live.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('test-live.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const seed = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'seedSessions')
assert.ok(seed)
let writes = 0
const fail = () => { throw new Error('personal file access in synthetic mode') }
const count = () => { writes++ }
const context = vm.createContext({
  SYNTHETIC_ONLY: true, join, homedir: () => 'personal-home', mkdirSync() {},
  existsSync: fail, copyFileSync: fail, readdirSync: fail, statSync: fail,
  process: { env: { YAN_TEST_EXTRA_SESSIONS: 'personal.jsonl' } }, console,
  writeTodoSession: count, writeBranchFamily: () => { writes += 3 }, writePlainSession: count
})
vm.runInContext(seed.getText(ast), context)
assert.equal(vm.runInContext("seedSessions('temporary-sessions')", context), 6)
assert.equal(writes, 6)
console.log('live-synthetic-isolation: selection, credentials/environment stripping and synthetic-only session seed passed')
