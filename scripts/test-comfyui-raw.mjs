import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComfyService } from '../integrations/comfyui/service.mjs'
import { validatePrompt } from '../integrations/comfyui/validate.mjs'
import { resetInfoCache } from '../integrations/comfyui/raw.mjs'

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('raw-image')])

const OBJECT_INFO = {
  CheckpointLoaderSimple: { display_name: 'Load Checkpoint', category: 'loaders', input: { required: { ckpt_name: [['sd15.safetensors', 'flux-dev.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { display_name: 'CLIP Text Encode', category: 'conditioning', input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'], output_name: ['CONDITIONING'] },
  EmptyLatentImage: { display_name: 'Empty Latent Image', category: 'latent', input: { required: { width: ['INT', { default: 512, min: 16, max: 8192 }], height: ['INT', { default: 512, min: 16, max: 8192 }], batch_size: ['INT', { default: 1, min: 1, max: 64 }] } }, output: ['LATENT'], output_name: ['LATENT'] },
  KSampler: { display_name: 'KSampler', category: 'sampling', input: { required: { model: ['MODEL'], seed: ['INT', { min: 0, max: 1e15 }], steps: ['INT', { default: 20, min: 1, max: 10000 }], cfg: ['FLOAT', { default: 8, min: 0, max: 100 }], sampler_name: [['euler', 'dpmpp_2m']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'] } }, output: ['LATENT'], output_name: ['LATENT'] },
  VAEDecode: { display_name: 'VAE Decode', category: 'latent', input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'], output_name: ['IMAGE'] },
  SaveImage: { display_name: 'Save Image', category: 'image', output_node: true, input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } }, output: [] },
  FluxProTextNode: { display_name: 'Flux Pro', category: 'api node/image', api_node: true, input: { required: { prompt: ['STRING'] } }, output: ['IMAGE'], output_name: ['IMAGE'] }
}

const goodPrompt = () => ({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a fish', clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'raw' } }
})

export async function runComfyRawTests() {
  let checks = 0
  const ok = (value, message) => { assert.ok(value, message); checks++ }
  const root = await mkdtemp(join(tmpdir(), 'inkstone-comfy-raw-'))
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const originalUrl = process.env.YAN_COMFYUI_URL
  try {
    const project = join(root, 'project')
    const artifactDir = join(root, 'artifacts')
    await mkdir(project)
    const info = OBJECT_INFO
    const clean = goodPrompt()
    ok(validatePrompt(clean, info).ok && validatePrompt(clean, info).outputNodes[0] === '7', 'a correct text-to-image prompt validates')

    const broken = goodPrompt()
    delete broken[5].inputs.steps
    broken[5].inputs.cfg = 500
    broken[5].inputs.sampler_name = 'eular'
    broken[5].inputs.latent_image = ['9', 0]
    broken[6].inputs.samples = ['2', 0]
    broken[7].inputs.images = ['6', 3]
    broken[8] = { class_type: 'KSamplr', inputs: {} }
    broken[2].inputs.extra = 1
    const result = validatePrompt(broken, info, Object.keys(info))
    const text = JSON.stringify(result.problems)
    ok(!result.ok && text.includes('缺少必填输入 steps') && text.includes('大于最大值 100') && text.includes('可选值') && text.includes('euler'), 'missing inputs, range and combo problems explain the fix')
    ok(text.includes('不存在的节点 9') && text.includes('类型不匹配：需要 LATENT') && text.includes('只有 1 个输出') && text.includes('相近：KSampler'), 'broken links, types, slots and unknown node types are named with suggestions')
    ok(result.warnings.some(warning => warning.input === 'extra'), 'undeclared inputs are reported as warnings')

    const cycle = goodPrompt()
    cycle[2].inputs.clip = ['6', 0]
    ok(validatePrompt(cycle, info).problems.some(problem => problem.message.includes('环')), 'cycles are reported')
    const noOutput = goodPrompt()
    delete noOutput[7]
    ok(validatePrompt(noOutput, info).problems.some(problem => problem.message.includes('没有输出节点')), 'prompts without an output node are rejected')
    ok(!validatePrompt({}, info).ok, 'empty prompts are rejected')
    const literalForLink = goodPrompt()
    literalForLink[5].inputs.model = 'sd15'
    ok(validatePrompt(literalForLink, info).problems[0].message.includes('必须连线'), 'literal values for link-only inputs say to connect a node')

    const saved = { 'saved.json': goodPrompt() }
    let submitted = []
    let mode = 'ok'
    const history = new Map()
    globalThis.WebSocket = undefined
    process.env.YAN_COMFYUI_URL = 'http://127.0.0.1:18188'
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url)
      const path = href.replace('http://127.0.0.1:18188', '')
      if (path === '/system_stats') return Response.json({ system: {} })
      if (path.startsWith('/api/userdata?')) return Response.json(Object.keys(saved))
      if (path.startsWith('/api/userdata/')) { const name = decodeURIComponent(path.slice('/api/userdata/'.length)).replace('workflows/', ''); return saved[name] ? Response.json(saved[name]) : new Response('', { status: 404 }) }
      if (path === '/object_info') return Response.json(info)
      if (path.startsWith('/object_info/')) { const type = decodeURIComponent(path.slice('/object_info/'.length)); return info[type] ? Response.json({ [type]: info[type] }) : Response.json({}) }
      if (path === '/upload/image') return Response.json({ name: 'up.png' })
      if (path === '/prompt' && init.method === 'POST') {
        const body = JSON.parse(init.body)
        submitted.push(body.prompt)
        if (mode === 'reject') return Response.json({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: { 5: { class_type: 'KSampler', errors: [{ type: 'value_smaller_than_min', message: 'Value 0 smaller than min of 1: steps', details: 'steps', extra_info: { input_name: 'steps' } }] } } }, { status: 400 })
        const id = `p${submitted.length}`
        history.set(id, mode === 'fail'
          ? { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_id: '5', node_type: 'KSampler', exception_type: 'RuntimeError', exception_message: 'CUDA out of memory', traceback: ['  File "x.py", line 1\n', 'torch.OutOfMemoryError'] }]] }, outputs: {} }
          : { status: { status_str: 'success', completed: true }, outputs: { 7: { images: [{ filename: 'raw_00001_.png', subfolder: '', type: 'output' }, { filename: 'raw_00002_.png', subfolder: '', type: 'output' }] }, 9: { text: ['caption text'] } } })
        return Response.json({ prompt_id: id })
      }
      if (path.startsWith('/history/')) { const id = decodeURIComponent(path.slice('/history/'.length)); return Response.json(history.has(id) ? { [id]: history.get(id) } : {}) }
      if (path.startsWith('/view?')) return new Response(PNG)
      if (path === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      throw new Error('Unexpected fixture request ' + href)
    }
    resetInfoCache()
    let confirms = 0
    let allow = false
    const service = createComfyService({ artifactDir, confirm: async () => { confirms++; return allow } })
    const context = { cwd: project }

    const overview = await service('nodes', { input: {}, context })
    ok(overview.total === 7 && overview.categories.loaders === 1, 'nodes without arguments gives a category overview')
    const found = await service('nodes', { input: { search: 'sampl' }, context })
    ok(found.nodes.length === 1 && found.nodes[0].type === 'KSampler' && found.nodes[0].required.sampler_name === 'COMBO(2 项)', 'nodes search matches by keyword')
    const detail = await service('nodes', { input: { types: ['KSampler', 'KSamplr'] }, context })
    ok(detail.nodes[0].required.steps.min === 1 && detail.nodes[0].required.sampler_name.options.includes('dpmpp_2m') && detail.nodes[0].outputs[0].type === 'LATENT', 'nodes types returns ranges, options and output slots')
    ok(detail.missing[0].similar.includes('KSampler'), 'unknown node types come with similar names')

    const read = await service('workflow', { input: { name: 'saved.json' }, context })
    ok(read.format === 'api' && read.prompt[5].class_type === 'KSampler' && !read.convertedFromUi, 'workflow read returns the API prompt inline')
    const out = await service('workflow', { input: { name: 'saved.json', outPath: 'work/flow.json' }, context })
    const onDisk = JSON.parse(await readFile(out.savedTo, 'utf8'))
    ok(onDisk[7].class_type === 'SaveImage', 'outPath writes the prompt to a project file')
    await assert.rejects(service('workflow', { input: { name: 'saved.json', outPath: 'work/flow.json' }, context }), /已存在/); checks++
    await assert.rejects(service('workflow', { input: { name: 'saved.json', outPath: '../escape.json' }, context }), /项目目录/); checks++
    await assert.rejects(service('workflow', { input: { path: '../x.json' }, context }), /项目目录/); checks++
    await assert.rejects(service('workflow', { input: { path: 'a.json', name: 'b.json' }, context }), /三选一/); checks++

    onDisk[5].inputs.steps = 0
    await writeFile(join(project, 'work', 'edit.json'), JSON.stringify(onDisk))
    const checked = await service('workflow', { input: { path: 'work/edit.json', mode: 'validate' }, context })
    ok(!checked.ok && checked.problems[0].node === '5' && checked.problems[0].input === 'steps' && !('prompt' in checked), 'validate on a project file reports the node and input')

    const uploaded = await service('upload', { input: { paths: ['work/pic.png'] }, context }).catch(error => error)
    ok(uploaded instanceof Error, 'upload rejects missing files')
    await writeFile(join(project, 'pic.png'), PNG)
    const up = await service('upload', { input: { paths: ['pic.png'] }, context })
    ok(up.uploaded[0].name === 'up.png' && up.uploaded[0].kind === 'image', 'upload returns the ComfyUI file name')

    submitted = []
    await assert.rejects(service('run', { input: { path: 'work/edit.json' }, context }), /校验未通过/)
    ok(submitted.length === 0, 'an invalid workflow is never submitted')

    const runResult = await service('run', { input: { prompt: goodPrompt() }, context })
    ok(submitted.length === 1 && runResult.files.length === 2 && runResult.files[0].kind === 'image' && runResult.texts[0].text === 'caption text', 'run saves every output image and text')
    ok((await readFile(runResult.files[0].path)).equals(PNG), 'saved output bytes match')

    mode = 'reject'
    submitted = []
    await assert.rejects(service('run', { input: { prompt: goodPrompt() }, context }), error => /节点 5（KSampler） 输入 steps：Value 0 smaller than min/.test(error.message))
    mode = 'fail'
    await assert.rejects(service('run', { input: { prompt: goodPrompt() }, context }), /节点 5（KSampler）执行失败：RuntimeError CUDA out of memory/); checks++
    mode = 'ok'

    const cloud = goodPrompt()
    cloud[8] = { class_type: 'FluxProTextNode', inputs: { prompt: 'x' } }
    cloud[9] = { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'cloud' } }
    submitted = []
    confirms = 0
    await assert.rejects(service('run', { input: { prompt: cloud }, context }), /未批准/)
    ok(confirms === 1 && submitted.length === 0, 'cloud API nodes always ask the user and are not submitted when denied')
    allow = true
    await service('run', { input: { prompt: cloud }, context })
    ok(confirms === 2 && submitted.length === 1, 'approved cloud API workflows are submitted')
    allow = false

    const job = await service('run', { input: { prompt: goodPrompt(), detach: true }, context })
    ok(job.state === 'running' && job.media === 'raw', 'run can detach into a background job')
    const done = await service('job', { input: { jobId: job.jobId, waitSeconds: 10 }, context })
    ok(done.state === 'done' && done.files.length === 2, 'detached run reports its files through job')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    if (originalUrl === undefined) delete process.env.YAN_COMFYUI_URL
    else process.env.YAN_COMFYUI_URL = originalUrl
    await rm(root, { recursive: true, force: true })
  }
  return checks
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('test-comfyui-raw.mjs')) {
  console.log(`comfyui raw: ${await runComfyRawTests()} checks passed`)
}
