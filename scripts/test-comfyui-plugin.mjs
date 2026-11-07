import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComfyService } from '../integrations/comfyui/service.mjs'
import { comfyImage, comfyAbortRequests, loadSources } from '../integrations/comfyui/generation.mjs'
import { comfyLaunchCommand, findLaunchableComfy, comfyStatus, comfyQueueBusy } from '../integrations/comfyui/launcher.mjs'
import { createServer } from 'node:http'
import extension from '../integrations/comfyui/extension.mjs'
import { runComfyWorkflowTests } from './test-comfyui-workflows.mjs'
import { runComfyVideoTests, directorWorkflow } from './test-comfyui-video.mjs'
import { runComfyRawTests } from './test-comfyui-raw.mjs'
import { runComfyIdleTests } from './test-comfyui-idle.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-comfy-plugin-'))
const oldEnv = { ...process.env }, originalFetch = globalThis.fetch
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture-image')])
let checks = 0
const ok = (value, message) => { assert.ok(value, message); checks++ }
try {
  for (const name of Object.keys(process.env)) if (name.startsWith('YAN_COMFYUI_')) delete process.env[name]
  process.env.YAN_LOCAL_INSTALL_SCAN = 'off'
  globalThis.fetch = async () => { throw new Error('Real network disabled') }
  checks += await runComfyWorkflowTests()
  checks += await runComfyVideoTests()
  checks += await runComfyRawTests()
  checks += await runComfyIdleTests()
  const project = join(root, 'project'), artifactDir = join(root, 'artifacts'), outside = join(root, 'outside')
  await mkdir(project); await mkdir(artifactDir); await mkdir(outside)
  await writeFile(join(project, 'normal.png'), PNG); await writeFile(join(outside, 'secret.png'), PNG)
  await symlink(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(loadSources(['escape/secret.png'], { cwd: project, artifactDir }), { code: 'image_source_outside_project' }); checks++
  let startPrompts = 0
  const deny = createComfyService({ artifactDir, confirm: async () => { startPrompts++; return false } })
  await assert.rejects(deny('start'), /没有找到能直接启动/)
  await assert.rejects(deny('video', { input: { prompt: 'x' }, context: { cwd: project } }), /没有找到能直接启动/)
  ok(startPrompts === 0, 'starting local ComfyUI, explicitly or for a generation, does not ask the user again')
  startPrompts = 0
  await assert.rejects(deny('stop'), /未批准/); checks++
  ok(startPrompts === 1, 'stopping still asks the user')
  await assert.rejects(deny('generate', { input: { prompt: 'x' } }), /可信项目/); checks++
  const workflow = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'saved' } },
    '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], seed: 123 } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'fixture' } }
  }
  let calls = [], cloud = false, editing = false
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url); calls.push({ href, init })
    if (href.endsWith('/system_stats')) return Response.json({ system: {} })
    if (href.includes('/api/userdata?')) return Response.json([cloud ? 'cloud.json' : editing ? 'edit.json' : 'fixture.json'])
    if (href.includes('/api/userdata/')) return Response.json(cloud ? { ...workflow, '4': { class_type: 'FluxProTextNode', inputs: { prompt: 'saved' } } } : editing ? { ...workflow, '0': { class_type: 'LoadImage', inputs: { image: 'saved.png' } } } : workflow)
    if (href.includes('/object_info/')) return Response.json(href.endsWith('/FluxProTextNode') ? { FluxProTextNode: { api_node: true, input: { required: { prompt: ['STRING'] } } } } : {})
    if (href.endsWith('/upload/image')) return Response.json({ name: 'uploaded.png' })
    if (href.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-prompt' })
    if (href.includes('/history/')) return Response.json({ 'owned-prompt': { status: { completed: true }, outputs: { '3': { images: [{ filename: 'fixture.png', type: 'output' }] } } } })
    if (href.includes('/view?')) return new Response(PNG)
    if (href.endsWith('/queue')) return Response.json({})
    throw new Error('Unexpected fixture request ' + href)
  }
  const service = createComfyService({ artifactDir, confirm: async () => false })
  const generated = await service('generate', { input: { prompt: 'bamboo' }, context: { cwd: project } })
  ok((await readFile(generated.path)).equals(PNG) && generated.workflow === 'fixture.json', 'plugin service saves local workflow output')
  const body = JSON.parse(calls.find(call => call.href.endsWith('/prompt')).init.body)
  ok(body.prompt['1'].inputs.text === 'bamboo', 'plugin updates the positive prompt')
  editing = true; calls = []
  const edited = await service('generate', { input: { prompt: 'edit', sourcePaths: ['normal.png'] }, context: { cwd: project } })
  const editPrompt = JSON.parse(calls.find(call => call.href.endsWith('/prompt')).init.body).prompt
  ok(edited.workflow === 'edit.json' && editPrompt['0'].inputs.image === 'uploaded.png' && calls.some(call => call.href.endsWith('/upload/image') && call.init.body instanceof FormData), 'image editing uploads a project reference and rewires LoadImage')
  editing = false
  const parallel = await Promise.all(['first', 'second'].map(prompt => service('generate', { input: { prompt }, context: { cwd: project } })))
  ok(parallel.length === 2 && parallel[0].path !== parallel[1].path, 'parallel callers queue safely without dropping requests')
  cloud = true; calls = []
  await assert.rejects(service('generate', { input: { prompt: 'x', workflow: 'cloud.json' }, context: { cwd: project } }), { code: 'local_workflow_unsupported' }); checks++
  ok(!calls.some(call => call.href.endsWith('/prompt')), 'named cloud workflow cannot bypass approval')
  let confirmed = 0
  const allowedService = createComfyService({ artifactDir, confirm: async () => { confirmed++; return true } })
  const allowedCloud = await allowedService('generate', { input: { prompt: 'x', workflow: 'cloud.json' }, context: { cwd: project } })
  ok(confirmed === 1 && allowedCloud.workflow === 'cloud.json', 'explicit per-request cloud approval allows the named workflow')
  cloud = false; calls = []
  const cancel = new AbortController()
  const pending = comfyImage({ prompt: 'x' }, [], { baseUrl: 'http://127.0.0.1:8188', models: ['fixture.json'], name: 'fixture' }, false, stage => { if (stage === 'generating') cancel.abort() }, cancel.signal)
  await assert.rejects(pending); checks++
  const deletion = calls.find(call => call.href.endsWith('/queue'))
  ok(JSON.parse(deletion.init.body).delete[0] === 'owned-prompt' && !calls.some(call => call.href.endsWith('/interrupt')), 'cancellation removes only its own queued external job')
  assert.deepEqual(comfyAbortRequests('p1', true).map(request => request.path), ['/interrupt', '/queue']); checks++
  assert.deepEqual(comfyAbortRequests('p1', false).map(request => request.path), ['/queue']); checks++
  globalThis.fetch = async () => Response.json({ queue_running: [[1]], queue_pending: [] })
  ok(await comfyQueueBusy('http://comfy') === true, 'running prompt keeps managed ComfyUI alive')
  globalThis.fetch = async () => Response.json({ queue_running: [], queue_pending: [[2]] })
  ok(await comfyQueueBusy('http://comfy') === true, 'pending prompt keeps managed ComfyUI alive')
  globalThis.fetch = async () => Response.json({ queue_running: [], queue_pending: [] })
  ok(await comfyQueueBusy('http://comfy') === false, 'empty queue allows idle stop')
  globalThis.fetch = async () => { throw new Error('offline') }
  ok(await comfyQueueBusy('http://comfy') === false, 'unreachable server allows idle stop')
  globalThis.fetch = async () => Response.json({}, { status: 404 })
  const installDir = join(root, 'fake-comfy'), python = process.platform === 'win32' ? join(installDir, 'venv', 'Scripts', 'python.exe') : join(installDir, 'venv', 'bin', 'python')
  await mkdir(join(python, '..'), { recursive: true }); await mkdir(join(installDir, 'user'))
  await writeFile(join(installDir, 'main.py'), '')
  process.env.YAN_COMFYUI_DIR = installDir
  await comfyStatus()
  ok(await findLaunchableComfy() === null && comfyLaunchCommand(installDir) === null, 'missing Python is not launchable')
  await writeFile(python, '')
  await mkdir(join(installDir, 'user', 'default', 'workflows'), { recursive: true })
  await writeFile(join(installDir, 'user', 'default', 'workflows', 'h3.json'), '\uFEFF' + JSON.stringify(directorWorkflow()))
  const launchStatus = await comfyStatus()
  ok(launchStatus.launchable && comfyLaunchCommand(installDir).python === python, 'installed Python is detected without executing it')
  ok(launchStatus.workflows.some(entry => entry.name === 'h3.json' && entry.kind === 'video-to-video'), 'offline status lists saved workflows with their kind, including files with a BOM')
  const tools = new Map()
  const attachedPaths = []
  extension({ registerTool: tool => tools.set(tool.name, tool), exec: async (_cmd, args) => { attachedPaths.push(args.at(-1)); return { code: 0 } } })
  ok(tools.has('comfyui_generate') && tools.has('comfyui_service') && tools.has('comfyui_video') && tools.has('comfyui_job') && ['comfyui_nodes', 'comfyui_workflow', 'comfyui_upload', 'comfyui_run'].every(name => tools.has(name)), 'pi extension registers all plugin tools')
  const videoFile = join(root, 'video.mp4')
  await writeFile(videoFile, 'video')
  const requests = []
  let jobPolls = 0
  let finishAfter = 2
  const rpc = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      const payload = JSON.parse(body)
      requests.push({ payload, headers: req.headers })
      const action = payload.params.action
      const running = { jobId: 'j1', state: 'running', stage: 'running', nodeType: 'MiniMaxH3Director', nodesDone: 3, nodesTotal: 8, step: 2, steps: 4, stepPercent: 50, elapsedSeconds: 12 }
      const value = action === 'status' ? { running: true }
        : action === 'video' ? { jobId: 'j1', state: 'running', stage: 'preparing', elapsedSeconds: 0 }
        : action === 'job' ? (++jobPolls >= finishAfter ? { ...running, state: 'done', stage: 'done', path: videoFile, mimeType: 'video/mp4', workflow: 'h3.json' } : running)
        : {}
      const file = join(root, `rpc-${requests.length}.json`)
      await writeFile(file, JSON.stringify(value))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, resultFile: file }))
    })
  })
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve))
  process.env.YAN_CLI_URL = `http://127.0.0.1:${rpc.address().port}/rpc`
  process.env.YAN_CLI_TOKEN = 'fixture-scoped-token'
  process.env.YAN_SESSION_ID = 'fixture-session'
  process.env.YAN_PROJECT_ID = 'fixture-project'
  try {
    const result = await tools.get('comfyui_service').execute('tool1', { action: 'status' }, undefined, undefined, { cwd: project })
    const first = requests[0]
    ok(first.payload.command === 'plugin.invoke' && first.payload.params.plugin === 'comfyui' && first.payload.sessionId === 'fixture-session' && first.headers.authorization === 'Bearer fixture-scoped-token' && result.details.running, 'extension uses the authenticated session-scoped public capability interface')
    const updates = []
    const video = await tools.get('comfyui_video').execute('tool2', { prompt: 'fish', videoPath: 'clip.mp4', waitSeconds: 60 }, undefined, update => updates.push(update), { cwd: project })
    const started = requests.find(entry => entry.payload.params.action === 'video')
    ok(started.payload.params.input.detach === true && started.payload.params.input.waitSeconds === undefined, 'video tool starts a detached job without leaking waitSeconds')
    ok(updates.some(update => /MiniMaxH3Director/.test(update.content[0].text) && /2\/4/.test(update.content[0].text)), 'tool card receives live node and step progress')
    ok(video.details.state === 'done' && video.details.attached && attachedPaths.includes(videoFile), 'finished video is attached to the reply')
    jobPolls = 0; finishAfter = 99
    const pending = await tools.get('comfyui_video').execute('tool3', { prompt: 'fish', waitSeconds: 0 }, undefined, undefined, { cwd: project })
    ok(pending.details.state === 'running' && /comfyui_job/.test(pending.content[0].text) && /j1/.test(pending.content[0].text), 'unfinished job returns progress and how to keep waiting')
    finishAfter = 1; jobPolls = 0
    const resumed = await tools.get('comfyui_job').execute('tool4', { jobId: 'j1', waitSeconds: 30 }, undefined, undefined, { cwd: project })
    ok(resumed.details.state === 'done' && resumed.details.path === videoFile, 'comfyui_job resumes waiting and returns the finished video')
  } finally { await new Promise(resolve => rpc.close(resolve)) }
  console.log(`comfyui-plugin: ${checks} checks passed (fixture only; no ComfyUI/model process)`)
} finally {
  globalThis.fetch = originalFetch
  for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name]
  Object.assign(process.env, oldEnv)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
