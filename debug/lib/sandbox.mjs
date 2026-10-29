import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FIXTURE_ROOT = process.env.YAN_DEBUG_FIXTURES || 'E:/Harness-test/tasks'
const FIXTURE_TASKS = ['40-ledger-incident', '30-async-refactor', '50-expr-lang', '10-cache-bugs', '20-csv-spec']

function gitInit(dir) {
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Inkstone Debug', '-c', 'user.email=debug@inkstone.invalid', ...args], { cwd: dir, stdio: 'ignore', windowsHide: true })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
}

function seedProjects(root) {
  const projects = []
  for (const task of FIXTURE_TASKS) {
    const source = join(FIXTURE_ROOT, task, 'fixture')
    if (!existsSync(source)) continue
    const target = join(root, task.replace(/^\d+-/, ''))
    cpSync(source, target, { recursive: true, filter: (path) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(path) })
    gitInit(target)
    projects.push(target)
  }
  return projects
}

export function createSandbox(runDir, { fakePort, samples = [] } = {}) {
  const box = {
    runDir,
    piDir: join(runDir, 'pi-agent'),
    sessionsDir: join(runDir, 'pi-agent', 'sessions'),
    dataDir: join(runDir, 'yan'),
    userData: join(runDir, 'electron'),
    downloads: join(runDir, 'downloads'),
    project: join(runDir, 'project'),
    projects: [],
    samples: []
  }
  for (const dir of [box.piDir, box.sessionsDir, box.dataDir, box.userData, box.downloads]) mkdirSync(dir, { recursive: true })
  box.projects = seedProjects(join(runDir, 'projects'))
  if (box.projects.length > 0) box.project = box.projects[0]
  else {
    mkdirSync(box.project, { recursive: true })
    writeFileSync(join(box.project, 'README.md'), '# debug fixture\n')
    gitInit(box.project)
    box.projects = [box.project]
  }
  writeFileSync(join(box.dataDir, 'desktop.json'), JSON.stringify({ cwd: box.project, recentCwds: box.projects }))
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
