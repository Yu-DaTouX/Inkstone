import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runSessionWorkSchedulerTests } from './test-session-work-scheduler.mjs'
import { selectedPiRuntime as scriptRuntime } from './lib/pi-runtime-location.mjs'
import { createRequire } from 'node:module'

const root = await mkdtemp(join(tmpdir(), 'inkstone-context-retirement-'))
process.env.YAN_DATA_DIR = root
process.env.YAN_PI_DIR = join(root, 'pi')
const sentinel = join(root, 'context-budget-v1', 'historical-record.json')
await mkdir(join(root, 'context-budget-v1'))
await writeFile(sentinel, '{"state":"needs_action","history":"keep"}\n')
const original = await readFile(sentinel)
const modules = {}
for (const [name, file] of Object.entries({ context: 'src/shared/agent-context.ts', scheduler: 'src/main/session-work-scheduler.ts', ipc: 'src/main/ipc/context-budget-ipc.ts', runtime: 'src/main/pi-runtime-location.ts', hub: 'src/main/agent-hub/pi-launch.ts' })) {
  const outfile = resolve(`out/test/agent-native-${name}.mjs`)
  await build({ entryPoints: [file], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  modules[name] = await import(pathToFileURL(outfile))
}
const runtimeRoot = join(root, 'resources', 'pi-runtime')
await mkdir(runtimeRoot, { recursive: true })
for (const select of [scriptRuntime, modules.runtime.selectedPiRuntime]) assert.equal(select(runtimeRoot), runtimeRoot)
await writeFile(join(runtimeRoot, 'current.json'), JSON.stringify({ generation: 'versions/0.99.1-fixture' }))
for (const select of [scriptRuntime, modules.runtime.selectedPiRuntime]) assert.equal(select(runtimeRoot), join(runtimeRoot, 'versions', '0.99.1-fixture'))
for (const generation of ['versions/..', '../private', 'versions/fixture/extra', 'C:/private']) {
  await writeFile(join(runtimeRoot, 'current.json'), JSON.stringify({ generation }))
  for (const select of [scriptRuntime, modules.runtime.selectedPiRuntime]) assert.throws(() => select(runtimeRoot))
}
await writeFile(join(runtimeRoot, 'current.json'), JSON.stringify({ generation: 'versions/0.99.1-fixture' }))
await mkdir(join(runtimeRoot, 'versions', '0.99.1-fixture', 'dist', 'bundle'), { recursive: true })
await writeFile(join(runtimeRoot, 'versions', '0.99.1-fixture', 'dist', 'bundle', 'cli.js'), '// fixture')
const beforePack = createRequire(import.meta.url)('./pi-runtime-before-pack.cjs')
const config = { extraResources: ['dist', 'node_modules', 'package.json'].map(part => ({ from: `resources/pi-runtime/${part}`, to: `pi-runtime/${part}` })).concat([{ from: 'resources/yan-cli', to: 'yan-cli' }]) }
await beforePack({ packager: { projectDir: root, config } })
assert.equal(config.extraResources[0].from, join(runtimeRoot, 'versions', '0.99.1-fixture', 'dist'))
assert.equal(config.extraResources[3].from, 'resources/yan-cli')
await assert.rejects(async () => modules.hub.hubPiArgs(root, join(root, 'sessions')), /授权适配缺失/)
await mkdir(join(root, 'yan-thin'))
await writeFile(join(root, 'yan-thin', 'danger-guard.js'), '// fixture')
const hubArgs = modules.hub.hubPiArgs(root, join(root, 'sessions'), '0.99.1')
assert(hubArgs.includes(join(root, 'yan-thin', 'danger-guard.js')))
assert(hubArgs.includes('--session-dir'))
assert(!hubArgs.includes('--no-skills') && !hubArgs.includes('--no-session'))
assert(!hubArgs.includes('--no-extensions'), 'native discovery respects pi user/project built-in settings')
const args = modules.context.agentOwnedPiArgs(['--no-extensions', '--no-skills', '-e', 'C:/app/resources/pi-extensions/context.js', '-e', 'C:/app/resources/pi-extensions/danger-guard.js', '-e', 'C:/user/context.js'], true)
assert(!args.includes('--no-skills'))
assert(!args.includes('C:/app/resources/pi-extensions/context.js'))
assert(args.includes('C:/app/resources/pi-extensions/danger-guard.js'))
assert(args.includes('C:/user/context.js'))
assert(!args.includes('--no-extensions'))
assert(!args.some(arg => arg.startsWith('builtin:')), 'do not force a built-in disabled in native settings')
assert(modules.context.agentOwnedPiArgs(['--no-extensions'], false).includes('--no-extensions'), 'older pi retains its extension policy')
assert.equal(modules.context.nativePiToolsSupported('0.87.1'), false)
assert.equal(modules.context.nativePiToolsSupported('0.99.1'), true)
let checks = 28
for (const folder of ['pi-extensions', 'yan-thin', 'YAN-THIN']) {
  const retired = ['context.js', 'context-budget-observer.js', 'context-budget-maintenance.js', 'project-knowledge.js', 'goal-resume.js', 'handoffs.js']
  const paths = retired.map((name) => `C:/app/resources/${folder}/${name}`)
  const nativeArgs = modules.context.agentOwnedPiArgs(paths.flatMap((path) => ['-e', path]))
  assert.deepEqual(nativeArgs, [], `${folder} must retire all host context modifiers`)
  assert(modules.context.isAgentContextExtension(`C:/app/resources/${folder}/danger-guard.js`))
  checks += 2
}
await runSessionWorkSchedulerTests((value, message) => { assert(value, message); checks++ }, modules.scheduler)
const handlers = new Map()
modules.ipc.registerContextBudgetIpc({ rawHandle: (name, handler) => handlers.set(name, handler) }, { currentAgent: () => undefined })
assert.equal(await handlers.get('yan:contextBudgetV1Enabled')(), false)
for (const name of ['yan:contextBudgetMaintainV1', 'yan:setContextBudgetV1', 'yan:setContextBudgetMaterialPinV1', 'yan:contextBudgetMaintenanceExitV1']) {
  assert.equal((await handlers.get(name)({ tier: 'standard' })).ok, false)
  checks++
}
assert.deepEqual(await readFile(sentinel), original, 'retirement preserves historical records')
console.log(`PASS: ${checks + 2} checks; native skill discovery, trusted adapters, no synthetic turns, retired IPC, preserved history`)
