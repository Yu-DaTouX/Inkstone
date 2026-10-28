import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function createSandbox(runDir, { fakePort, samples = [] } = {}) {
  const box = {
    runDir,
    piDir: join(runDir, 'pi-agent'),
    sessionsDir: join(runDir, 'pi-agent', 'sessions'),
    dataDir: join(runDir, 'yan'),
    userData: join(runDir, 'electron'),
    downloads: join(runDir, 'downloads'),
    project: join(runDir, 'project'),
    samples: []
  }
  for (const dir of [box.piDir, box.sessionsDir, box.dataDir, box.userData, box.downloads, box.project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(box.project, 'README.md'), '# debug fixture\n')
  if (fakePort) {
    writeFileSync(join(box.piDir, 'models.json'), JSON.stringify({
      providers: { fake: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, api: 'openai-responses', apiKey: 'fake-key', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text', 'image'], contextWindow: 400000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }
    }))
    writeFileSync(join(box.piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }))
  }
  const realBin = join(homedir(), '.pi', 'agent', 'bin')
  if (existsSync(realBin)) cpSync(realBin, join(box.piDir, 'bin'), { recursive: true })
  for (const sample of samples) {
    const target = join(box.sessionsDir, sample.bucket, sample.file)
    mkdirSync(join(box.sessionsDir, sample.bucket), { recursive: true })
    cpSync(sample.path, target)
    box.samples.push(target)
  }
  return box
}

export function sandboxEnv(box, { fake = false, cdpPort, probe } = {}) {
  return {
    YAN_PI_DIR: box.piDir,
    YAN_DATA_DIR: box.dataDir,
    YAN_USER_DATA: box.userData,
    YAN_DOWNLOADS_DIR: box.downloads,
    ...(fake ? { YAN_TEST_MODEL: 'fake/fake-model' } : {}),
    ...(probe ? { YAN_PROBE: probe, YAN_PROBE_DELAY: '500' } : {}),
    ...(probe && cdpPort ? { YAN_PROBE_DEBUG_PORT: String(cdpPort) } : {})
  }
}
