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

  console.log('artifact: image adapters (Google, Doubao, Codex, edit sources, SD WebUI) passed')
}

async function runVersionAndPortabilityTests(ArtifactStore, project) {
  const { mkdir, readdir, rename } = await import('node:fs/promises')
  const base = await mkdtemp(join(tmpdir(), 'yan-artifact-versions-'))
  try {
    const root = join(base, 'artifacts')
    const session = join(base, 'sessions', 'a.jsonl')
    await mkdir(join(base, 'sessions'), { recursive: true })
    const legacyStore = new ArtifactStore(root)
    const legacy = await legacyStore.save({ sessionFile: session, messageId: 'm-legacy', filename: 'old.txt', bytes: Buffer.from('legacy') })
    await writeFile(session, `${JSON.stringify({ type: 'session', version: 3, id: 'sess-0001-abcd', cwd: project })}\n`)

    const store = new ArtifactStore(root)
    const adopted = await store.list(session)
    assert(adopted.some((item) => item.artifact.id === legacy.id), 'legacy path-hash artifacts should be adopted into the session-id directory')
    assert((await readdir(root)).includes('s-sess-0001-abcd'), 'artifacts should be keyed by the session header id')
    assert(!(await readdir(root)).some((name) => /^[0-9a-f]{32}$/.test(name)), 'the legacy directory should be gone after adoption')

    const page = join(project, 'report.html')
    await writeFile(page, '<h1>v1</h1>')
    const v1 = await store.attach({ sessionFile: session, messageId: 'm1', cwd: project, sourcePath: 'report.html' })
    const same = await store.attach({ sessionFile: session, messageId: 'm2', cwd: project, sourcePath: 'report.html' })
    await writeFile(page, '<h1>v2</h1>')
    const v2 = await store.attach({ sessionFile: session, messageId: 'm3', cwd: project, sourcePath: 'report.html' })
    assert(v1.version === 1 && same.version === 1 && v2.version === 2, `same path re-attach should version by content (${v1.version},${same.version},${v2.version})`)
    assert(v1.sourceId === v2.sourceId && v1.sourceId.startsWith('file:'), 'versions share a path-based sourceId')
    assert(same.path === v1.path && v2.path !== v1.path, 'identical content should reuse the stored file')
    const repeat = await store.attach({ sessionFile: session, messageId: 'm3', cwd: project, sourcePath: 'report.html' })
    assert(repeat.id === v2.id, 'repeating an unchanged attach on the same message should return the existing record')
    assert((await store.list(session)).filter((item) => item.messageId === 'm3').length === 1, 'repeating an unchanged attach should not add a manifest record')

    await writeFile(join(project, 'scene.html'), '<!doctype html><script data-yan-lib="three"></script><script>new THREE.Scene()</script>')
    const scene = await store.attach({ sessionFile: session, messageId: 'm-3d', cwd: project, sourcePath: 'scene.html' })
    const stored = await readFile(scene.path, 'utf8')
    assert(!stored.includes('data-yan-lib="three"') && stored.includes('data-yan-lib-inline="three"') && stored.includes('WebGLRenderer'), 'attaching HTML with a bundled-library tag should inline the library into the stored copy')
    assert((await readFile(join(project, 'scene.html'), 'utf8')).includes('data-yan-lib="three"'), 'the project source keeps its library tag')

    const many = await Promise.all(Array.from({ length: 205 }, (_, i) => store.save({ sessionFile: session, messageId: `many-${i}`, filename: `n-${i}.txt`, bytes: Buffer.from(`n${i}`) })))
    const all = await store.list(session)
    assert(all.some((item) => item.artifact.id === legacy.id) && all.some((item) => item.artifact.id === many[204].id), 'the manifest must not drop old records past 200 items')

    const moved = join(base, 'moved-artifacts')
    await rename(root, moved)
    const relocated = await new ArtifactStore(moved).hydrateMessages(session, [{ id: 'm3', role: 'assistant', text: '' }])
    const restored = relocated[0].artifacts?.find((item) => item.id === v2.id)
    assert(restored && !restored.unavailable && restored.path.startsWith(moved), 'artifacts should survive moving the data directory')
    console.log('artifact: session-id keying, legacy adoption, path versions, content dedupe, no manifest cap, relocation passed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
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
    assert(generated.previewable === true && generated.kind === 'image', 'PNG 产物仍按图片可预览')

    const officeDoc = await store.save({ sessionFile, messageId: 'assistant-office', filename: '报告.docx', bytes: Buffer.from('fake-docx-body') })
    assert(
      officeDoc.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Word 产物应带 docx 的 MIME 而不是 application/octet-stream',
      officeDoc.mediaType
    )
    assert(officeDoc.kind === 'document' && officeDoc.previewable === true, 'Word 产物应可预览（走自带 office 预览）', officeDoc)
    const officeSheet = await store.save({ sessionFile, messageId: 'assistant-office', filename: '对比.xlsx', bytes: Buffer.from('fake-xlsx-body') })
    assert(officeSheet.kind === 'document' && officeSheet.previewable === true, 'Excel 产物应可预览', officeSheet)
    const zipThatIsNotOffice = await store.save({ sessionFile, messageId: 'assistant-zip', filename: 'bundle.zip', bytes: Buffer.from('fake-zip') })
    assert(zipThatIsNotOffice.previewable === false && zipThatIsNotOffice.kind === 'binary', '普通压缩包不应被当成可预览文档')

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

    await runVersionAndPortabilityTests(ArtifactStore, project)

    delete process.env.YAN_IMAGE_PROVIDER
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, codex: true, google: true }) === 'codex', 'auto should prefer Codex auth')
    assert(resolveImageProvider('compatible', NO_PROVIDERS) === 'compatible', 'explicit compatible should remain compatible')
    assert(resolveImageProvider('auto', NO_PROVIDERS) === 'unavailable', 'auto should not silently fall back to mock')
    assert(resolveImageProvider(undefined, { ...NO_PROVIDERS, google: true, doubao: true }) === 'google', 'auto should pick Google before Doubao')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, doubao: true, local: SD_SERVER }) === 'doubao', 'cloud keys should come before local services')
    assert(resolveImageProvider('auto', { ...NO_PROVIDERS, local: SD_SERVER }) === 'local', 'auto should use a detected local service last')
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
