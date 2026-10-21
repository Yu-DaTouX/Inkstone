import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { runArtifactTests } from './test-artifacts.mjs'

const root = await mkdtemp(join(tmpdir(), 'yan-image-boundaries-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-image-boundaries-'))
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('test-image')])
const response = () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
const tick = () => delay(0)
const none = { codex: false, openai: false, compatible: false, google: false, doubao: false, local: null }
const credentials = { hasCodex: async () => false, codex: async () => null, secret: async () => 'fixture-key' }

try {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('YAN_IMAGE_') || name.startsWith('YAN_COMFYUI_') || ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ARK_API_KEY', 'YAN_SDWEBUI_URL', 'OLLAMA_HOST', 'YAN_LMSTUDIO_URL'].includes(name)) delete process.env[name]
  }
  for (const name of ['YAN_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR', 'CODEX_HOME']) process.env[name] = join(root, name)
  process.env.YAN_LOCAL_INSTALL_SCAN = 'off'
  globalThis.fetch = async () => { throw new Error('No network allowed in image boundary tests') }
  const outfile = join(compiled, 'fixture.mjs')
  await build({
    stdin: { contents: "export * from './src/main/artifacts.ts'; export * from './src/main/image-generation.ts'; export * from './src/main/comfy-launcher.ts'; export * from './src/main/local-models.ts'; export { AgentController } from './src/main/agent.ts';", resolveDir: process.cwd(), sourcefile: 'image-boundary-fixture.ts' },
    outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'unused-electron', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(root)}, getLocale: () => 'zh-CN', getVersion: () => 'fixture' }; export class BrowserWindow { constructor() { throw new Error("Native browser is not part of this test") } }; export const session = {};` }))
    } }]
  })
  const mod = await import(pathToFileURL(outfile))
  const { generateImage, defaultImageModel, ArtifactStore, AgentController } = mod
  await runArtifactTests({ artifacts: mod, images: mod, agent: mod })

  const project = join(root, 'project'), artifactDir = join(root, 'artifacts')
  await mkdir(project, { recursive: true })
  const context = { cwd: project, artifactDir, sessionFile: join(project, 'session.jsonl'), messageId: 'a', availability: none, credentials }
  process.env.YAN_IMAGE_API_BASE = 'https://fixture.invalid/v1'
  process.env.YAN_IMAGE_API_KEY = 'fixture-key'
  let calls = []
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return response() }
  const out = await generateImage({ provider: 'compatible', prompt: 'x' }, context)
  ok(JSON.parse(calls.at(-1).init.body).model === defaultImageModel('compatible') && out.model === 'gpt-image-2', 'compatible default must match its label')
  process.env.YAN_IMAGE_COMPATIBLE_MODEL = 'compatible-custom'
  await generateImage({ provider: 'compatible', prompt: 'x' }, context)
  ok(JSON.parse(calls.at(-1).init.body).model === 'compatible-custom', 'compatible environment default must be respected')
  await generateImage({ provider: 'compatible', prompt: 'x', model: 'explicit-model' }, context)
  ok(JSON.parse(calls.at(-1).init.body).model === 'explicit-model', 'explicit model overrides environment')
  await generateImage({ provider: 'openai', prompt: 'x' }, context)
  ok(JSON.parse(calls.at(-1).init.body).model === defaultImageModel('openai'), 'OpenAI keeps its own default')
  delete process.env.YAN_IMAGE_COMPATIBLE_MODEL

  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.png'), PNG)
  await writeFile(join(project, 'normal.png'), PNG)
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, join(project, 'escape'), linkType)
  await symlink(project, join(root, 'project-alias'), linkType)
  calls = []
  await assert.rejects(generateImage({ provider: 'compatible', prompt: 'x', mode: 'edit', sourcePaths: ['escape/secret.png'] }, context), { code: 'image_source_outside_project' }); checks++
  ok(calls.length === 0, 'junction escape must not upload any bytes')
  await mkdir(artifactDir, { recursive: true })
  await symlink(outside, join(artifactDir, 'escape'), linkType)
  await assert.rejects(generateImage({ provider: 'compatible', prompt: 'x', mode: 'edit', sourcePaths: [join(artifactDir, 'escape', 'secret.png')] }, context), { code: 'image_source_outside_project' }); checks++
  await generateImage({ provider: 'compatible', prompt: 'x', mode: 'edit', sourcePaths: ['normal.png'] }, { ...context, cwd: join(root, 'project-alias') })
  ok(calls.at(-1).init.body instanceof FormData, 'legitimate project root alias stays supported')

  const parallelSession = join(project, 'parallel.jsonl')
  await symlink(artifactDir, join(root, 'artifacts-alias'), linkType)
  const parallel = await Promise.all(Array.from({ length: 18 }, (_, i) => {
    const dir = i % 2 ? join(root, 'artifacts-alias') : artifactDir
    const ctx = { ...context, artifactDir: dir, sessionFile: parallelSession, messageId: `parallel-${i}` }
    if (i % 3 === 0) return generateImage({ provider: 'mock', prompt: 'x' }, ctx).then(r => r.artifact)
    if (i % 3 === 1) return new ArtifactStore(dir).save({ ...ctx, filename: 'fixture.png', bytes: PNG })
    return new ArtifactStore(dir).attach({ ...ctx, sourcePath: 'normal.png' })
  }))
  const manifest = await new ArtifactStore(artifactDir).list(parallelSession)
  ok(manifest.length === 18, 'all cross-instance saves must persist')
  ok(parallel.every(a => manifest.some(m => m.artifact.id === a.id)), 'no successful parallel result may be missing')
  const hydrated = await new ArtifactStore(artifactDir).hydrateMessages(parallelSession, parallel.map((_, i) => ({ id: `parallel-${i}`, role: 'assistant', text: '' })))
  ok(hydrated.every(m => m.artifacts?.length === 1), 'all images restore on reload')

  const makeAgent = (name, confirm = async () => true) => {
    const events = []
    const agent = new AgentController({ cwd: project, push: e => events.push(e), confirmExternalApi: confirm, capability: { sessionId: name, runnerGeneration: 1, projectId: 'fixture', artifactDir, opsDir: join(root, 'ops'), binDir: join(root, 'bin') } })
    agent.messages = [{ id: name, role: 'assistant', text: '' }]
    agent.state = { sessionFile: join(project, `${name}.jsonl`) }
    agent.refreshState = async () => {}
    return { agent, events, file: agent.state.sessionFile }
  }
  for (const action of ['abort', 'stop']) {
    const entered = deferred(), late = deferred()
    let signal
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith(process.env.YAN_IMAGE_API_BASE)) throw new Error('probe unavailable')
      signal = init.signal; entered.resolve(); return late.promise
    }
    const { agent, events, file } = makeAgent(`cancel-${action}`)
    const pending = agent.runCapabilityCommand('image.generate', { provider: 'compatible', prompt: 'cancel' })
    const rejected = assert.rejects(pending, { code: 'image_cancelled' })
    await entered.promise
    await agent[action]()
    await rejected; checks++
    ok(signal.aborted, `${action} must abort the HTTP signal`)
    late.resolve(response()); await tick(); await tick()
    ok(!events.some(e => e.ch === 'artifact'), `${action} must suppress late artifacts`)
    const progress = events.filter(e => e.ch === 'msg-update' && e.payload.patch.imageProgress).map(e => e.payload.patch.imageProgress[0])
    ok(progress.at(-1).stage === 'error' && !progress.some(p => p.stage === 'done'), `${action} must preserve canceled progress`)
    ok((await new ArtifactStore(artifactDir).list(file)).length === 0, `${action} must not save a late response`)
    ok(agent.imageRequests.size === 0, 'settled cancellation releases request ownership')
  }

  const confirming = deferred(), answer = deferred()
  const gate = makeAgent('cancel-confirm', () => { confirming.resolve(); return answer.promise })
  let billed = 0
  globalThis.fetch = async url => { if (String(url).startsWith(process.env.YAN_IMAGE_API_BASE)) billed++; throw new Error('probe unavailable') }
  const gatePending = gate.agent.runCapabilityCommand('image.generate', { provider: 'compatible', prompt: 'x' })
  const gateRejected = assert.rejects(gatePending, { code: 'image_cancelled' })
  await confirming.promise; await gate.agent.abort(); await gateRejected; checks++
  answer.resolve(true); await tick()
  ok(billed === 0, 'late external approval must not start generation')
  ok(gate.agent.imageRequests.size === 0, 'canceled confirmation releases request ownership')

  const early = makeAgent('cancel-probe')
  const earlyPending = early.agent.runCapabilityCommand('image.generate', { provider: 'compatible', prompt: 'x' })
  const earlyRejected = assert.rejects(earlyPending, { code: 'image_cancelled' })
  await early.agent.abort(); await earlyRejected; checks++
  ok(billed === 0 && early.agent.imageRequests.size === 0, 'stop during provider probing must not send a request')

  const aEntered = deferred(), bEntered = deferred(), aLate = deferred(), bLate = deferred()
  let confirmedModel
  const a = makeAgent('isolation-a'), b = makeAgent('isolation-b', async request => { confirmedModel = request.model; return true })
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(process.env.YAN_IMAGE_API_BASE)) throw new Error('probe unavailable')
    const body = JSON.parse(init.body)
    if (body.prompt === 'a') { aEntered.resolve(); return aLate.promise }
    bEntered.resolve(); ok(body.model === confirmedModel, 'confirmation and actual model must agree'); return bLate.promise
  }
  const ap = a.agent.runCapabilityCommand('image.generate', { provider: 'compatible', prompt: 'a' })
  const ar = assert.rejects(ap, { code: 'image_cancelled' })
  const bp = b.agent.runCapabilityCommand('image.generate', { provider: 'compatible', prompt: 'b' })
  await Promise.all([aEntered.promise, bEntered.promise]); await a.agent.abort(); await ar; checks++
  aLate.resolve(response()); bLate.resolve(response())
  const br = await bp
  ok(br.summary.model === confirmedModel && b.events.some(e => e.ch === 'artifact'), 'another instance must finish normally')
  ok(!a.events.some(e => e.ch === 'artifact'), 'stopped instance must stay canceled')

  for (const provider of ['openai', 'compatible', 'codex', 'google', 'doubao', 'local']) {
    const entered = deferred(), late = deferred(), cancel = new AbortController()
    let requestSignal
    globalThis.fetch = async (url, init = {}) => { requestSignal = init.signal; entered.resolve(); return late.promise }
    const pending = generateImage({ provider, prompt: 'x', model: provider === 'codex' ? 'gpt-image-fixture' : 'fixture-model' }, { ...context, sessionFile: join(project, `adapter-${provider}.jsonl`), signal: cancel.signal, credentials: { ...credentials, codex: async () => ({ access: 'fixture-token', source: 'yan' }) }, availability: { ...none, local: { kind: 'sdwebui', name: 'fixture', baseUrl: 'http://127.0.0.1:7860', models: ['fixture-model'], running: true } } })
    const rejected = assert.rejects(pending, { code: 'image_cancelled' })
    await entered.promise; cancel.abort(); await rejected; checks++
    ok(requestSignal.aborted, `${provider} request must observe cancellation`)
    late.resolve(response()); await tick()
    ok((await new ArtifactStore(artifactDir).list(join(project, `adapter-${provider}.jsonl`))).length === 0, `${provider} must not save late results`)
  }

  const beforeStart = new AbortController()
  beforeStart.abort()
  await assert.rejects(generateImage({ provider: 'mock', prompt: 'x' }, { ...context, signal: beforeStart.signal }), { code: 'image_cancelled' }); checks++
  const savingCancel = new AbortController()
  const savingFile = join(project, 'cancel-saving.jsonl')
  await assert.rejects(generateImage({ provider: 'mock', prompt: 'x' }, { ...context, sessionFile: savingFile, signal: savingCancel.signal, onProgress: stage => { if (stage === 'saving') savingCancel.abort() } }), { code: 'image_cancelled' }); checks++
  ok((await new ArtifactStore(artifactDir).list(savingFile)).length === 0, 'cancel at the saving boundary must not commit a manifest')

  const workflow = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'saved' } },
    '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], seed: 123 } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'fixture' } }
  }
  calls = []
  const queued = deferred(), cancel = new AbortController()
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); calls.push({ url: href, init })
    if (href.includes('/api/userdata?')) return Response.json(['fixture.json'])
    if (href.includes('/api/userdata/')) return Response.json(workflow)
    if (href.includes('/object_info/')) return Response.json({})
    if (href.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-prompt' })
    if (href.endsWith('/queue')) return Response.json({})
    throw new Error(`unexpected ComfyUI request: ${href}`)
  }
  const cp = generateImage({ provider: 'local', prompt: 'x' }, { ...context, signal: cancel.signal, availability: { ...none, local: { kind: 'comfyui', name: 'fixture', baseUrl: 'http://127.0.0.1:8188', models: ['fixture.json'], running: true } }, onProgress: stage => { if (stage === 'generating') queued.resolve() } })
  const cr = assert.rejects(cp, { code: 'image_cancelled' })
  await queued.promise; cancel.abort(); await cr; checks++
  const deletes = calls.filter(c => c.url.endsWith('/queue'))
  ok(deletes.length === 1 && JSON.stringify(JSON.parse(deletes[0].init.body)) === JSON.stringify({ delete: ['owned-prompt'] }), 'ComfyUI cancellation deletes only the owned queue item')
  ok(!calls.some(c => c.url.endsWith('/interrupt') || c.url.includes('/history/')), 'canceling a queued ComfyUI job must not interrupt or keep polling')
  await tick()
  calls = []
  const polling = deferred(), lateHistory = deferred(), runningCancel = new AbortController()
  let pollingSignal
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); calls.push({ url: href, init })
    if (href.includes('/api/userdata?')) return Response.json(['fixture.json'])
    if (href.includes('/api/userdata/')) return Response.json(workflow)
    if (href.includes('/object_info/')) return Response.json({})
    if (href.endsWith('/prompt')) return Response.json({ prompt_id: 'running-owned-prompt' })
    if (href.endsWith('/queue')) return Response.json({})
    if (href.includes('/history/')) { pollingSignal = init.signal; polling.resolve(); return lateHistory.promise }
    throw new Error(`unexpected ComfyUI request: ${href}`)
  }
  const runningFile = join(project, 'cancel-running-comfy.jsonl')
  const runningPending = generateImage({ provider: 'local', prompt: 'x' }, { ...context, sessionFile: runningFile, signal: runningCancel.signal, availability: { ...none, local: { kind: 'comfyui', name: 'fixture', baseUrl: 'http://127.0.0.1:8188', models: ['fixture.json'], running: true } } })
  const runningRejected = assert.rejects(runningPending, { code: 'image_cancelled' })
  await polling.promise; runningCancel.abort(); await runningRejected; checks++
  ok(pollingSignal.aborted, 'ComfyUI history request must observe cancellation')
  lateHistory.resolve(Response.json({ 'running-owned-prompt': { outputs: { '3': { images: [{ filename: 'late.png', type: 'output' }] } } } })); await tick()
  ok(!calls.some(c => c.url.endsWith('/interrupt') || c.url.includes('/view?')), 'active ComfyUI cancellation must not globally interrupt or fetch late output')
  ok((await new ArtifactStore(artifactDir).list(runningFile)).length === 0, 'active canceled ComfyUI result must not be saved')

  ok(
    JSON.stringify(mod.comfyAbortRequests('p1', false)) === JSON.stringify([{ path: '/queue', body: '{"delete":["p1"]}' }]),
    'external ComfyUI cancellation only removes the owned queue item'
  )
  ok(
    JSON.stringify(mod.comfyAbortRequests('p1', true)) === JSON.stringify([{ path: '/interrupt', body: '{}' }, { path: '/queue', body: '{"delete":["p1"]}' }]),
    'self-launched ComfyUI cancellation interrupts the running job before removing the queue item'
  )

  {
    const probes = { count: 0 }
    globalThis.fetch = async () => { probes.count += 1; return Response.json({}, { status: 404 }) }
    await mod.detectLocalModelServers()
    const afterFirst = probes.count
    ok(afterFirst > 0, 'detecting local servers probes them the first time')
    await mod.detectLocalModelServers()
    ok(probes.count === afterFirst, 'a repeated detection inside the cache window reuses the result')
    mod.resetLocalImageCache()
    await mod.detectLocalModelServers()
    ok(probes.count > afterFirst, 'an explicit reset probes again')
  }

  {
    const installDir = join(root, 'fake-comfy')
    const pythonPath = process.platform === 'win32' ? join(installDir, 'venv', 'Scripts', 'python.exe') : join(installDir, 'venv', 'bin', 'python')
    await mkdir(join(pythonPath, '..'), { recursive: true })
    await mkdir(join(installDir, 'user'), { recursive: true })
    await writeFile(join(installDir, 'main.py'), '')
    process.env.YAN_COMFYUI_DIR = installDir
    delete process.env.YAN_COMFYUI_PYTHON
    ok((await mod.findLaunchableComfy()) === null, 'a ComfyUI folder without Python is not launchable')
    await writeFile(pythonPath, '')
    ok((await mod.findLaunchableComfy()) === null, 'the launch folder scan is cached instead of rescanning every call')
    const status = await mod.comfyStatus()
    ok(status.installDir === installDir && status.launchable, 'a status refresh picks up the folder that became launchable')
  }
  console.log(`image-generation-boundaries: ${checks} checks passed; existing artifact/adapters also passed (no real network/model, no app build)`)
} finally {
  globalThis.fetch = originalFetch
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
  await rm(compiled, { recursive: true, force: true })
}
