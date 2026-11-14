import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fixtureRoot, userSnapshotDir } from './env.mjs'
import { restoreSample } from './sessions.mjs'
import { linkOrCopy, linkTree, mirrorTree } from './shared-files.mjs'

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
    const source = join(fixtureRoot, task, 'fixture')
    if (!existsSync(source)) continue
    const target = join(root, task.replace(/^\d+-/, ''))
    cpSync(source, target, { recursive: true, filter: (path) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(path) })
    gitInit(target)
    projects.push(target)
  }
  return projects
}

export function createSandbox(runDir, { fakePort, samples = [], demo = false } = {}) {
  const box = {
    runDir,
    piDir: join(runDir, 'pi-agent'),
    sessionsDir: join(runDir, 'pi-agent', 'sessions'),
    dataDir: join(runDir, 'yan'),
    userData: join(runDir, 'electron'),
    downloads: join(runDir, 'downloads'),
    androidSdk: join(runDir, 'android-sdk'),
    project: join(runDir, 'project'),
    projects: [],
    samples: []
  }
  for (const dir of [box.piDir, box.sessionsDir, box.dataDir, box.userData, box.downloads, box.androidSdk]) mkdirSync(dir, { recursive: true })
  box.projects = demo ? [] : seedProjects(join(runDir, 'projects'))
  if (box.projects.length > 0) box.project = box.projects[0]
  else if (!demo) {
    mkdirSync(box.project, { recursive: true })
    writeFileSync(join(box.project, 'README.md'), '# debug fixture\n')
    gitInit(box.project)
    box.projects = [box.project]
  }
  writeFileSync(join(box.dataDir, 'desktop.json'), JSON.stringify({ cwd: box.project, recentCwds: box.projects }))
  if (fakePort) {
    const catalog = process.env.YAN_DEBUG_MODEL_CATALOG ? JSON.parse(process.env.YAN_DEBUG_MODEL_CATALOG) : [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text', 'image'], contextWindow: 400000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { id: 'fake-reasoning', name: 'Fake Reasoning', reasoning: true, input: ['text', 'image'], contextWindow: 400000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    writeFileSync(join(box.piDir, 'models.json'), JSON.stringify({
      providers: { fake: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, api: 'openai-responses', apiKey: 'fake-key', models: catalog } }
    }))
    writeFileSync(join(box.piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: process.env.YAN_DEBUG_DEFAULT_MODEL || 'fake-model' }))
  }
  const realBin = join(homedir(), '.pi', 'agent', 'bin')
  if (existsSync(realBin)) {
    const sharedBin = join(userSnapshotDir, 'bin')
    mirrorTree(realBin, sharedBin)
    linkTree(sharedBin, join(box.piDir, 'bin'))
  }
  for (const sample of samples) {
    const target = join(box.sessionsDir, sample.bucket, sample.file)
    if (!restoreSample(sample)) console.log(`提示：样本 ${sample.bucket}/${sample.file} 与清单不符，按现状使用`)
    linkOrCopy(sample.path, target)
    box.samples.push(target)
  }
  return box
}

export function writeQuotaFixture(box, runDir) {
  const HOUR = 3600_000
  const now = Date.now()
  const win = (id, label, used, durationMs, leftMs) => ({ id, label, used, total: 100, durationMs, resetAt: now + leftMs })
  box.quotaFixture = join(runDir, 'quota-fixture.json')
  writeFileSync(box.quotaFixture, JSON.stringify([{
    key: 'debug:fake', source: 'yan', provider: 'fake', name: 'Fake', email: 'demo@example.com', plan: 'max', active: true, status: 'ok', checkedAt: now,
    windows: [win('five_hour', '5 小时', 62, 5 * HOUR, 2 * HOUR + 10 * 60_000), win('seven_day', '本周', 38, 168 * HOUR, 76 * HOUR), win('weekly_scoped:fable', 'Fable 本周', 9, 168 * HOUR, 76 * HOUR)]
  }]))
}

export function sandboxEnv(box, { fake = false, cdpPort, probe } = {}) {
  return {
    YAN_PI_DIR: box.piDir,
    YAN_DATA_DIR: box.dataDir,
    YAN_USER_DATA: box.userData,
    YAN_DOWNLOADS_DIR: box.downloads,
    ...(process.env.YAN_DEBUG_REAL_DEVICES === '1' ? {} : { ANDROID_HOME: box.androidSdk, ANDROID_SDK_ROOT: box.androidSdk }),
    ...(fake ? { YAN_TEST_MODEL: 'fake/fake-model' } : {}),
    ...(probe ? { YAN_PROBE: probe, YAN_PROBE_DELAY: '500' } : {}),
    ...(probe && cdpPort ? { YAN_PROBE_DEBUG_PORT: String(cdpPort) } : {}),
    ...(box.quotaFixture ? { YAN_DEBUG_QUOTA_FIXTURE: box.quotaFixture } : {})
  }
}
