import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(`artifact test failed: ${message}`)
}

export async function runArtifactTests() {
  const { ArtifactStore } = await import('../out/test/artifacts.mjs')
  const { generateImage, resolveImageProvider } = await import('../out/test/image-generation.mjs')
  const { AgentController } = await import('../out/test/agent.mjs')
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
      { sessionFile, messageId: 'assistant-1', artifactDir: root, onProgress: (stage) => progressStages.push(stage) }
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

    delete process.env.YAN_IMAGE_PROVIDER
    assert(resolveImageProvider('auto', true, false) === 'codex', 'auto should prefer Codex auth')
    assert(resolveImageProvider('compatible', false, false) === 'compatible', 'explicit compatible should remain compatible')
    assert(resolveImageProvider('auto', false, false) === 'unavailable', 'auto should not silently fall back to mock')

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
    globalThis.fetch = async () => {
      networkCalled = true
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
