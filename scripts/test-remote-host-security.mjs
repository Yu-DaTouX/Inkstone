import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = await mkdtemp(join(tmpdir(), 'inkstone-remote-host-sec-'))
const repo = join(scratch, 'repo')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const stubModules = {
  electron: 'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false }) }',
  './remote-approval': 'export const approvalDigest = () => "d"; export const applyHumanApproval = async () => ({ ok: false }); export const remoteApprovalQuestion = (request) => request',
  './image-store': 'export const localizeImage = () => ""',
  './title': 'export const setManualTitle = async () => ({ ok: true }); export const manualTitles = async () => ({}); export const cachedTitles = async () => ({})',
  './settings': 'export const getSettings = (...args) => globalThis.__rh.getSettings(...args)',
  './sessions': 'export const listSessions = (...args) => globalThis.__rh.listSessions(...args); export const deleteSession = async (file) => { globalThis.__rh.deleted.push(file); return "tok" }; export const restoreSession = async () => undefined; export const sessionsToDelete = async () => []; export const SESSIONS_DIR = ""',
  './session-search': 'export const searchSessionText = (...args) => globalThis.__rh.search(...args)',
  './peer-grants': 'export class PeerGrantRegistry { constructor() {} }',
  './peer-client': 'export class PeerClient { constructor() {} }',
  './paths': `export const YAN_DIR = ${JSON.stringify(join(scratch, 'yan'))}`
}
const stubPlugin = {
  name: 'stubs',
  setup(api) {
    api.onResolve({ filter: /.*/ }, (args) => (Object.prototype.hasOwnProperty.call(stubModules, args.path) ? { path: args.path, namespace: 'stub' } : undefined))
    api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubModules[args.path], loader: 'js' }))
  }
}

try {
  await mkdir(repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'a.txt'), 'main\n')
  await writeFile(join(repo, 'b.txt'), 'b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', 'feature/x')
  await writeFile(join(repo, 'a.txt'), 'feature\n')
  await writeFile(join(repo, 'only-feature.txt'), 'f\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feature')
  git('switch', '-q', 'main')

  const now = Date.now()
  const mk = (id, extra = {}) => ({ id, path: join(scratch, `${id}.jsonl`), cwd: repo, projectId: 'p', scope: 'project', title: id, named: true, createdAt: now, updatedAt: now, messageCount: 1, ...extra })
  const sessions = [mk('s-idle'), mk('s-running'), mk('s-other', { cwd: join(scratch, 'elsewhere') })]
  const state = { running: new Set(['s-running']), hits: [] }
  globalThis.__rh = {
    deleted: [],
    getSettings: async () => ({ projects: [{ id: 'p', cwd: repo, name: 'p' }], cwd: repo, piBin: 'pi' }),
    listSessions: async () => sessions,
    search: async () => ({ hits: state.hits })
  }
  const chainStore = { load: async () => {}, chains: () => [], chainOf: () => null, isRepresentative: () => true, representativeOf: (file) => file, forget: async () => true }
  const runners = {
    statuses: () => sessions.map((s) => ({ id: s.id, runId: `r-${s.id}`, sessionId: s.id, sessionFile: s.path, running: state.running.has(s.id), waiting: false, generation: 1, cwd: s.cwd })),
    agentOf: () => null,
    stopBySessionFile: async () => true
  }
  const fakeHost = {
    runners: () => runners, ac: () => null, sessionChains: chainStore, push: () => {}, pushRunners: () => {},
    validateCwd: async (cwd) => ({ ok: true, cwd }), win: () => null, remoteAccess: () => null, projectIdForCwd: () => 'p'
  }

  const built = await build({ entryPoints: [join(ROOT, 'src/main/remote-host.ts')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent', plugins: [stubPlugin], external: ['electron'] })
  const bundlePath = join(scratch, 'remote-host.bundle.mjs')
  await writeFile(bundlePath, built.outputFiles[0].text, 'utf8')
  const mod = await import(pathToFileURL(bundlePath).href)
  mod.configureRemoteHost(fakeHost)

  const running = await mod.remoteDeleteSession('s-running')
  assert.equal(running.ok, false)
  assert.equal(running.status, 409, '运行中的会话不能被手机删除')
  assert.equal(globalThis.__rh.deleted.length, 0, '运行中的会话没有被动过')
  const idle = await mod.remoteDeleteSession('s-idle')
  assert.equal(idle.ok, true)
  assert.equal(globalThis.__rh.deleted.length, 1)
  assert.equal((await mod.remoteDeleteSession('missing-id')).status, 404)

  const listing = await mod.remoteBranches('s-running')
  assert.equal(listing.ok, true)
  assert.deepEqual(listing.data.branches.map((b) => b.name).sort(), ['feature/x', 'main'])
  assert.ok(!JSON.stringify(listing).includes(scratch.replace(/\\/g, '\\\\')) && !JSON.stringify(listing).includes(repo), '分支列表不含本机路径')

  state.running.clear()
  const attacks = ['-fv', '--detach', '--orphan=evil', '-c', '--force', 'main; touch pwned', 'main && echo x', '$(touch pwned)', 'HEAD', '@', 'refs/heads/main', 'origin/main', 'nope', '../main', 'feature/x ', 'MAIN', '-']
  for (const branch of attacks) {
    const result = await mod.remoteSwitchBranch('s-idle2' in {} ? 's-idle2' : 's-running', branch)
    assert.equal(result.ok, false, `分支名 ${JSON.stringify(branch)} 被拒绝`)
  }
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', '攻击后仍在 main')
  assert.ok(!existsSync(join(repo, 'pwned')) && !existsSync(join(repo, 'evil')), '没有命令被执行')
  assert.equal(git('status', '--porcelain'), '', '攻击没有留下任何改动')

  await writeFile(join(repo, 'a.txt'), 'local edit worth keeping\n')
  const dirty = await mod.remoteSwitchBranch('s-running', 'feature/x')
  assert.equal(dirty.ok, false, '会被覆盖的未提交改动阻止切换')
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'local edit worth keeping\n', '未提交改动完整保留')
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  git('checkout', '--', 'a.txt')

  await writeFile(join(repo, 'only-feature.txt'), 'untracked precious\n')
  const collide = await mod.remoteSwitchBranch('s-running', 'feature/x')
  assert.equal(collide.ok, false, '会覆盖未跟踪文件的切换被拒绝')
  assert.equal(await readFile(join(repo, 'only-feature.txt'), 'utf8'), 'untracked precious\n', '未跟踪文件完整保留')
  await rm(join(repo, 'only-feature.txt'))

  state.running.add('s-running')
  const busy = await mod.remoteSwitchBranch('s-running', 'feature/x')
  assert.equal(busy.status, 409, '会话运行中不能切换分支')
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  state.running.clear()

  const switched = await mod.remoteSwitchBranch('s-running', 'feature/x')
  assert.equal(switched.ok, true, JSON.stringify(switched))
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x')
  git('switch', '-q', 'main')

  state.hits = [
    { path: sessions[0].path, snippet: 'x'.repeat(500), matches: 2 },
    { path: join(scratch, 'ghost.jsonl'), snippet: '不在手机可见列表里', matches: 1 }
  ]
  const found = await mod.remoteSearch('x')
  assert.equal(found.data.hits.length, 1, '搜索只返回手机可见会话的命中')
  assert.ok(found.data.hits[0].snippet.length <= 201)
  assert.deepEqual(Object.keys(found.data.hits[0]).sort(), ['matches', 'sessionId', 'snippet'], '搜索命中不带路径')
  assert.deepEqual(await mod.remoteSearch('   '), { ok: true, data: { hits: [] } })

  await writeFile(join(repo, 'a.txt'), 'changed\n')
  const insight = await mod.remoteInsight('s-running')
  assert.equal(insight.ok, true)
  const serialized = JSON.stringify(insight.data)
  assert.ok(!serialized.includes(repo.replace(/\\/g, '\\\\')) && !serialized.includes(scratch.replace(/\\/g, '\\\\')), 'insight 不含本机绝对路径')
  assert.equal(insight.data.changes?.files[0]?.path, 'a.txt', '改动文件使用仓库相对路径')

  const subs = [{ id: 'sub-one', parentSessionId: 's-running', status: 'running' }, { id: 'sub-two', parentSessionId: 'other', status: 'running' }, { id: 'sub-three', parentSessionId: 's-running', status: 'done' }]
  const stopped = []
  const stop = async (id) => { stopped.push(id); return { ok: true } }
  assert.equal((await mod.remoteStopSubagent('s-running', 'sub-two', subs, stop)).status, 404, '不能越过会话去停别的会话的子代理')
  assert.equal((await mod.remoteStopSubagent('s-running', 'sub-three', subs, stop)).status, 409)
  assert.equal((await mod.remoteStopSubagent('s-running', 'sub-one', subs, stop)).ok, true)
  assert.deepEqual(stopped, ['sub-one'])

  const attachmentBuilt = await build({ entryPoints: [join(ROOT, 'src/main/attachment-file.ts')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent', plugins: [stubPlugin] })
  const attachmentPath = join(scratch, 'attachment-file.bundle.mjs')
  await writeFile(attachmentPath, attachmentBuilt.outputFiles[0].text, 'utf8')
  const { managedAttachment } = await import(pathToFileURL(attachmentPath).href)
  const store = join(scratch, 'store')
  await mkdir(store, { recursive: true })
  const good = 'a'.repeat(40) + '.png'
  await writeFile(join(store, good), 'png')
  await writeFile(join(scratch, 'secret.txt'), 'secret')
  assert.equal((await managedAttachment(pathToFileURL(join(store, good)).href, store))?.mimeType, 'image/png')
  assert.equal(await managedAttachment(pathToFileURL(join(store, 'b'.repeat(40) + '.png')).href, store), null, '不存在的文件')
  assert.equal(await managedAttachment(pathToFileURL(join(scratch, 'secret.txt')).href, store), null, '目录外的文件')
  assert.equal(await managedAttachment(pathToFileURL(join(store, '..', 'secret.txt')).href, store), null, '穿越到上级')
  assert.equal(await managedAttachment(pathToFileURL(join(store, 'sub', good)).href, store), null, '子目录')
  assert.equal(await managedAttachment(pathToFileURL(join(store, 'notahash.png')).href, store), null, '文件名不是哈希')
  assert.equal(await managedAttachment('C:\Windows\win.ini', store), null, '不是 file URL')
  assert.equal(await managedAttachment('file://evil-host/share/' + good, store), null, 'UNC 远程主机')
  assert.equal(await managedAttachment(undefined, store), null)
  const linked = 'c'.repeat(40) + '.png'
  const linkable = await symlink(join(scratch, 'secret.txt'), join(store, linked)).then(() => true, () => false)
  if (linkable) assert.equal(await managedAttachment(pathToFileURL(join(store, linked)).href, store), null, '符号链接指向目录外')

  console.log('remote host security attacks ok')
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
}
