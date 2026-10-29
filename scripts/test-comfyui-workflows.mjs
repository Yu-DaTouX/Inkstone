import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comfyImage, loadSources, sniffFormat } from '../integrations/comfyui/generation.mjs'
let workflowChecks = 0
function assert(condition, message) {
  workflowChecks++
  if (!condition) throw new Error(`artifact test failed: ${message}`)
}

const NO_PROVIDERS = { codex: false, openai: false, compatible: false, google: false, doubao: false, local: null }
const SD_SERVER = { kind: 'sdwebui', purpose: 'image', name: 'Stable Diffusion WebUI', baseUrl: 'http://127.0.0.1:7860', models: ['sdxl-base'], running: true }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test-png-body')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('test-jpeg-body')])

function credentials(secrets = {}, codex = null) {
  return {
    hasCodex: async () => !!codex,
    codex: async () => codex,
    secret: async (provider) => secrets[provider]
  }
}

async function withFetch(routes, fn) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const route = routes.find(([part]) => href.includes(part))
    if (!route) throw new Error(`unexpected request ${href}`)
    return route[1](href, init)
  }
  try {
    return { calls, result: await fn() }
  } finally {
    globalThis.fetch = original
  }
}

async function expectCode(fn, code, message) {
  try {
    await fn()
  } catch (error) {
    assert(error?.code === code, `${message} (got ${error?.code ?? error?.message})`)
    return
  }
  throw new Error(`artifact test failed: ${message} (no error)`)
}


export async function runComfyWorkflowTests() {
  workflowChecks = 0
  const root = await mkdtemp(join(tmpdir(), 'inkstone-comfy-workflows-'))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'source.png'), PNG)
  const ctx = extra => ({ cwd: project, artifactDir: root, ...extra })
  const generateImage = async (request, context) => {
    const sources = await loadSources(request.sourcePaths, context)
    const result = await comfyImage(request, sources, context.availability.local, false, undefined, undefined, context.confirmCloudNodes)
    return { ...result, artifact: { filename: 'fixture.' + sniffFormat(result.bytes) } }
  }
  try {
  const comfyServer = { kind: 'comfyui', purpose: 'image', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', models: ['01_t2i.json'], running: true }
  const t2iWorkflow = {
    nodes: [
      { id: 10, type: 'UNETLoader', widgets_values: ['qwen.safetensors', 'default'], outputs: [{ type: 'MODEL', links: [1] }] },
      { id: 11, type: 'CLIPLoader', widgets_values: ['te.safetensors', 'qwen_image', 'default'], outputs: [{ type: 'CLIP', links: [2] }] },
      { id: 12, type: 'TextEncodeQwenImage21', widgets_values: ['saved prompt', 'saved negative', 1024], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }, { name: 'prompt', widget: { name: 'prompt' } }], outputs: [{ type: 'CONDITIONING', links: [3] }, { type: 'CONDITIONING', links: [4] }] },
      { id: 13, type: 'ResolutionSelector', widgets_values: ['2:3', 1, 32], outputs: [{ type: 'INT', links: [5] }, { type: 'INT', links: [6] }] },
      { id: 14, type: 'EmptyLatentImage', widgets_values: [1024, 1024, 1], inputs: [{ name: 'width', link: 5, widget: { name: 'width' } }, { name: 'height', link: 6, widget: { name: 'height' } }], outputs: [{ type: 'LATENT', links: [7] }] },
      { id: 15, type: 'Reroute', inputs: [{ name: '', type: '*', link: 1 }], outputs: [{ type: 'MODEL', links: [8] }] },
      { id: 16, type: 'PrimitiveNode', widgets_values: [30, 'fixed'], outputs: [{ type: 'INT', links: [9] }] },
      { id: 17, type: 'KSampler', widgets_values: [123, 'randomize', 25, 1, 'euler', 'simple', 1], inputs: [{ name: 'model', link: 8 }, { name: 'positive', link: 3 }, { name: 'negative', link: 4 }, { name: 'latent_image', link: 7 }, { name: 'steps', link: 9, widget: { name: 'steps' } }], outputs: [{ type: 'LATENT', links: [10] }] },
      { id: 18, type: 'VAEDecode', inputs: [{ name: 'samples', link: 10 }], outputs: [{ type: 'IMAGE', links: [11] }] },
      { id: 19, type: 'SaveImage', widgets_values: ['MyPrefix'], inputs: [{ name: 'images', link: 11 }] },
      { id: 20, type: 'MarkdownNote', widgets_values: ['note'] },
      { id: 21, type: 'PreviewImage', mode: 2, inputs: [{ name: 'images', link: null }] }
    ],
    links: [[1, 10, 0, 15, 0, 'MODEL'], [2, 11, 0, 12, 0, 'CLIP'], [3, 12, 0, 17, 1, 'CONDITIONING'], [4, 12, 1, 17, 2, 'CONDITIONING'], [5, 13, 0, 14, 0, 'INT'], [6, 13, 1, 14, 1, 'INT'], [7, 14, 0, 17, 3, 'LATENT'], [8, 15, 0, 17, 0, 'MODEL'], [9, 16, 0, 17, 5, 'INT'], [10, 17, 0, 18, 0, 'LATENT'], [11, 18, 0, 19, 0, 'IMAGE']]
  }
  const videoWorkflow = { nodes: [{ id: 1, type: 'LoadVideo' }, { id: 2, type: 'KSampler' }, { id: 3, type: 'SaveVideo' }], links: [] }
  const objectInfo = {
    UNETLoader: { input: { required: { unet_name: [['qwen.safetensors']], weight_dtype: [['default']] } } },
    CLIPLoader: { input: { required: { clip_name: [['te.safetensors']], type: [['qwen_image']] }, optional: { device: [['default']] } } },
    TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING', { multiline: true }], negative_prompt: ['STRING'], resolution: ['INT'] } } },
    ResolutionSelector: { input: { required: { aspect_ratio: [['2:3']], megapixels: ['FLOAT'], multiple: ['INT'] } } },
    EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
    KSampler: { input: { required: { model: ['MODEL'], seed: ['INT', { control_after_generate: true }], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler']], scheduler: [['simple']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT'] } } },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } }
  }
  const comfy = await withFetch([
    ['/api/userdata?dir=workflows', async () => Response.json(['01_t2i.json', '03_video.json'])],
    ['/api/userdata/workflows%2F01_t2i.json', async () => Response.json(t2iWorkflow)],
    ['/api/userdata/workflows%2F03_video.json', async () => Response.json(videoWorkflow)],
    ['/object_info/', async (href) => {
      const type = decodeURIComponent(href.split('/object_info/')[1])
      return Response.json(objectInfo[type] ? { [type]: objectInfo[type] } : {})
    }],
    ['/prompt', async () => Response.json({ prompt_id: 'p1' })],
    ['/history/p1', async () => Response.json({ p1: { status: { completed: true }, outputs: { 19: { images: [{ filename: 'yan_0001.png', subfolder: 'Inkstone', type: 'output' }] } } } })],
    ['/view?', async () => new Response(PNG)]
  ], () => generateImage(
    { prompt: '梅', provider: 'local', size: '768x1152' },
    ctx({ credentials: credentials(), availability: { ...NO_PROVIDERS, local: comfyServer } })
  ))
  const posted = comfy.calls.find((call) => call.url.endsWith('/prompt')).body.prompt
  assert(posted['12'].inputs.prompt === '梅' && posted['12'].inputs.negative_prompt === 'saved negative', 'ComfyUI should replace only the positive prompt')
  assert(posted['17'].inputs.model[0] === '10' && posted['17'].inputs.steps === 30, 'Reroute and PrimitiveNode inputs should be resolved')
  assert(posted['17'].inputs.cfg === 1 && posted['17'].inputs.sampler_name === 'euler' && posted['17'].inputs.seed !== 123, 'seed control value should be skipped and the seed randomized')
  assert(posted['14'].inputs.width === 768 && posted['14'].inputs.height === 1152, 'requested size should override linked latent size')
  assert(posted['19'].inputs.filename_prefix === 'Inkstone/yan', 'save prefix should be namespaced')
  assert(!posted['15'] && !posted['16'] && !posted['20'] && !posted['21'], 'frontend-only and muted nodes should not be submitted')
  assert(comfy.calls.some((call) => call.url.includes('/view?filename=yan_0001.png&subfolder=Inkstone')), 'ComfyUI output should be fetched through /view')
  assert(comfy.result.model === '01_t2i.json' && comfy.result.artifact.filename.endsWith('.png'), 'ComfyUI result should record the workflow name')

  await withFetch([
    ['/api/userdata?dir=workflows', async () => Response.json(['01_t2i.json'])],
    ['/api/userdata/workflows%2F01_t2i.json', async () => Response.json(t2iWorkflow)]
  ], () => expectCode(
    () => generateImage(
      { prompt: 'x', provider: 'local', mode: 'edit', sourcePaths: ['source.png'] },
      ctx({ credentials: credentials(), availability: { ...NO_PROVIDERS, local: comfyServer } })
    ),
    'local_workflow_missing',
    'edit mode without an image-to-image workflow should say so'
  ))

  const subId = '1135e349-dce8-45e8-8905-aaa86675429b'
  const subWorkflow = {
    nodes: [
      { id: 200, type: subId, widgets_values: [], inputs: [], outputs: [{ type: 'IMAGE', links: [1] }], properties: { proxyWidgets: [['195', 'text'], ['197', 'seed']] } },
      { id: 9, type: 'SaveImage', widgets_values: ['flux'], inputs: [{ name: 'images', link: 1 }] }
    ],
    links: [[1, 200, 0, 9, 0, 'IMAGE']],
    definitions: { subgraphs: [{
      id: subId,
      inputs: [{ name: 'text', type: 'STRING', linkIds: [71] }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [9] }],
      nodes: [
        { id: 63, type: 'DualCLIPLoader', widgets_values: ['clip_l.safetensors', 't5.safetensors', 'flux', 'default'] },
        { id: 195, type: 'CLIPTextEncode', widgets_values: ['inner saved prompt'], inputs: [{ name: 'clip', link: 64 }, { name: 'text', link: 71, widget: { name: 'text' } }] },
        { id: 199, type: 'ConditioningZeroOut', inputs: [{ name: 'conditioning', link: 66 }] },
        { id: 196, type: 'EmptySD3LatentImage', widgets_values: [1024, 1024, 1] },
        { id: 197, type: 'KSampler', widgets_values: [5, 'randomize', 20, 1, 'euler', 'simple', 1], inputs: [{ name: 'positive', link: 65 }, { name: 'negative', link: 63 }, { name: 'latent_image', link: 51 }] },
        { id: 198, type: 'VAEDecode', inputs: [{ name: 'samples', link: 52 }] }
      ],
      links: [
        { id: 64, origin_id: 63, origin_slot: 0, target_id: 195, target_slot: 0 },
        { id: 71, origin_id: -10, origin_slot: 0, target_id: 195, target_slot: 1 },
        { id: 66, origin_id: 195, origin_slot: 0, target_id: 199, target_slot: 0 },
        { id: 65, origin_id: 195, origin_slot: 0, target_id: 197, target_slot: 0 },
        { id: 63, origin_id: 199, origin_slot: 0, target_id: 197, target_slot: 1 },
        { id: 51, origin_id: 196, origin_slot: 0, target_id: 197, target_slot: 2 },
        { id: 52, origin_id: 197, origin_slot: 0, target_id: 198, target_slot: 0 },
        { id: 9, origin_id: 198, origin_slot: 0, target_id: -20, target_slot: 0 }
      ]
    }] }
  }
  const cloudWorkflow = { nodes: [{ id: 1, type: 'FluxProTextNode', widgets_values: ['p'] }, { id: 2, type: 'CLIPTextEncode', widgets_values: ['x'] }, { id: 3, type: 'KSampler', widgets_values: [] }, { id: 4, type: 'SaveImage', widgets_values: ['y'] }], links: [] }
  const subInfo = {
    ...objectInfo,
    DualCLIPLoader: { input: { required: { clip_name1: [['a']], clip_name2: [['b']], type: [['flux']] }, optional: { device: [['default']] } } },
    CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
    ConditioningZeroOut: { input: { required: { conditioning: ['CONDITIONING'] } } },
    EmptySD3LatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
    FluxProTextNode: { input: { required: { prompt: ['STRING'] } }, api_node: true }
  }
  const sub = await withFetch([
    ['/api/userdata?dir=workflows', async () => Response.json(['a_cloud.json', 'b_sub.json'])],
    ['/api/userdata/workflows%2Fa_cloud.json', async () => Response.json(cloudWorkflow)],
    ['/api/userdata/workflows%2Fb_sub.json', async () => Response.json(subWorkflow)],
    ['/object_info/', async (href) => {
      const type = decodeURIComponent(href.split('/object_info/')[1])
      return Response.json(subInfo[type] ? { [type]: subInfo[type] } : {})
    }],
    ['/prompt', async () => Response.json({ prompt_id: 'p2' })],
    ['/history/p2', async () => Response.json({ p2: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'yan_0002.png', subfolder: 'Inkstone', type: 'output' }] } } } })],
    ['/view?', async () => new Response(PNG)]
  ], () => generateImage(
    { prompt: '竹林', provider: 'local', size: '1216x832' },
    ctx({ credentials: credentials(), availability: { ...NO_PROVIDERS, local: comfyServer } })
  ))
  const subPosted = sub.calls.find((call) => call.url.endsWith('/prompt')).body.prompt
  assert(sub.result.model === 'b_sub.json', 'workflows that need ComfyUI cloud API nodes should be skipped')
  assert(subPosted['200:195'].inputs.text === '竹林' && subPosted['200:195'].inputs.clip[0] === '200:63', 'subgraph nodes should be flattened with instance-prefixed ids')
  assert(subPosted['200:197'].inputs.positive[0] === '200:195' && subPosted['200:197'].inputs.negative[0] === '200:199', 'subgraph links should resolve inside the instance')
  assert(subPosted['9'].inputs.images[0] === '200:198', 'outer links from a subgraph output should resolve to the inner node')
  let cloudAsked = ''
  const namedCloud = await withFetch([
    ['/api/userdata?dir=workflows', async () => Response.json(['a_cloud.json', 'b_sub.json'])],
    ['/api/userdata/workflows%2Fa_cloud.json', async () => Response.json(cloudWorkflow)],
    ['/object_info/', async (href) => {
      const type = decodeURIComponent(href.split('/object_info/')[1])
      return Response.json(subInfo[type] ? { [type]: subInfo[type] } : {})
    }]
  ], () => generateImage(
    { prompt: '\u7af9\u6797', provider: 'local', model: 'a_cloud' },
    ctx({ credentials: credentials(), availability: { ...NO_PROVIDERS, local: comfyServer }, confirmCloudNodes: async (workflow) => { cloudAsked = workflow; return false } })
  ).then(() => 'generated', (error) => error.code))
  assert(cloudAsked === 'a_cloud.json' && namedCloud.result === 'local_workflow_unsupported' && !namedCloud.calls.some((call) => call.url.endsWith('/prompt')), 'a model-named workflow with cloud API nodes asks first and is not queued when denied')
  assert(subPosted['200:196'].inputs.width === 1216 && !subPosted['200'], 'size applies inside subgraphs and the instance itself is not submitted')


  } finally { await rm(root, { recursive: true, force: true }) }
  console.log(`comfyui-workflows: ${workflowChecks} checks passed (UI/API, subgraphs, cloud-node denial)`)
  return workflowChecks
}
