import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { comparePiVersions, requirePiUpgrade } from './lib/pi-upgrade-policy.mjs'
import { bundledPiRuntimeForTest } from './lib/pi-runtime-location.mjs'
import { catalogKey } from '../resources/pi-extensions/generated/model-capabilities.mjs'
import { fastModeSupported as extensionFastModeSupported } from '../resources/pi-extensions/fast-mode.js'

let checks = 0
const check = (condition, message) => { assert(condition, message); checks++ }
if (process.argv.includes('--upgrade-catalog-only')) {
  await runUpgradeCatalogTests()
  console.log(`PASS: ${checks} assertions; isolated pi upgrade catalog exit codes`)
  process.exit(0)
}
await runUpgradeCatalogTests()
const root = await mkdtemp(join(tmpdir(), 'inkstone-pi-compat-'))
const modules = {}
for (const [name, file] of Object.entries({
  normalize: 'src/main/normalize.ts', projector: 'src/main/session-items/projector.ts', tree: 'src/shared/tool-call-tree.ts',
  session: 'src/main/session-reader.ts', prefs: 'src/main/pi-runtime-prefs.ts', models: 'src/shared/model-capabilities.ts',
  brand: 'src/shared/model-brand.ts', fast: 'src/shared/fast-mode.ts', subagent: 'src/shared/subagent-pi-launch.ts'
})) {
  const outfile = resolve(`out/test/pi-compat-${name}.mjs`)
  await build({ entryPoints: [resolve(file)], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  modules[name] = await import(pathToFileURL(outfile))
}
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

const { collapseSkillInvocation } = modules.normalize
const { projectHistory } = modules.projector
const skillBody = ['<skill name="capabilities" location="C:/repo/SKILL.md">', 'References are relative.', '', '# body', '</skill>'].join(String.fromCharCode(10))
check(collapseSkillInvocation(skillBody) === '/skill:capabilities', 'skill block collapses to the typed command')
check(collapseSkillInvocation(skillBody + String.fromCharCode(10, 10) + '找个画图能力') === '/skill:capabilities 找个画图能力', 'skill block keeps the user arguments')
check(collapseSkillInvocation('<skill name="x"> not a pi block') === '<skill name="x"> not a pi block', 'non-matching text is left alone')
check(projectHistory([{ role: 'user', content: [{ type: 'text', text: skillBody }], timestamp: 1 }])[0].text === '/skill:capabilities', 'history shows the collapsed skill command')
const parent = { role: 'assistant', content: [{ type: 'toolCall', id: 'code', name: 'codemode', arguments: { code: 'fixture' } }], timestamp: 1 }
const result = { role: 'toolResult', toolCallId: 'code', toolName: 'codemode', content: [{ type: 'text', text: 'selected output' }], details: { truncated: true }, nestedCalls: { complete: false, calls: [
  { id: 'code/1', name: 'read', arguments: { path: 'a.txt' }, status: 'ok', durationMs: 3 },
  { id: 'code/2', name: 'powershell', arguments: { command: 'fixture' }, status: 'error', error: 'blocked' },
  { id: 'code/2/1', name: 'read', status: 'unfinished' },
  { id: 'unrelated', name: 'write', status: 'ok' },
  { id: 'code/1', name: 'duplicate', status: 'ok' },
  null
] }, timestamp: 2 }
const history = projectHistory([{ role: 'system', content: 'prompt' }, parent, result], undefined, ['system', 'assistant-entry', 'result-entry'])
check(history.length === 1 && history[0].entryId === 'assistant-entry', 'nested summaries preserve message and fork anchor')
const calls = history[0].toolCalls
check(calls.length === 4 && calls[1].parentToolCallId === 'code', 'bounded summaries restore valid unique children')
check(calls[3].parentToolCallId === 'code/2' && calls[3].incomplete === true && !calls[3].cancelled, 'unfinished record does not claim a user cancellation')
check(calls[0].nestedCallsIncomplete === true && calls[1].historySummary === true, 'incomplete and summary-only records are explicit')
check(calls[1].output === undefined && calls[2].output === 'blocked', 'history does not invent successful child output')
check(calls[0].details.truncated === true && calls[0].output === 'selected output', 'parent result details restored')
check(projectHistory([result])[0].toolCalls.length === 4, 'orphan parent result retains nested summary')
check(projectHistory([parent, { ...result, nestedCalls: { calls: 'bad' } }])[0].toolCalls.length === 1, 'malformed nested record safely ignored')
const many = Array.from({ length: 300 }, (_, i) => ({ id: `code/${i + 1}`, name: 'read', status: 'ok' }))
check(projectHistory([parent, { ...result, nestedCalls: { calls: many } }])[0].toolCalls.length === 257, 'at most 256 child summaries restored')
const forest = modules.tree.toolCallForest(calls)
check(forest.length === 1 && forest[0].children.map(node => node.call.id).join(',') === 'code/1,code/2', 'nested calls sit under their parent in execution order')
check(forest[0].children[1].children[0]?.call.id === 'code/2/1', 'grandchild stays under its own caller')
const cycle = [{ id: 'a', parentToolCallId: 'b', name: 'read' }, { id: 'b', parentToolCallId: 'a', name: 'read' }]
check(modules.tree.toolCallForest(cycle).length === 2, 'cyclic history cannot hang the renderer')
check(modules.tree.toolCallForest([{ id: 'x', parentToolCallId: 'gone', name: 'read' }]).length === 1, 'orphan child stays inspectable at the top level')

try {
  await runReasoningDiagnosticsTests()
  await runBundledRuntimeTests()
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(`PASS: ${checks} assertions plus version rejection cases; pi upgrade, models, diagnostics, bundled extensions and nested history/tree`)

async function runReasoningDiagnosticsTests() {
  const message = {
    role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol', stopReason: 'stop', timestamp: 100,
    content: [{ type: 'text', text: 'normal response' }],
    diagnostics: [{ type: 'openai_input_transformations', timestamp: 99, details: { transformations: [
      { type: 'reasoning', id: 'rs_fixture', action: 'removed', reason: 'fixture' }
    ] } }]
  }
  const { SessionItemProjector } = modules.projector
  const live = new SessionItemProjector()
  live.liveMessageStart(message, 99)
  live.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'normal response' }, 100)
  const settled = live.liveMessageEnd({ error: modules.normalize.assistantError(message) }, [], message)
  check(settled?.text === 'normal response' && !settled.error && !settled.thinking, 'reasoning drop diagnostics are not live errors, content or thinking blocks')
  const file = join(root, 'diagnostic.jsonl')
  const timestamp = new Date(100).toISOString()
  const persisted = [
    { type: 'session', version: 3, id: 'fixture', cwd: root, timestamp },
    { type: 'message', id: 'reply', parentId: null, timestamp, message }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(file, persisted)
  const history = await modules.session.readSessionMessages(file)
  const reply = history?.messages[0]
  check(history?.messages.length === 1 && reply?.entryId === 'reply' && reply.text === settled.text && !reply.error, 'history retains the message and branch anchor without a spurious error')
  check(await readFile(file, 'utf8') === persisted, 'desktop projection does not discard the persisted native diagnostics')
  check(modules.prefs.applyPiNativePatch({ notices: { cacheMisses: true } }, { cacheWarming: 'off' }).notices?.cacheMisses === true, 'editing desktop native settings preserves pi’s TUI notice preferences')
}

async function runBundledRuntimeTests() {
  const runtime = bundledPiRuntimeForTest('pi compatibility', resolve('resources/pi-runtime'))
  if (!runtime) return
  const { version } = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'))
  const cli = join(runtime, 'dist/bundle/cli.js')
  const extensionDir = resolve('resources/pi-extensions')
  const app = await readFile(resolve('src/main/index.ts'), 'utf8')
  const agent = await readFile(resolve('src/main/agent.ts'), 'utf8')
  const desktopBlock = app.match(/const YAN_THIN_EXTENSION_FILES = \{([\s\S]*?)\} as const/)?.[1] ?? ''
  const desktop = Object.fromEntries([...desktopBlock.matchAll(/(\w+Extension): '([^']+\.js)'/g)].map(([, key, file]) => [key, file]))
  const providerLine = app.match(/^const PROVIDER_EXTENSION_FILES = .*$/m)?.[0] ?? ''
  const providers = [...providerLine.matchAll(/'([^']+\.js)'/g)].map(([, file]) => file)
  const extArgs = agent.match(/args: skipLaunch \? skipLaunch\.args : agentOwnedPiArgs\(\[([\s\S]*?)\], nativeTools\)/)?.[1] ?? ''
  const ordered = [...extArgs.matchAll(/this\.(\w+Extension|providerExtensions)\s*(?:\?|\.flatMap)/g)]
    .flatMap(([, key]) => key === 'providerExtensions' ? providers : desktop[key] ? [desktop[key]] : [])
  const alternates = ['readonly-tools.js', 'side-question.js', 'subagent-guide.js']
  const entrypoints = []
  for (const name of await readdir(extensionDir)) {
    if (name.endsWith('.js') && /^export default /m.test(await readFile(join(extensionDir, name), 'utf8'))) entrypoints.push(name)
  }
  check(new Set(ordered).size === ordered.length, 'desktop smoke loads each extension once')
  assert.deepEqual([...ordered, ...alternates].sort(), entrypoints.sort(), 'all shipped pi extension entrypoints are included in a smoke group')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(YAN_|PI_|ELECTRON_RUN_AS_NODE$)|(?:_API_KEY|_TOKEN)$/i.test(key)))
  const catalog = JSON.parse(await readFile(join(extensionDir, 'generated/pi-model-catalog.json'), 'utf8')).models
  const fixtures = [
    ['openai-codex', 'gpt-6.2-sol', 'codex', 'GPT-6.2 Sol', 'openai-codex-responses'],
    ['openai-codex', 'gpt-6.2-astra', 'codex', 'GPT-6.2 Astra', 'openai-codex-responses'],
    ['google', 'gemini-4-neon', 'gemini', 'Gemini 4 Neon', 'google-generative-ai'],
    ['qwen-token-plan', 'qwen4-max-preview', 'qwen', 'Qwen4 Max Preview', 'openai-completions'],
    ['qwen-token-plan', 'deepseek-v4.1-flash', 'deepseek', 'DeepSeek V4.1 Flash', 'openai-completions']
  ]
  const registry = join(root, 'registry.json')
  const mcpSnapshot = join(root, 'mcp-tools.json')
  await writeFile(mcpSnapshot, JSON.stringify({ tools: [{ serverId: 'fixture', toolName: 'echo' }] }))
  const probe = join(root, 'registry.mjs')
  await writeFile(probe, `import { writeFileSync } from 'node:fs'\nexport default (pi) => pi.on('session_start', (_event, ctx) => writeFileSync(${JSON.stringify(registry)}, JSON.stringify(ctx.modelRegistry.getAll())))\n`)
  const groups = [[...ordered, probe], ['subagent-guide.js'], ['readonly-tools.js'], ['side-question.js'], ['shell-fallback.js']]
  for (const [index, group] of groups.entries()) {
    const piDir = join(root, `pi-${index}`)
    const yanDir = join(root, `yan-${index}`)
    await mkdir(piDir)
    await mkdir(yanDir)
    const id = `extensions-${index}`
    const child = spawnSync(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
      ...group.flatMap((file) => ['--extension', resolve(extensionDir, file)])], {
      input: JSON.stringify({ id, type: 'get_state' }) + '\n', cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...env, PI_CODING_AGENT_DIR: piDir, YAN_DATA_DIR: yanDir, YAN_NATIVE_BRIDGE: '1', YAN_MCP_APP_TOOLS: mcpSnapshot, OPENAI_API_KEY: 'SYNTHETIC_COMPAT_FIXTURE', ...(index === 4 ? { YAN_SHELL: 'powershell' } : {}) }
    })
    const label = index === 0 ? `${ordered.length} desktop extensions` : group.join(', ')
    check(child.status === 0, `${label}: RPC startup exits normally: ${child.error ?? child.stderr}`)
    const frames = child.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    const response = frames.find((frame) => frame.id === id && frame.type === 'response')
    check(response?.success && !child.stderr.trim() && !frames.some((frame) => frame.type === 'extension_error'), `${label}: RPC startup has no extension diagnostics: ${child.stderr} ${JSON.stringify(frames.filter((frame) => frame.type === 'extension_error'))}`)
    if (index === 0) {
      if (version === '1.6.0') check(response.data.model?.id === 'gpt-6.2-sol' && response.data.thinkingLevel === 'medium', 'OpenAI uses the native pi 1.6 default model and thinking level')
      check(frames.some((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify' && frame.message?.includes('"op":"hello"')), 'native bridge emits its hello receipt on pi 1.6 RPC')
    }
  }
  if (version !== '1.6.0') return
  for (const [id, primary, legacy] of [
    ['qwen-token-plan', 'QWEN_TOKEN_PLAN_TEAM_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY'],
    ['qwen-token-plan-cn', 'QWEN_TOKEN_PLAN_TEAM_CN_API_KEY', 'QWEN_TOKEN_PLAN_CN_API_KEY'],
    ['qwen-token-plan-individual', 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY'],
    ['qwen-token-plan-individual-cn', 'QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY', 'QWEN_TOKEN_PLAN_CN_API_KEY']
  ]) {
    for (const name of [primary, legacy]) {
      const child = spawnSync(process.execPath, [cli, 'auth', 'check', '--provider', id, '--json', '--no-refresh'], {
        cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
        env: { ...env, PI_CODING_AGENT_DIR: join(root, 'pi-0'), [name]: 'SYNTHETIC_QWEN_FIXTURE' }
      })
      check(child.status === 0 && JSON.parse(child.stdout)?.status === 'ready', `pi accepts ${name} for ${id}: ${child.error ?? child.stderr}`)
    }
  }
  const rawModels = JSON.parse(await readFile(registry, 'utf8'))
  for (const [provider, id, brand, name, api] of fixtures) {
    const label = `${provider}/${id}`
    const raw = rawModels.find((model) => model.provider === provider && model.id === id && model.api === api)
    const normalized = modules.models.normalizeModelInfo(raw)
    check(normalized?.name === name && normalized.reasoning && normalized.contextWindow > 0, `${label}: native display name and capabilities survive normalization`)
    check(catalog[catalogKey(label)]?.reasoning === true, `${label}: model capabilities are in the compact catalog`)
    check(modules.brand.modelBrand(normalized) === brand, `${label}: correct model brand`)
    const fast = provider === 'openai-codex'
    check(modules.fast.fastModeSupported(normalized) === fast && extensionFastModeSupported(raw) === fast, `${label}: UI and extension agree on Codex fast mode`)
    check(modules.subagent.defaultSubagentThinking(label) === (brand === 'deepseek' ? 'high' : undefined), `${label}: preserves the DeepSeek high override and defers other defaults to pi`)
  }
}

async function runUpgradeCatalogTests() {
  const fixture = await mkdtemp(join(tmpdir(), 'inkstone-upgrade-catalog-'))
  try {
    const scripts = join(fixture, 'scripts')
    const source = join(fixture, 'source')
    await mkdir(scripts)
    await mkdir(join(source, 'dist', 'bundle'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ version: '1.0.1' }))
    await writeFile(join(source, 'dist', 'bundle', 'cli.js'), '// never executed')

    let upgrade = await readFile(resolve('scripts/upgrade-pi.mjs'), 'utf8')
    for (const [original, replacement] of [
      ["import { spawnSync } from 'node:child_process'", "import { spawnSync } from './upgrade-fixture.mjs'"],
      ["import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'", "import { selectedPiRuntime } from './upgrade-fixture.mjs'"],
      ["import { requirePiUpgrade } from './lib/pi-upgrade-policy.mjs'", "import { requirePiUpgrade } from './upgrade-fixture.mjs'"]
    ]) {
      assert(upgrade.includes(original), `fixture import not found: ${original}`)
      upgrade = upgrade.replace(original, replacement)
    }
    await writeFile(join(scripts, 'upgrade-pi.mjs'), upgrade)
    await writeFile(join(scripts, 'upgrade-fixture.mjs'), `
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const scripts = dirname(fileURLToPath(import.meta.url))
let calls = 0
export const selectedPiRuntime = (runtimeRoot) => runtimeRoot
export const requirePiUpgrade = () => {}
export function spawnSync(command, args) {
  assert.equal(command, process.execPath)
  if (++calls === 1) {
    assert.deepEqual(args, [join(scripts, 'vendor-pi.mjs')])
    console.log('FIXTURE_VENDOR_OK')
    return { status: 0 }
  }
  assert.equal(calls, 2)
  assert.deepEqual(args, [join(scripts, 'gen-pi-model-catalog.mjs')])
  console.log('FIXTURE_CATALOG_START')
  switch (process.env.INKSTONE_CATALOG_CASE) {
    case 'nonzero': return { status: 7 }
    case 'spawn-error': return { status: null, error: new Error('fixture ENOENT') }
    case 'signal': return { status: null, signal: 'SIGTERM' }
    case 'success': return { status: 0 }
    default: throw new Error('unknown fixture case')
  }
}
`)
    for (const [scenario, status] of [['nonzero', 7], ['spawn-error', 1], ['signal', 1], ['success', 0]]) {
      const result = spawnSync(process.execPath, [join(scripts, 'upgrade-pi.mjs'), '--force'], {
        cwd: fixture,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, YAN_PI_SRC: source, INKSTONE_CATALOG_CASE: scenario }
      })
      const output = result.stdout + result.stderr
      check(!result.error && result.signal === null, `${scenario}: fixture process completed normally`)
      check(result.status === status, `${scenario}: expected exit ${status}, got ${result.status}: ${output}`)
      check(result.stdout.indexOf('FIXTURE_VENDOR_OK') < result.stdout.indexOf('FIXTURE_CATALOG_START') && result.stdout.includes('FIXTURE_VENDOR_OK'), `${scenario}: vendor succeeded before catalog generation`)
      if (scenario === 'success') {
        check(output.includes('升级完成。') && output.includes('请**重启应用**后生效。'), 'success preserves the original completion ending')
        check(!output.includes('升级未全部完成'), 'success does not report a partial upgrade')
      } else {
        check(output.includes('内置运行时已更新') && output.includes('模型能力表未完成'), `${scenario}: reports partial update`)
        check(output.includes('node scripts/gen-pi-model-catalog.mjs'), `${scenario}: gives catalog repair command`)
        check(!output.includes('升级完成。') && !output.includes('请**重启应用**后生效。'), `${scenario}: no success ending`)
        if (scenario === 'spawn-error') check(output.includes('fixture ENOENT'), 'spawn error includes the cause')
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}
