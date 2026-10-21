import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition, message) {
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

async function runImageAdapterTests({ generateImage, root, project, sessionFile }) {
  const ctx = (extra) => ({ sessionFile, messageId: 'assistant-adapter', artifactDir: root, cwd: project, ...extra })

  const googleModels = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-4-flash-image-preview']
  const google = await withFetch([
    ['/models?pageSize', async () => Response.json({ models: googleModels.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) })],
    [':generateContent', async () => Response.json({
      candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/jpeg', data: JPEG.toString('base64') } }] } }]
    })]
  ], () => generateImage(
    { prompt: '山水', provider: 'google', size: '1536x1024' },
    ctx({ credentials: credentials({ google: 'g-key' }), availability: { ...NO_PROVIDERS, google: true } })
  ))
  const googleCall = google.calls.find((call) => call.url.includes(':generateContent'))
  assert(googleCall.url.endsWith('/models/gemini-3.1-flash-image:generateContent') && google.result.model === 'gemini-3.1-flash-image', 'Google should pick the newest stable flash image model from the list')
  assert(googleCall.init.headers['x-goog-api-key'] === 'g-key', 'Google should send the API key header')
  assert(googleCall.body.generationConfig.imageConfig.aspectRatio === '3:2', 'Google should map size to an aspect ratio')
  assert(google.result.artifact.filename.endsWith('.jpeg') && google.result.provider === 'google', 'Google JPEG output should be saved as .jpeg')

  const doubao = await withFetch([
    ['/api/v3/models', async () => Response.json({ data: [
      { id: 'doubao-seedream-4-5-251128', status: 'Retiring', task_type: ['TextToImage', 'ImageToImage'] },
      { id: 'doubao-seedream-3-0-t2i-250415', status: 'Shutdown', task_type: ['TextToImage'] },
      { id: 'doubao-seededit-3-0-i2i-250628', task_type: ['ImageToImage'] },
      { id: 'doubao-seedream-5-0-pro-260628', task_type: ['TextToImage', 'ImageToImage'] },
      { id: 'doubao-seedream-5-0-flash-260915' }
    ] })],
    ['/images/generations', async () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] })]
  ], () => generateImage(
    { prompt: '水墨', provider: 'doubao', size: '1024x1024' },
    ctx({ credentials: credentials({ doubao: 'ark-key' }), availability: { ...NO_PROVIDERS, doubao: true } })
  ))
  const doubaoCall = doubao.calls.find((call) => call.url.endsWith('/images/generations'))
  assert(doubaoCall.url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations', 'Doubao should call the Ark endpoint')
  assert(doubaoCall.init.headers.Authorization === 'Bearer ark-key', 'Doubao should send a bearer key')
  const doubaoBody = doubaoCall.body
  assert(doubaoBody.model === 'doubao-seedream-5-0-flash-260915', 'Doubao should pick the newest Seedream that is not retiring')
  assert(doubaoBody.response_format === 'b64_json' && doubaoBody.watermark === false && doubaoBody.size === '1920x1920' && !('sequential_image_generation' in doubaoBody), 'Doubao request should ask for base64 output without watermark')
  assert(doubao.result.artifact.filename.endsWith('.png'), 'Doubao PNG output should be saved as .png')

  const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  const codexAuth = { access: 'yan-token', accountId: 'acc-1', source: 'yan' }
  const codex = await withFetch([['/codex/responses', async () => sse([
    { type: 'response.image_generation_call.partial_image' },
    { type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG.toString('base64'), revised_prompt: 'revised' } }
  ])]], () => generateImage(
    { prompt: '印章', provider: 'codex', model: 'gpt-image-2.5-sunburst' },
    ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })
  ))
  const codexCall = codex.calls[0]
  assert(codexCall.init.headers.originator === 'pi' && codexCall.init.headers['chatgpt-account-id'] === 'acc-1', 'Codex should use the in-app login headers')
  assert(codexCall.body.model === 'gpt-6-luna' && /verbatim/.test(codexCall.body.instructions), 'gpt-image-* must not be sent as the chat model; the cheap relay passes the prompt verbatim')
  assert(codexCall.body.reasoning.effort === 'low', 'the relay model should run with low reasoning')
  assert(codexCall.body.tools[0].model === 'gpt-image-2.5-sunburst', 'Codex should pin the requested image model on the tool')
  assert(codex.result.revisedPrompt === 'revised' && codex.result.model === 'gpt-image-2.5-sunburst', 'Codex result should keep the revised prompt and image model label')

  let codexTries = 0
  const codexFallback = await withFetch([['/codex/responses', async () => (++codexTries === 1
    ? new Response('{"error":{"message":"Unsupported model for image_generation"}}', { status: 400 })
    : sse([{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG.toString('base64') } }]))]], () => generateImage(
    { prompt: '印章', provider: 'codex' },
    ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })
  ))
  assert(codexFallback.calls[0].body.tools[0].model === 'gpt-image-2.5-flare', 'Codex should default to GPT Image 2.5 Flare')
  assert(codexFallback.calls.length === 2 && !('model' in codexFallback.calls[1].body.tools[0]), 'Codex should retry without a pinned image model')
  assert(codexFallback.result.model === 'chatgpt-default', 'fallback images should not claim a specific image model')

  let relayTries = 0
  const relayFallback = await withFetch([['/codex/responses', async () => (++relayTries === 1
    ? new Response('{"detail":"The \'gpt-6-luna\' model is not supported when using Codex with a ChatGPT account."}', { status: 400 })
    : sse([{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG.toString('base64') } }]))]], () => generateImage(
    { prompt: '印章', provider: 'codex' },
    ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })
  ))
  assert(relayFallback.calls[1].body.model === 'gpt-5.5' && relayFallback.calls[1].body.tools[0].model === 'gpt-image-2.5-flare', 'an unavailable relay model should fall back to gpt-5.5')
  assert(relayFallback.result.model === 'gpt-image-2.5-flare', 'relay fallback keeps the pinned image model label')

  await withFetch([['/codex/responses', async () => sse([{ type: 'response.failed', response: { error: { message: 'quota' } } }])]], () => expectCode(
    () => generateImage({ prompt: 'x', provider: 'codex' }, ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })),
    'codex_response_failed',
    'Codex failure events should surface as codex_response_failed'
  ))
  await withFetch([['/codex/responses', async () => sse([{ type: 'response.output_text.delta', delta: 'I cannot edit this image.' }, { type: 'response.completed', response: { output: [] } }])]], () => expectCode(
    () => generateImage({ prompt: 'x', provider: 'codex' }, ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })),
    'codex_image_tool_not_called',
    'a text-only Codex reply should say the image tool was not called'
  ))
  const completedOnly = await withFetch([['/codex/responses', async () => sse([{ type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: PNG.toString('base64') }] } }])]], () => generateImage(
    { prompt: '印章', provider: 'codex' },
    ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })
  ))
  assert(completedOnly.result.model === 'gpt-image-2.5-flare', 'an image carried only in response.completed output should still be used')
  await withFetch([['/codex/responses', async () => new Response('{"error":{"message":"expired"}}', { status: 401 })]], () => expectCode(
    () => generateImage({ prompt: 'x', provider: 'codex' }, ctx({ credentials: credentials({}, codexAuth), availability: { ...NO_PROVIDERS, codex: true } })),
    'codex_auth_rejected',
    'Codex 401 should map to codex_auth_rejected'
  ))

  const outside = await withFetch([], () => expectCode(
    () => generateImage(
      { prompt: 'x', provider: 'google', mode: 'edit', sourcePaths: ['../outside.png'] },
      ctx({ credentials: credentials({ google: 'g-key' }), availability: { ...NO_PROVIDERS, google: true } })
    ),
    'image_source_outside_project',
    'edit sources outside the project should be rejected'
  ))
  assert(outside.calls.length === 0, 'rejected edit sources must not reach the network')
  await writeFile(join(project, 'source.png'), PNG)
  const edit = await withFetch([[':generateContent', async () => Response.json({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }]
  })]], () => generateImage(
    { prompt: '换成夜景', provider: 'google', mode: 'edit', sourcePaths: ['source.png'] },
    ctx({ credentials: credentials({ google: 'g-key' }), availability: { ...NO_PROVIDERS, google: true } })
  ))
  assert(edit.calls[0].body.contents[0].parts[1].inlineData.data === PNG.toString('base64'), 'edit sources should be sent as inline images')

  const sd = await withFetch([['/sdapi/v1/txt2img', async () => Response.json({ images: [PNG.toString('base64')] })]], () => generateImage(
    { prompt: '竹', provider: 'local', size: '512x768' },
    ctx({ credentials: credentials(), availability: { ...NO_PROVIDERS, local: SD_SERVER } })
  ))
  assert(sd.calls[0].body.override_settings.sd_model_checkpoint === 'sdxl-base' && sd.calls[0].body.width === 512, 'SD WebUI should receive checkpoint and size')
  assert(sd.result.provider === 'local' && sd.result.model === 'sdxl-base', 'local result should record the checkpoint')

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
  assert(subPosted['200:196'].inputs.width === 1216 && !subPosted['200'], 'size applies inside subgraphs and the instance itself is not submitted')

  console.log('artifact: image adapters (Google, Doubao, Codex, edit sources, SD WebUI, ComfyUI workflows incl. subgraphs) passed')
}

export async function runArtifactTests(modules = {}) {
  const { ArtifactStore } = modules.artifacts ?? await import('../out/test/artifacts.mjs')
  const { generateImage, resolveImageProvider, seedreamSize, nearestAspectRatio } = modules.images ?? await import('../out/test/image-generation.mjs')
  const { AgentController } = modules.agent ?? await import('../out/test/agent.mjs')
  const root = await mkdtemp(join(tmpdir(), 'yan-artifacts-'))
  const project = await mkdtemp(join(tmpdir(), 'yan-artifact-project-'))
  const sessionFile = join(project, 'session.jsonl')
  const store = new ArtifactStore(root)
  const previousProvider = process.env.YAN_IMAGE_PROVIDER

  try {
    process.env.YAN_IMAGE_PROVIDER = 'mock'
    const progressStages = []
    const result = await generateImage(
      { prompt: '一枚深色圆角方形图标', provider: 'mock', format: 'png' },
      { sessionFile, messageId: 'assistant-1', artifactDir: root, availability: NO_PROVIDERS, onProgress: (stage) => progressStages.push(stage) }
    )
    assert(result.provider === 'mock', 'mock provider should be selected')
    assert(result.artifact.kind === 'svg', 'mock output should be SVG')
    assert((await stat(result.artifact.path)).size === result.artifact.bytes, 'artifact byte count should match disk')
    assert(progressStages.join(',') === 'preparing,generating,saving,done', 'mock generation should publish progress stages')

    const messages = await store.hydrateMessages(sessionFile, [{ id: 'assistant-1', role: 'assistant', text: '' }])
    assert(messages[0].artifacts?.some((item) => item.id === result.artifact.id), 'manifest should restore artifact on history load')
    await rm(result.artifact.path, { force: true })
    const unavailableMessages = await store.hydrateMessages(sessionFile, [{ id: 'assistant-1', role: 'assistant', text: '' }])
    assert(
      unavailableMessages[0].artifacts?.some((item) => item.id === result.artifact.id && item.unavailable === true),
      'history should retain an unavailable artifact card when the source file is missing'
    )

    const unsafe = await store.save({
      sessionFile,
      messageId: 'assistant-2',
      filename: 'unsafe.svg',
      bytes: Buffer.from('<svg><script>alert(1)</script><rect onload="bad" /></svg>')
    })
    const sanitized = await readFile(unsafe.path, 'utf8')
    assert(!sanitized.includes('<script') && !sanitized.includes('onload='), 'SVG executable content should be removed')

    const empty = join(project, 'empty.png')
    await writeFile(empty, Buffer.alloc(0))
    let emptyRejected = false
    try {
      await store.attach({ sessionFile, messageId: 'assistant-empty', cwd: project, sourcePath: empty })
    } catch (error) {
      emptyRejected = error instanceof Error && error.message === 'artifact_empty'
    }
    assert(emptyRejected, 'empty artifacts should be rejected before they reach the renderer')

    const external = join(project, '..', 'outside-artifact.txt')
    await writeFile(external, 'outside')
    let rejected = false
    try {
      await store.attach({ sessionFile, messageId: 'assistant-3', cwd: project, sourcePath: external })
    } catch (error) {
      rejected = error instanceof Error && error.message === 'artifact_path_outside_project'
    }
    assert(rejected, 'artifact attach should reject paths outside the project')
    await rm(external, { force: true })

    const inside = join(project, 'notes.md')
    await writeFile(inside, '# 笔记\n')
    const attached = await store.attach({ sessionFile, messageId: 'assistant-attach', cwd: project, sourcePath: 'notes.md' })
    assert(attached.sourcePath === (await realpath(inside)), 'attached artifact should remember the source file path')
    assert(attached.path !== attached.sourcePath, 'preview should still read the controlled copy, not the source file')
    const generated = await store.save({ sessionFile, messageId: 'assistant-generated', filename: 'shot.png', bytes: PNG })
    assert(generated.sourcePath === undefined, 'generated artifacts have no source file to open')

    const bulk = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.save({
          sessionFile,
          messageId: `bulk-${i}`,
          filename: `bulk-${i}.txt`,
          bytes: Buffer.from(`bulk payload ${i}`)
        })
      )
    )
    const manifest = await store.list(sessionFile)
    const manifestIds = new Set(manifest.map((item) => item.artifact.id))
    assert(bulk.every((artifact) => manifestIds.has(artifact.id)), 'concurrent saves must all stay in the manifest')
    assert(
      manifest.filter((item) => item.messageId.startsWith('bulk-')).length === 8,
      'concurrent saves must not overwrite each other in the manifest'
    )

    delete process.env.YAN_IMAGE_PROVIDER
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, codex: true, google: true }) === 'codex', 'auto should prefer Codex auth')
    assert(resolveImageProvider('compatible', NO_PROVIDERS) === 'compatible', 'explicit compatible should remain compatible')
    assert(resolveImageProvider('auto', NO_PROVIDERS) === 'unavailable', 'auto should not silently fall back to mock')
    assert(resolveImageProvider(undefined, { ...NO_PROVIDERS, google: true, doubao: true }) === 'google', 'auto should pick Google before Doubao')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, doubao: true, local: SD_SERVER }) === 'doubao', 'cloud keys should come before local services')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, local: SD_SERVER }) === 'local', 'auto should use a detected local service last')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, localLaunch: 'E:/ComfyUI' }) === 'local', 'an installed ComfyUI that can be launched on demand counts as a local channel')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, google: true, localLaunch: 'E:/ComfyUI' }) === 'google', 'on-demand local launch stays behind configured cloud keys')
    assert(seedreamSize('1024x1024') === '1920x1920', 'Seedream sizes below the pixel floor should scale up')
    assert(seedreamSize('1536x1024') === '2352x1568', 'Seedream scaling should keep the aspect ratio')
    assert(seedreamSize('2048x2048') === '2048x2048' && seedreamSize('4k') === '4K' && seedreamSize(undefined) === '2K', 'Seedream sizes above the floor and K presets pass through')
    assert(nearestAspectRatio('1536x1024') === '3:2' && nearestAspectRatio('1920x1080') === '16:9' && nearestAspectRatio('auto') === undefined, 'Gemini aspect ratio should snap to supported values')

    await runImageAdapterTests({ generateImage, root, project, sessionFile })

    const previousBase = process.env.YAN_IMAGE_API_BASE
    const previousKey = process.env.YAN_IMAGE_API_KEY
    const previousOpenAiKey = process.env.OPENAI_API_KEY
    const previousProviderForGate = process.env.YAN_IMAGE_PROVIDER
    let networkCalled = false
    const originalFetch = globalThis.fetch
    process.env.YAN_IMAGE_PROVIDER = 'compatible'
    process.env.YAN_IMAGE_API_BASE = 'http://127.0.0.1:9/v1'
    process.env.YAN_IMAGE_API_KEY = 'test-only-key'
    delete process.env.OPENAI_API_KEY
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('http://127.0.0.1:9/')) networkCalled = true
      throw new Error('network should not be called after denial')
    }
    try {
      const agent = new AgentController({
        cwd: project,
        push: () => {},
        confirmExternalApi: async () => false,
        capability: {
          sessionId: 'artifact-gate-test',
          projectId: 'artifact-gate-project',
          opsDir: root,
          binDir: root,
          artifactDir: root
        }
      })
      agent['state'] = { sessionFile }
      let denied = false
      try {
        await agent['runCapabilityCommand']('image.generate', { prompt: 'gate test', provider: 'compatible' })
      } catch (error) {
        denied = error?.code === 'external_api_denied'
      }
      assert(denied, 'compatible image requests should stop when confirmation is denied')
      assert(!networkCalled, 'denied compatible image requests must not reach fetch')
    } finally {
      globalThis.fetch = originalFetch
      if (previousBase === undefined) delete process.env.YAN_IMAGE_API_BASE
      else process.env.YAN_IMAGE_API_BASE = previousBase
      if (previousKey === undefined) delete process.env.YAN_IMAGE_API_KEY
      else process.env.YAN_IMAGE_API_KEY = previousKey
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAiKey
      if (previousProviderForGate === undefined) delete process.env.YAN_IMAGE_PROVIDER
      else process.env.YAN_IMAGE_PROVIDER = previousProviderForGate
    }
    console.log('artifact: mock generation, manifest restore, SVG sanitization, path boundary, provider selection, external API confirmation gate passed')
  } finally {
    if (previousProvider === undefined) delete process.env.YAN_IMAGE_PROVIDER
    else process.env.YAN_IMAGE_PROVIDER = previousProvider
    await rm(root, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  await runArtifactTests()
}
