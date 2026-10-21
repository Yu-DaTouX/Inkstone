import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-files-voice-'))
async function load(entry) {
  const outfile = join(root, `${entry.replaceAll('/', '-')}.mjs`)
  await build({ entryPoints: [`src/main/${entry}.ts`], outfile, bundle: true, platform: 'node', format: 'esm', external: ['node-pty'] })
  return import(pathToFileURL(outfile).href)
}
try {
  const sources = await load('sources')
  const sourceDir = join(root, 'data')
  sources.configureSources({ dir: sourceDir })
  const image = Buffer.from('behavioral fixture image bytes')
  const encoded = image.toString('base64')
  const saved = sources.saveImage({ sessionId: 's1', name: 'x.png', mimeType: 'image/png', base64: encoded })
  assert.ok(saved)
  assert.deepEqual(await readFile(saved.ref), image)
  await writeFile(saved.ref, 'partial')
  assert.ok(sources.saveImage({ sessionId: 's1', name: 'x.png', mimeType: 'image/png', base64: encoded }))
  assert.deepEqual(await readFile(saved.ref), image, 'truncated content-addressed image is repaired')
  assert.equal(sources.saveImage({ sessionId: 's1', name: 'large.png', mimeType: 'image/png', base64: 'A'.repeat(28 * 1024 * 1024) }), null)
  const dir = sources.sourcesDir('s1')
  const disappearing = join(dir, 'a.png')
  await writeFile(disappearing, image)
  await rm(disappearing)
  assert.equal(sources.listImagesForSession('s1').ok, true)

  const refs = await load('file-refs')
  const cwd = join(root, 'cwd')
  await mkdir(cwd)
  const textFile = join(cwd, 'tail.txt')
  await writeFile(textFile, 'before')
  assert.equal((await refs.readPreview('tail.txt', cwd)).text, 'before')
  assert.equal((await refs.readPreview('../outside.txt', cwd)).error, '路径越界')

  const savedDataDir = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = join(root, 'voice-data')
  try {
    await build({
      entryPoints: ['src/main/voice/voice-service.ts'], outfile: join(root, 'voice-service-compiled.mjs'), bundle: true, format: 'esm', platform: 'node',
      plugins: [{ name: 'electron-stub', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = { on: () => {}, getGPUInfo: async () => ({}) }; export const net = { fetch: async () => { throw new Error("offline") } };', loader: 'js' }))
      } }]
    })
    const voice = await import(pathToFileURL(join(root, 'voice-service-compiled.mjs')).href)
    const x64Digest = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
    assert.equal(voice.whisperAssetSha256('b5454', 'whisper-bin-x64.zip'), x64Digest, 'official x64 asset hash is pinned in the table')
    assert.match(voice.whisperAssetSha256('b5454', 'whisper-bin-win-cpu-arm64.zip') ?? '', /^[0-9a-f]{64}$/, 'official arm64 asset hash is pinned in the table')
    assert.equal(voice.whisperAssetSha256('v9.9.9', 'whisper-bin-x64.zip'), undefined, 'an unpinned release has no verification value')
    assert.equal(voice.whisperAssetProblem(undefined, x64Digest), '没有这个版本转写程序的校验值，已中止下载', 'download without a pinned hash is refused')
    assert.equal(voice.whisperAssetProblem(x64Digest, x64Digest), undefined, 'a matching digest passes')
    assert.equal(voice.whisperAssetProblem(x64Digest, 'deadbeef'), '程序包校验失败（SHA-256 不一致），已删除下载内容', 'a mismatched digest is refused with a readable message')
  } finally {
    if (savedDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = savedDataDir
  }
  const terminal = await load('terminal')
  const boundary = terminal.safeTerminalCut('abcdef\nrest', 2)
  assert.equal('abcdef\nrest'.slice(boundary), 'rest')
  const surrogate = 'abc😀tail'
  const surrogateCut = terminal.safeTerminalCut(surrogate, 4)
  assert.notEqual(surrogate.charCodeAt(surrogateCut - 1) >= 0xd800 && surrogate.charCodeAt(surrogateCut - 1) <= 0xdbff, true)

  const storageMove = await load('storage-move')
  const origin = join(root, 'agent')
  assert.match(storageMove.checkTarget(origin, join(origin, '..-named-sibling')), /不能迁移到原数据目录里面/)
  assert.equal(storageMove.checkTarget(origin, join(root, 'target')), undefined)
  const envBefore = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, APPDATA: process.env.APPDATA }
  try {
    const home = join(root, 'move-home')
    process.env.USERPROFILE = home
    process.env.HOME = home
    process.env.APPDATA = join(home, 'AppData', 'Roaming')
    const agentDir = join(home, '.pi', 'agent')
    await mkdir(join(agentDir, 'sessions'), { recursive: true })
    await writeFile(join(agentDir, 'settings.json'), '{}')
    await writeFile(join(agentDir, 'sessions', 'a.jsonl'), 'line\n')
    const existingEmpty = join(root, 'move-target')
    await mkdir(existingEmpty)
    await mkdir(join(process.env.APPDATA, 'yan-desktop'), { recursive: true })
    await writeFile(join(process.env.APPDATA, 'yan-desktop', 'storage-move.json'), JSON.stringify({ target: existingEmpty }))
    const moved = await storageMove.runPendingStorageMove()
    assert.equal(moved?.ok, true, `moving into an existing empty folder succeeds: ${moved?.error ?? ''}`)
    assert.equal(await readFile(join(existingEmpty, 'sessions', 'a.jsonl'), 'utf8'), 'line\n')
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{}', 'old agent path resolves through the junction')
  } finally {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const guardHome = join(root, 'guard-home')
  const guardBefore = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, APPDATA: process.env.APPDATA }
  try {
    process.env.USERPROFILE = guardHome
    process.env.HOME = guardHome
    process.env.APPDATA = join(guardHome, 'AppData', 'Roaming')
    const guardAgent = join(guardHome, '.pi', 'agent')
    const guardControl = join(guardHome, 'AppData', 'Roaming', 'yan-desktop')
    await mkdir(guardAgent, { recursive: true })
    await mkdir(guardControl, { recursive: true })
    await writeFile(join(guardAgent, 'settings.json'), '{}')
    const guardTarget = join(root, 'guard-target')

    await writeFile(join(guardControl, 'storage-move.lock'), 'other')
    await writeFile(join(guardControl, 'storage-move.json'), JSON.stringify({ target: guardTarget }))
    const locked = await storageMove.runPendingStorageMove()
    assert.equal(locked?.ok, false, 'a second migration request is refused while one is running')
    assert.match(locked?.error ?? '', /另一次数据位置迁移正在进行/)
    assert.equal(existsSync(guardTarget), false, 'a refused migration leaves the target untouched')
    await rm(join(guardControl, 'storage-move.lock'), { force: true })

    process.env.YAN_PI_DIR = join(root, 'pinned-pi')
    const pinned = await storageMove.runPendingStorageMove()
    delete process.env.YAN_PI_DIR
    assert.equal(pinned?.ok, false, 'a pinned data dir cannot migrate')
    assert.match(pinned?.error ?? '', /便携版或测试环境/)
    assert.equal(existsSync(join(guardAgent, 'settings.json')), true, 'a refused migration keeps the original data')

    await writeFile(join(guardControl, 'storage-move.json'), JSON.stringify({ target: guardTarget }))
    let injected = false
    const raced = await storageMove.runPendingStorageMove((progress) => {
      if (injected || progress.files < 1) return
      injected = true
      writeFileSync(join(guardAgent, 'settings.json'), '{"late":true,"padding":"written during migration"}')
    })
    assert.equal(injected, true, 'the progress hook injected a write during the copy')
    assert.equal(raced?.ok, false, 'a write during migration aborts the move')
    assert.equal(existsSync(join(guardAgent, 'settings.json')), true, 'the original data directory survives an aborted move')
    assert.equal(existsSync(guardTarget), false, 'the aborted move discards the copied target')
  } finally {
    for (const [key, value] of Object.entries(guardBefore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const taskPlans = await load('task-plan-store')
  const taskOpts = { dir: join(root, 'plans') }
  const writes = Array.from({ length: 20 }, (_, index) => taskPlans.applyTaskPlanOperation({
    sessionId: 'session-queue', round: 1, opts: taskOpts,
    request: { action: 'add', operationId: `parallel-${index}`, items: [{ text: `item-${index}` }] }
  }))
  const results = await Promise.all(writes)
  assert.ok(results.every((result) => result.ok))
  const plan = await taskPlans.currentTaskPlan('session-queue', taskOpts)
  assert.equal(plan.state.revision, 20)
  assert.equal(plan.state.todos.length, 20)
  console.log('review2 files-voice isolated probes passed: source image repair/size cap, disappearing-file listing, file preview boundary, terminal safe cut, migration segment validation, concurrent task-plan queue ordering; voice asset sha256 table and download verification checked without launching Electron/network')
} finally {
  await rm(root, { recursive: true, force: true })
}
