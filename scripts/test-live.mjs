import './lib/stdio-guard.mjs'
import { defaultLiveCases, localProviderCases, validateSyntheticSelection, syntheticEnvironment } from './lib/live-synthetic-isolation.mjs'
import { spawn, execFileSync } from 'node:child_process'
import vm from 'node:vm'
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  cpSync,
  existsSync,
  appendFileSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SYNTHETIC_ONLY = process.env.YAN_TEST_SYNTHETIC_ONLY === '1'
const TEST_MODEL = process.env.YAN_TEST_MODEL || (SYNTHETIC_ONLY ? 'openai/gpt-4o-mini' : 'commandcode/deepseek/deepseek-v4.1-flash')

const electronBin = createRequire(import.meta.url)('electron')

const TEST_VISION_MODEL =
  process.env.YAN_TEST_VISION_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash'

const FOLLOWUP_DEBUG_PORT = process.env.YAN_PROBE_DEBUG_PORT || '9397'
const LANG_EXT_LOG = join(tmpdir(), `lang-ext-${process.pid}-${Date.now()}.log`)

const USE_LOCAL_TEST_MODEL = TEST_MODEL.startsWith('local/')
const DELAY_SCALE = Number(process.env.YAN_TEST_DELAY_SCALE ?? '1') || 1
function scaledDelay(ms) {
  return ms === undefined ? ms : Math.round(ms * DELAY_SCALE)
}
function freeLocalPort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

function modelForCase(fallback) {
  if (USE_LOCAL_TEST_MODEL && fallback && !/nonexistent|route-probe/i.test(fallback)) return TEST_MODEL
  return fallback ?? TEST_MODEL
}

const CASES = {
  runprogress: { probe: 'scripts/probe/run-progress.js', delay: 9000, cost: 0 },
  live: { probe: 'scripts/probe/live.js', delay: 9000, cost: 0 },
  remoteroutes: {
    probe: 'scripts/probe/remote-routes.js',
    delay: 15000,
    budget: 120000,
    cost: 0,
    driver: driveRemoteRoutes,
    afterExit: 'remoteRoutes'
  },
  hotkeys: {
    probe: 'scripts/probe/hotkeys.js',
    delay: 9000,
    cost: 0,
    keys: 'ctrl+shift+p,ctrl+p,shift+tab'
  },
  fileref: { probe: 'scripts/probe/fileref.js', delay: 10000, cost: 0 },
  permissions: { probe: 'scripts/probe/permissions.js', delay: 9000, cost: 0 },
  atrefsend: {
    probe: 'scripts/probe/atrefsend.js',
    fixture: true,
    delay: 12000,
    cost: 1,
    model: 'commandcode/longcat-2.0:free',
    afterExit: 'atrefsendArchive'
  },
  modelswitch: { probe: 'scripts/probe/modelswitch.js', delay: 12000, cost: 0 },
  bootspeed: { probe: 'scripts/probe/bootspeed.js', delay: 1500, cost: 0, visible: true },
  hold: { probe: 'scripts/probe/hold.js', delay: 500, cost: 0, visible: true, budget: 150000 },
  deltas: { probe: 'scripts/probe/deltas.js', delay: 12000, cost: 0 },
  pending: { probe: 'scripts/probe/pending.js', delay: 9000, cost: 0 },
  pendingreal: { probe: 'scripts/probe/pending-real.js', delay: 15000, cost: 1 },
  'v3-shell': {
    probe: 'scripts/probe/v3-shell.js', delay: 9000, cost: 0, visible: true,
    keys: 'ctrl+k,escape,enter', keysDelay: 11000
  },
  'v3-user-polish': { probe: 'scripts/probe/v3-user-polish.js', delay: 9000, cost: 0 },
  'v3-user-followup': {
    probe: 'scripts/probe/v3-user-followup.js', delay: 9000, cost: 0, visible: true,
    env: { YAN_PROBE_DEBUG_PORT: FOLLOWUP_DEBUG_PORT },
    driver: driveFollowupPointer
  },
  'v3-ascii-once': {
    probe: 'scripts/probe/v3-ascii-once.js', delay: 9000, cost: 0, budget: 60000,
    keys: 'space', keysDelay: 15000
  },
  'v3-todos': {
    probe: 'scripts/probe/v3-todos.js', delay: 9000, cost: 0, budget: 90000,
    keys: 'ctrl+b', keysDelay: 20000,
    afterExit: 'taskFixtureReadonly', readonlySession: 'yan-todo-fixture'
  },
  'v3-tiles-width': {
    probe: 'scripts/probe/v3-tiles-width.js', delay: 9000, cost: 0, budget: 90000,
    afterExit: 'taskFixtureReadonly', readonlySession: 'yan-todo-fixture'
  },
  'v3-composer': { probe: 'scripts/probe/v3-composer.js', delay: 9000, cost: 0, budget: 90000 },
  'v3-devices-bind': { probe: 'scripts/probe/v3-devices-bind.js', delay: 9000, cost: 0, budget: 90000, freeRemotePort: true },
  'v3-collab-invite': {
    probe: 'scripts/probe/v3-collab-invite.js', delay: 9000, cost: 0, budget: 60000,
    args: ['inkstone://pair?address=http%3A%2F%2F100.64.0.7%3A37892&code=246810']
  },
  'v3-sendkey': { probe: 'scripts/probe/v3-sendkey.js', delay: 9000, cost: 0 },
  'v3-completion': { probe: 'scripts/probe/v3-completion.js', delay: 9000, cost: 0 },
  'v3-projectmenu': { probe: 'scripts/probe/v3-projectmenu.js', delay: 9000, cost: 0 },
  'v3-switch-slashpath': { probe: 'scripts/probe/v3-switch-slashpath.js', delay: 9000, cost: 0 },
  'v3-workspacefit': { probe: 'scripts/probe/v3-workspacefit.js', fixture: true, bigFileFixture: true, delay: 9000, cost: 0 },
  'v3-logsquota': { probe: 'scripts/probe/v3-logsquota.js', delay: 9000, cost: 0 },
  'v3-delegate': { probe: 'scripts/probe/v3-delegate.js', delay: 9000, cost: 0 },
  'v3-voicecu': { probe: 'scripts/probe/v3-voicecu.js', delay: 9000, cost: 0 },
  'v3-queuestack': { probe: 'scripts/probe/v3-queuestack.js', delay: 9000, cost: 0 },
  'v3-real-send': { probe: 'scripts/probe/v3-real-send.js', fixture: true, delay: 12000, cost: 1, budget: 300000 },
  'v3-real-todos': { probe: 'scripts/probe/v3-real-todos.js', fixture: true, delay: 12000, cost: 1, budget: 360000 },
  narrowscan: {
    probe: 'scripts/probe/narrowscan.js',
    delay: 9000,
    cost: 0,
    wins: ['1600x1000', '1280x860', '1100x760', '1000x700', '940x640']
  },
  rewind: { probe: 'scripts/probe/rewind.js', delay: 9000, cost: 0 },
  queuestack: { probe: 'scripts/probe/queuestack.js', delay: 9000, cost: 0 },
  projectopened: {
    probe: 'scripts/probe/project-opened.js',
    fixture: true,
    projectSessions: true,
    openedSessions: true,
    delay: 10000,
    budget: 180000,
    cost: 0,
    afterExit: 'projectOpenedLayout'
  },
  sourcelinklive: {
    probe: 'scripts/probe/source-locate-send.js',
    fixture: true,
    delay: 9000,
    budget: 200000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    afterExit: 'sourceLocateLinked'
  },
  browserframes: {
    probe: 'scripts/probe/browser-frames.js',
    delay: 9000,
    cost: 0,
    usesBoundaryServer: true,
    budget: 90000
  },
  searchopen: { probe: 'scripts/probe/search-open.js', delay: 12000, cost: 0, budget: 180000 },
  browserreal: { probe: 'scripts/probe/browser-real-sites.js', delay: 9000, cost: 0, budget: 240000, visible: true },
  composersize: { probe: 'scripts/probe/composer-size.js', delay: 9000, cost: 0, wins: ['1440x900', '1100x700', '940x640', '900x520'] },
  questionshot: { probe: 'scripts/probe/question-shot.js', delay: 9000, cost: 0 },
  sidebardensity: { probe: 'scripts/probe/sidebar-density.js', delay: 4000, cost: 0, visible: true },
  restartempty: { probe: 'scripts/probe/restart-empty.js', delay: 9000, cost: 0 },
  title: {
    probe: 'scripts/probe/title.js',
    delay: 12000,
    budget: 260000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },
  language: {
    probe: 'scripts/probe/language.js',
    fixture: true,
    delay: 14000,
    budget: 300000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    env: { YAN_LANG_EXT_LOG: LANG_EXT_LOG },
    afterExit: 'languageInjection'
  },
  sound: { probe: 'scripts/probe/sound.js', delay: 9000, cost: 0 },
  working: { probe: 'scripts/probe/working.js', delay: 9000, cost: 0 },
  conn: { probe: 'scripts/probe/conn.js', delay: 9000, cost: 1 },
  sessionlayout: { probe: 'scripts/probe/sessionlayout.js', delay: 9000, cost: 0 },
  tray: { probe: 'scripts/probe/tray.js', delay: 9000, cost: 0, visible: true, env: { YAN_EXIT_CHOICE: 'cancel' } },
  exitsave: { probe: 'scripts/probe/exit-save.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'save' } },
  exitinterrupt: { probe: 'scripts/probe/exit-interrupt.js', delay: 9000, cost: 0, afterExit: 'exitSnapshot', env: { YAN_EXIT_CHOICE: 'interrupt' } },
  runnerselect: { probe: 'scripts/probe/runnerselect.js', delay: 12000, cost: 0 },
  latds: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'commandcode/deepseek/deepseek-v4.1-flash' },
  latluna: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'openai-codex/gpt-6-luna' },
  lathaiku: { probe: 'scripts/probe/send-latency.js', delay: 9000, cost: 1, budget: 300000, model: 'claude-bridge/haiku' },
  knowledgecli: {
    probe: 'scripts/probe/knowledge-cli.js',
    fixture: true,
    fixtureSub: 'repo',
    delay: 12000,
    budget: 360000,
    cost: 1,
    model: 'commandcode/deepseek/deepseek-v4.1-flash',
    knowledgeSeed: true,
    afterExit: 'knowledgeCli'
  },
  compactdraft: { probe: 'scripts/probe/compact-draft.js', fixture: true, piSettings: { compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 200 } }, delay: 12000, cost: 1, budget: 300000, model: 'commandcode/deepseek/deepseek-v4.1-flash' },
  imgedit: { probe: 'scripts/probe/image-edit.js', delay: 12000, cost: 1, fixture: true, budget: 420000, model: 'commandcode/deepseek/deepseek-v4.1-flash' },
  subagentfork: { probe: 'scripts/probe/subagent-fork.js', fixture: true, delay: 12000, cost: 1, budget: 600000, model: 'commandcode/deepseek/deepseek-v4.1-flash', afterExit: 'subagentForkCache' },
  queue: { probe: 'scripts/probe/queue.js', delay: 9000, cost: 1, budget: 150000 },
  queuebusy: { probe: 'scripts/probe/queue-busy.js', delay: 9000, cost: 1 },
  browserclimodel: {
    probe: 'scripts/probe/browser-cli-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  capsearch: {
    probe: 'scripts/probe/capability-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 260000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  capmcp: {
    probe: 'scripts/probe/mcp-search-model.js',
    delay: 10000,
    cost: 1,
    budget: 360000,
    model: 'commandcode/deepseek/deepseek-v4.1-flash'
  },

  discnet: { probe: 'scripts/probe/discovery-cli.js', delay: 9000, cost: 0 },

  skilldirnet: {
    probe: 'scripts/probe/skill-directory.js',
    delay: 12000,
    cost: 0,
    env: { YAN_SKILL_DIRECTORY_URL: 'https://api.skillmd.com/v1/search' }
  },

  capcli: { probe: 'scripts/probe/capability-cli.js', delay: 9000, cost: 0 },

  mcpcli: { probe: 'scripts/probe/mcp-cli.js', delay: 9000, cost: 0 },


  mcpregister: { probe: 'scripts/probe/mcp-register.js', delay: 9000, cost: 0, usesMcpRegisterFixture: true },













  turntimingisolation: {
    probe: 'scripts/probe/turn-timing-isolation.js',
    delay: 12000,
    budget: 180000,
    cost: 0,
    fixture: true,
    abSessions: true,
    afterExit: 'turnTimingIsolation'
  },
  turntimingkill: {
    probe: 'scripts/probe/turn-timing-hardkill.js',
    delay: 12000,
    budget: 90000,
    cost: 0,
    fixture: true,
    fixtureSub: 'repo',
    hardKillAfterIntermediateTiming: true,
    restart: { probe: 'scripts/probe/turn-timing-hardkill-restart.js', delay: 12000, budget: 120000 },
    afterExit: 'turnTimingHardKill',
    afterExitOnFailure: true
  },
}

const TS = (offsetSec = 0) => new Date(Date.now() - offsetSec * 1000).toISOString()

const LONG_NAME = '一个非常长的文件名用来验证窄栏下的省略显示-0123456789-abcdefghij-中文结尾.md'

function denyDirRead(dir, user = process.env.USERNAME) {
  if (!user) return false
  try {
    execFileSync('icacls', [dir, '/deny', `${user}:(RD)`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function allowDirRead(dir, user = process.env.USERNAME) {
  if (!user) return
  try {
    execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'ignore' })
  } catch {
  }
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makePng(size, rgb) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    const off = y * stride
    raw[off] = 0
    for (let x = 0; x < size; x += 1) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function buildFixtureProject(base) {
  const dir = join(base, 'fixture-project')
  allowDirRead(join(dir, 'noperm'))
  rmSync(dir, { recursive: true, force: true })
  const mk = (...parts) => mkdirSync(join(dir, ...parts), { recursive: true })
  const put = (rel, text) => writeFileSync(join(dir, rel), text, 'utf8')

  mk()
  for (let i = 1; i <= 8; i++) mk('probe-projects', `p${i}`)
  put('README.md', '# fixture project\n\n合成项目，只用于边界场景。\n')
  writeFileSync(join(dir, 'imgsrc.png'), makePng(64, [32, 96, 200]))
  mk('empty')
  mk('deep', 'a', 'b', 'c', 'd', 'e')
  put(join('deep', 'a', 'b', 'c', 'd', 'e', 'f.txt'), 'deep\n')
  mk('dup', 'one')
  mk('dup', 'two')
  put(join('dup', 'one', 'same.ts'), 'export const one = 1\n')
  put(join('dup', 'two', 'same.ts'), 'export const two = 2\n')
  mk('big')
  for (let i = 1; i <= 60; i += 1) {
    put(join('big', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`)
  }
  mk('uni', '中文 目录')
  put(join('uni', '中文 目录', '文件 名.ts'), 'export const 中文 = 1\n')
  put('notadir.txt', 'not a directory\n')

  mk('compact', '.pi')
  put(
    join('compact', '.pi', 'settings.json'),
    JSON.stringify({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1000 } }, null, 2)
  )
  put(join('compact', 'README.md'), '# compact cwd\n\nN21-2 的项目级设置边界。\n')

  mk('noperm')
  put(join('noperm', 'secret.txt'), 'no permission\n')
  const noPermDenied = denyDirRead(join(dir, 'noperm'))

  put(LONG_NAME, 'long name\n')

  mk('other')
  put(join('other', 'README.md'), '# other cwd\n\nN12 用的第二个工作目录。\n')
  try {
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'other'), stdio: 'ignore' })
  } catch {
  }

  const repo = join(dir, 'repo')
  mk('repo')
  put(join('repo', 'README.md'), '# fixture repo\n\nLINE-BASE: 初始内容\n')
  put(
    join('repo', 'big.txt'),
    Array.from({ length: 5000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`).join('\n') + '\n'
  )
  mk('repo', 'docs')
  put(join('repo', 'docs', 'a.md'), '# fixture 文档\n\n[返回上一级](../README.md)\n')
  put(join('repo', 'docs', 'README.md'), '# docs README\n\n历史来源目录 fixture。\n')
  const gitEnv = ['-c', 'user.name=yan-test', '-c', 'user.email=yan@test']
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', [...gitEnv, 'commit', '-q', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      'fixture 仓库初始化失败（L03 的 worktree 场景需要 git）：' + (error instanceof Error ? error.message : String(error))
    )
  }

  mk('probe-ext')
  mk('probe-ext', 'extensions')
  put(join('probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  mk('pkgs')
  mk('pkgs', 'probe-ext')
  mk('pkgs', 'probe-ext', 'extensions')
  put(join('pkgs', 'probe-ext', 'package.json'), JSON.stringify({
    name: 'yan-probe-ext',
    version: '9.9.9',
    description: '探针用的假扩展（P2 的真实安装路径）',
    license: 'MIT',
    keywords: ['pi-package']
  }, null, 2))
  put(join('pkgs', 'probe-ext', 'extensions', 'index.js'), 'export default {}\n')

  const writeRepo = join(dir, 'write')
  mk('write')
  const wgit = (args) => execFileSync('git', args, { cwd: writeRepo, stdio: 'ignore' })
  const wgitC = (...args) => execFileSync('git', [...gitEnv, ...args], { cwd: writeRepo, stdio: 'ignore' })
  wgit(['init', '-q', '-b', 'main'])
  wgit(['config', 'core.autocrlf', 'false'])
  wgit(['config', 'user.name', 'yan-test'])
  wgit(['config', 'user.email', 'yan-test@example.com'])
  put(join('write', 'a.txt'), 'a1\na2\na3\n')
  put(join('write', 'b.txt'), 'b1\n')
  put(join('write', 'dirty.txt'), 'clean\n')
  mk('write', 'src')
  put(join('write', 'src', 'app.ts'), 'export const v = 1\n')
  wgitC('add', '-A')
  wgitC('commit', '-q', '-m', 'write fixture base')
  wgitC('switch', '-q', '-c', 'feature')
  put(join('write', 'b.txt'), 'b1 on feature\n')
  wgitC('commit', '-qam', 'feature changes b.txt')
  wgitC('switch', '-q', 'main')
  const writeRemote = join(dir, 'write-remote.git')
  execFileSync('git', ['init', '-q', '--bare', writeRemote], { stdio: 'ignore' })
  wgit(['remote', 'add', 'origin', writeRemote])
  wgitC('push', '-q', '-u', 'origin', 'main')
  put(join('write', 'a.txt'), 'a1\nA2-CHANGED\na3\n')
  put(join('write', 'new.txt'), 'fresh\n')
  put(join('write', 'dirty.txt'), 'dirty\n')
  put(join('write', 'notes.txt'), 'note\n')


  try {
    symlinkSync(join(dir, 'deep'), join(dir, 'junction-dir'), 'junction')
  } catch {
  }
  try {
    symlinkSync(join(dir, 'README.md'), join(dir, 'junction-file'))
  } catch {
  }
  if (!noPermDenied) {
    console.log('  ⤺ 无权限目录没造成（icacls deny 失败），fsedge 会跳过那组断言')
  }

  mk('tasks')
  put(
    join('tasks', 'task-set.json'),
    JSON.stringify(
      {
        action: 'set',
        items: [{ text: '确认范围' }, { text: '实现宿主任务服务' }, { text: '真实运行验收' }]
      },
      null,
      2
    ) + '\n'
  )
  put(
    join('tasks', 'task-complete.json'),
    JSON.stringify({ action: 'complete', index: 2 }, null, 2) + '\n'
  )

  return dir
}

function seedSessions(destRoot) {
  const project = '--C--Users-Test--'
  const destDir = join(destRoot, project)
  mkdirSync(destDir, { recursive: true })
  let n = 0

  try {
    const real = join(homedir(), '.pi', 'agent', 'sessions')
    if (!SYNTHETIC_ONLY && existsSync(real)) {
      const found = []
      const walk = (dir, depth) => {
        if (depth > 2) return
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p, depth + 1)
          else if (e.name.endsWith('.jsonl')) {
            found.push({ path: p, project: basename(dir), mtime: statSync(p).mtimeMs })
          }
        }
      }
      walk(real, 0)

      for (const f of found.sort((a, b) => b.mtime - a.mtime).slice(0, 3)) {
        const d = join(destRoot, f.project)
        mkdirSync(d, { recursive: true })
        copyFileSync(f.path, join(d, basename(f.path)))
        n++
      }
    }
  } catch (e) {
    console.log('  ⚠️  拷贝真实会话失败：' + e.message)
  }

  for (const extra of (SYNTHETIC_ONLY ? [] : (process.env.YAN_TEST_EXTRA_SESSIONS ?? '').split(';').filter(Boolean))) {
    try {
      copyFileSync(extra, join(destDir, basename(extra)))
      n++
    } catch (e) {
      console.log('  ⚠️  额外会话拷贝失败：' + e.message)
    }
  }

  writeTodoSession(destDir, 'yan-todo-fixture')
  n++

  writeBranchFamily(destDir, 'yan-family')
  n += 3

  writePlainSession(destDir, 'yan-plain-fixture', 20)
  n++

  writePlainSession(destDir, 'yan-bulk-fixture', 400)
  n++

  return n
}

function writeV3UsageFixture(sandboxRoot) {
  const usageSessions = join(sandboxRoot, 'usage-sessions')
  const mainDir = join(usageSessions, '--C--Fixture--')
  mkdirSync(mainDir, { recursive: true })
  const mainDay = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  const childDay = new Date().toISOString()
  const messageLine = (id, role, timestamp, totalTokens) =>
    JSON.stringify({
      type: 'message',
      id,
      timestamp,
      message: { role, content: `合成 fixture（${role}）` },
      ...(totalTokens ? { provider: 'fixture', model: 'usage-main', usage: { totalTokens } } : {})
    })
  writeFileSync(
    join(mainDir, 'usage-main.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'usage-main', timestamp: mainDay, cwd: '/fixture' }),
      messageLine('usage-main-u1', 'user', mainDay),
      messageLine('usage-main-a1', 'assistant', mainDay, 1000),
      messageLine('usage-main-u2', 'user', mainDay),
      messageLine('usage-main-a2', 'assistant', mainDay, 2000)
    ].join('\n') + '\n',
    'utf8'
  )
  const childDir = join(sandboxRoot, 'data', 'subagents', 'sessions', 'usage-child')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(
    join(childDir, 'child.jsonl'),
    [
      JSON.stringify({ type: 'session', version: 3, id: 'usage-child', timestamp: childDay, cwd: '/fixture' }),
      messageLine('usage-child-u1', 'user', childDay),
      messageLine('usage-child-a1', 'assistant', childDay, 5000),
      messageLine('usage-child-u2', 'user', childDay)
    ].join('\n') + '\n',
    'utf8'
  )
  return { usageSessions, mainTokens: 3000, subTokens: 5000, mainMessages: 4 }
}

function writeRemoteRouteSession(root, cwd) {
  const id = 'yan-remote-route-target'
  const timestamp = new Date().toISOString()
  const file = join(root, `2026-09-20T00-00-00-000Z_${id}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'model_change', id: 'mc0', parentId: null, timestamp, provider: 'yanrouteprobe', modelId: 'route-probe' },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Isolated remote route fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready for a local route check.' }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return { id, file }
}

function writeTodoSession(dir, idBase) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const m = (role, text, i, extra = {}) => ({
    type: 'message',
    id: 'm' + i,
    parentId: i === 0 ? null : 'm' + (i - 1),
    timestamp: TS(100 - i),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {}),
      ...extra
    }
  })

  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(200), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(200),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    m('user', 'YAN-TODO fixture：用来验证任务清单渲染', 0),
    m('assistant', '好，我把计划列出来。', 1),
    {
      type: 'custom',
      id: 'task0',
      parentId: 'm1',
      timestamp: TS(90),
      customType: 'left-panel-tasks',
      data: {
        todos: [
          { text: '读 spec 并确认范围', done: true },
          { text: '写 protocol.ts 的 JSONL 分帧', done: true },
          { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
          { text: '补测试并用真实应用跑一遍回归', done: false }
        ]
      }
    }
  ]

  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

function writeBranchFamily(dir, idBase) {
  const stamp = Date.now().toString(36)
  const cwd = homedir()
  const T0 = Date.now() - 60_000
  const iso = (ms) => new Date(ms).toISOString()
  const msg = (id, parentId, role, text, ts) => ({
    type: 'message',
    id,
    parentId,
    timestamp: iso(ts),
    message: {
      role,
      content: [{ type: 'text', text }],
      ...(role === 'assistant'
        ? {
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop'
          }
        : {})
    }
  })
  const modelLine = {
    type: 'model_change',
    id: 'mc0',
    parentId: null,
    timestamp: iso(T0),
    provider: 'commandcode',
    modelId: 'deepseek/deepseek-v4.1-flash'
  }
  const ORIGIN = 'YAN-FAMILY 源问题：这段对话要怎么分帧？'

  const parentFile = join(dir, `2026-01-05T00-00-00-000Z_${idBase}-parent-${stamp}.jsonl`)
  writeFileSync(
    parentFile,
    [
      { type: 'session', version: 3, id: `${idBase}-parent-${stamp}`, timestamp: iso(T0), cwd },
      modelLine,
      msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
      msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2)
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
    'utf8'
  )

  for (let i = 1; i <= 2; i++) {
    const forkTs = T0 + i * 1000
    const file = join(dir, `2026-01-05T00-00-0${i}-000Z_${idBase}-child${i}-${stamp}.jsonl`)
    writeFileSync(
      file,
      [
        {
          type: 'session',
          version: 3,
          id: `${idBase}-child${i}-${stamp}`,
          timestamp: iso(forkTs),
          cwd,
          parentSession: parentFile
        },
        modelLine,
        msg('fu0', 'mc0', 'user', ORIGIN, T0 + 1),
        msg('fa0', 'fu0', 'assistant', '按行切就行。', T0 + 2),
        msg(`c${i}u`, 'fa0', 'user', `YAN-FAMILY 分支${i}：改用方案 ${i}`, forkTs + 1),
        msg(`c${i}a`, `c${i}u`, 'assistant', `好，用方案 ${i}。`, forkTs + 2)
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
      'utf8'
    )
  }
}

function writePlainSession(dir, idBase, count) {
  const id = `${idBase}-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-02T00-00-00-000Z_${id}.jsonl`)
  const cwd = homedir()
  const lines = [
    { type: 'session', version: 3, id, timestamp: TS(500), cwd },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp: TS(500),
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    }
  ]
  for (let i = 0; i < count; i++) {
    lines.push({
      type: 'message',
      id: 'p' + i,
      parentId: i === 0 ? 'mc0' : 'p' + (i - 1),
      timestamp: TS(400 - i),
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `YAN-PLAIN fixture 第 ${i} 条消息` }],
        ...(i % 2 === 1
          ? {
              usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'stop'
            }
          : {})
      }
    })
  }
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
}

function writeContextGuardSession(dir) {
  const id = `yan-context-guard-${Date.now().toString(36)}`
  const file = join(dir, `2026-01-06T00-00-00-000Z_${id}.jsonl`)
  const text = 'context guard fixture '.repeat(320)
  const timestamp = new Date(Date.now() - 120_000).toISOString()
  const lines = [
    { type: 'session', version: 3, id, timestamp, cwd: homedir() },
    {
      type: 'model_change',
      id: 'mc0',
      parentId: null,
      timestamp,
      provider: 'commandcode',
      modelId: 'deepseek/deepseek-v4.1-flash'
    },
    {
      type: 'message',
      id: 'u0',
      parentId: 'mc0',
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'YAN-CONTEXT-GUARD fixture' }] }
    },
    {
      type: 'message',
      id: 'a0',
      parentId: 'u0',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: {
          input: 1024,
          output: 1024,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop'
      }
    }
  ]
  writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  return file
}

function writeAbSessions(root, cwdA, cwdB) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd) => {
    const id = `yan-ab-${tag}-${stamp}`
    const file = join(root, `2026-01-03T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(600), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(600),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'mc0',
        timestamp: TS(590),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'a0',
        timestamp: TS(580),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-AB-${tag.toUpperCase()}-REPLY` }],
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    made.push({ tag, id, file, cwd })
  }
  one('a', cwdA)
  one('b', cwdB)
  one('c', cwdA)
  return made
}

function writeProjectSwitchSessions(root, cwdA, cwdB, opts = {}) {
  const stamp = Date.now().toString(36)
  const made = []
  const one = (tag, cwd, skew = 0) => {
    const id = `yan-n05-${tag}-${stamp}`
    const file = join(root, `2026-01-04T00-00-00-000Z_${id}.jsonl`)
    const lines = [
      { type: 'session', version: 3, id, timestamp: TS(700 - skew), cwd },
      {
        type: 'model_change',
        id: 'mc0',
        parentId: null,
        timestamp: TS(700 - skew),
        provider: 'commandcode',
        modelId: 'deepseek/deepseek-v4.1-flash'
      },
      {
        type: 'message',
        id: 'u0',
        parentId: 'mc0',
        timestamp: TS(690 - skew),
        message: { role: 'user', content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()} fixture 会话` }] }
      },
      {
        type: 'message',
        id: 'a0',
        parentId: 'u0',
        timestamp: TS(680 - skew),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `YAN-N05-${tag.toUpperCase()}-REPLY` }],
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop'
        }
      }
    ]
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    const t = (Date.now() - (900 + skew) * 1000) / 1000
    try {
      utimesSync(file, t, t)
    } catch {
    }
    made.push({ tag, cwd, file })
  }
  one('a', cwdA)
  one('b', cwdB)
  if (opts.peers && opts.peerCwd) {
    one('d', opts.peerCwd, 0)
    one('e', opts.peerCwd, 100)
  }
  if (opts.opened) {
    one('hot', cwdA, 300)
    one('opened', cwdA, 50)
  }
  return made
}

function checkProbeSyntax(probe) {
  try {
    const src = readFileSync(join(root, probe), 'utf8')
    new vm.Script(src, { filename: probe })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const KNOWLEDGE_FIXTURE_PROJECT_ID = 'proj-fixture'
const KNOWLEDGE_FIXTURE_ENTRY_ID = 'kn-deploy'
const KNOWLEDGE_FIXTURE_TEXT = '发布流程统一走 npm run dist，先跑完整门槛'
const KNOWLEDGE_FIXTURE_CANDIDATE_ID = 'k-candidate01'
const KNOWLEDGE_FIXTURE_CANDIDATE_TEXT = 'out/ 是构建产物目录，跑单测前先 build'

async function seedProjectKnowledge(dataDir, opts = {}) {
  const projectId = KNOWLEDGE_FIXTURE_PROJECT_ID
  const { pathToFileURL } = await import('node:url')
  const memory = await import(pathToFileURL(join(root, 'src/shared/project-memory.ts')).href)
  const now = new Date().toISOString()
  const entry = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    id: KNOWLEDGE_FIXTURE_ENTRY_ID,
    projectId,
    revision: 1,
    kind: 'decision',
    status: 'active',
    text: KNOWLEDGE_FIXTURE_TEXT,
    textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_TEXT),
    tags: ['发布'],
    evidence: [{ sessionId: 'fixture' }],
    confidenceClass: 'user-confirmed',
    createdAt: now,
    updatedAt: now
  }
  const candidate = opts.withCandidate
    ? {
        ...entry,
        id: KNOWLEDGE_FIXTURE_CANDIDATE_ID,
        revision: 1,
        kind: 'fact',
        status: 'candidate',
        text: KNOWLEDGE_FIXTURE_CANDIDATE_TEXT,
        textDigest: memory.textDigest(KNOWLEDGE_FIXTURE_CANDIDATE_TEXT),
        tags: [],
        evidence: [{ sessionId: opts.sessionId ?? 'fixture' }],
        confidenceClass: 'inferred'
      }
    : null
  if (opts.sessionId) entry.evidence = [{ sessionId: opts.sessionId }]
  const entries = [entry, ...(candidate ? [candidate] : [])]
  const manifest = {
    schemaVersion: memory.PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    projectId,
    revision: 1,
    updatedAt: now,
    entries: entries.map((item) => memory.pointerOf(item))
  }
  const dir = join(dataDir, 'project-knowledge', projectId)
  for (const item of entries) {
    mkdirSync(join(dir, 'entries', item.id), { recursive: true })
    writeFileSync(join(dir, 'entries', item.id, 'r1.json'), JSON.stringify(item, null, 2), 'utf8')
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(
    `  项目知识 fixture：${projectId}/${entry.id}${candidate ? ` + ${candidate.id}（候选）` : ''}（digest ${entry.textDigest.slice(0, 8)}${opts.sessionId ? `，来源会话 ${opts.sessionId}` : ''}）`
  )
}

async function checkKnowledgeCli(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const manifestFile = join(sandboxRoot, 'data', 'project-knowledge', KNOWLEDGE_FIXTURE_PROJECT_ID, 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    const active = entries.filter((entry) => entry.status === 'active')
    const candidates = entries.filter((entry) => entry.status === 'candidate')
    lines.push(`  manifest：revision=${manifest.revision} 共 ${entries.length} 条（active ${active.length} / candidate ${candidates.length}）`)
    for (const entry of entries) lines.push(`    ${entry.id} ${entry.status} ${entry.kind}`)
    say(entries.length >= 2, '磁盘上真的多了一条（propose 写进去了）')
    say(candidates.length >= 1, '新条目落成 candidate（模型不能自证 user-confirmed）')
    say(active.length === 1, 'active 条目仍然只有 fixture 那一条')
  } catch (error) {
    say(false, '读 manifest 失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(!/\[knowledgecli\]\s+[1-9]\d*\s+条失败/.test(probeText), '探针自身没有失败项')
  return { ok, lines }
}

function checkSubagentForkCache(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) return { ok: true, lines: ['  （非隔离运行，跳过）'] }
  const note = join(sandboxRoot, 'fixture-project', 'dup', 'one', 'fork-note.txt')
  const text = existsSync(note) ? readFileSync(note, 'utf8') : ''
  say(/\bone\b/.test(text) && /\btwo\b/.test(text), `fork 写出的 fork-note.txt 含两个常量名（${JSON.stringify(text.trim().slice(0, 80))}）`)
  const id = /FORK_ID=(sub-[0-9a-f]+)/.exec(probeText ?? '')?.[1]
  const dir = id ? join(sandboxRoot, 'data', 'subagents', 'sessions', id) : ''
  const file = dir && existsSync(dir) ? readdirSync(dir).find((name) => name.endsWith('.jsonl')) : undefined
  say(!!file, `找到 fork 子会话文件（${id ?? '无 id'}）`)
  if (!file) return { ok, lines }
  const entries = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const directiveAt = entries.findIndex((entry) => entry.type === 'message' && entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes('fork-directive'))
  say(directiveAt > 0, 'fork 子会话在继承的历史之后接上 fork 指令')
  const inherited = entries.slice(0, Math.max(0, directiveAt)).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').length
  say(inherited > 0, `继承了父会话 ${inherited} 条助手消息`)
  const parentLast = entries.slice(0, Math.max(0, directiveAt)).filter((entry) => entry.message?.role === 'assistant' && entry.message.usage).at(-1)?.message.usage
  const first = entries.slice(directiveAt + 1).find((entry) => entry.message?.role === 'assistant' && entry.message.usage)?.message.usage
  const prompt = (u) => (u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0)
  lines.push(`  父会话最后一次请求 prompt=${prompt(parentLast)}；fork 首个请求 prompt=${prompt(first)} cacheRead=${first?.cacheRead ?? 0}`)
  say(!!first && (first.cacheRead ?? 0) >= prompt(parentLast) * 0.5, 'fork 首个请求复用了父会话的提示缓存（cacheRead ≥ 父会话 prompt 的一半）')
  return { ok, lines }
}

function checkSubagentArchive(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const byMark = (mark) => records.find((r) => String(r.task ?? '').includes(mark))
  const patchExists = (r) => !!r?.patchPath && existsSync(r.patchPath)

  const expect = (mark, review, label) => {
    const run = byMark(mark)
    say(!!run, `找到 ${label} 记录`)
    if (!run) return null
    say(run.review === review, `${label} review=${run.review}（期望 ${review}）`)
    return run
  }

  const alpha = expect('YAN-ALPHA', 'merged', 'ALPHA')
  if (alpha) say(patchExists(alpha), 'ALPHA 的补丁留在归档目录（合并后仍可追溯）')
  const beta = expect('YAN-BETA', 'discarded', 'BETA')
  if (beta) say(patchExists(beta), 'BETA 的补丁留在归档目录（放弃但没丢）')
  expect('YAN-CONFLICT-D', 'merged', 'CONFLICT-D')
  const conflictC = expect('YAN-CONFLICT-C', 'archived', 'CONFLICT-C')
  if (conflictC) say(patchExists(conflictC) || !conflictC.diff?.files, 'CONFLICT-C 的冲突补丁也归档了')
  const longrun = expect('YAN-LONGRUN', 'archived', 'LONGRUN')
  if (longrun) say(patchExists(longrun) || !longrun.diff?.files, 'LONGRUN 的退出归档落盘')
  expect('YAN-READONLY', 'none', 'READONLY')

  const repo = join(sandboxRoot, 'fixture-project', 'repo')
  say(existsSync(join(repo, 'alpha.txt')), '主工作树留住了已合并的 alpha.txt')
  say(!existsSync(join(repo, 'beta.txt')), '被放弃的 beta.txt 没有进主工作树')
  say(!existsSync(join(repo, 'readonly-attempt.txt')), '只读子代理没能写进主工作树')
  let readme = ''
  try {
    readme = readFileSync(join(repo, 'README.md'), 'utf8')
  } catch {
  }
  say(readme.includes('LINE-D'), '主工作树 README 是 CONFLICT-D 的版本')
  say(!readme.includes('LINE-C'), '冲突的 CONFLICT-C 没有被半截写入')

  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  for (const dir of leftovers) {
    const id = /^yan-subagent-(sub-[0-9a-f]+)-/.exec(dir)?.[1]
    const owner = records.find((r) => r.id === id)
    lines.push(`    残留 ${dir} → ${owner ? String(owner.task ?? '').slice(0, 24) + `（${owner.review}）` : '未知任务'}`)
  }
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`)

  return { ok, lines }
}

function checkSessionabArchive(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []
  const fileOf = (tag) => files.find((f) => f.includes(`yan-ab-${tag}-`) && f.endsWith('.jsonl'))
  const readMessages = (file) => {
    const text = readFileSync(join(sessionsRoot, file), 'utf8')
    const msgs = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'message') msgs.push(o.message)
      } catch {
      }
    }
    return msgs
  }
  const textOf = (msgs, role) =>
    msgs
      .filter((m) => m?.role === role)
      .map((m) => (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
      .join('\n')

  const fileA = fileOf('a')
  const fileB = fileOf('b')
  const fileC = fileOf('c')
  lines.push(`  A=${fileA ?? '（缺失）'}  B=${fileB ?? '（缺失）'}  C=${fileC ?? '（缺失）'}`)
  say(!!fileA && !!fileB && !!fileC, '三个会话文件都还在')
  if (!fileA || !fileB || !fileC) return { ok, lines }

  const msgsA = readMessages(fileA)
  const msgsB = readMessages(fileB)
  const msgsC = readMessages(fileC)
  const aText = textOf(msgsA, 'assistant')
  const bText = textOf(msgsB, 'assistant')
  const cText = textOf(msgsC, 'assistant')

  lines.push(`  A 落盘：${msgsA.length} 条消息，助手正文 ${aText.length} 字`)
  say(/sleep \d+/.test(JSON.stringify(msgsA)), 'A 的会话记录里有那次工具调用（真执行了）')
  say(msgsA.filter((m) => m?.role === 'assistant').length >= 2, 'A 的会话文件里多了模型自己的回合（被中断也算落盘）')
  say(!bText.includes('YAN-AB') || bText.includes('YAN-AB-B-REPLY'), 'B 的回复属于 B（没被 A 的内容覆盖）')
  say(cText.includes('YAN-AB-C-REPLY'), 'C 的回复原样保留（同 cwd 被拒的那次没写坏它）')
  say(msgsC.filter((m) => m?.role === 'assistant').length === 1, 'C 只有一个助手回合（被拒后确实没动它）')

  let readme = ''
  try {
    readme = readFileSync(join(sandboxRoot, 'fixture-project', 'repo', 'README.md'), 'utf8')
  } catch {
  }
  say(readme.includes('LINE-BASE'), '与 A 同 cwd 的仓库工作树没被弄坏')

  return { ok, lines }
}

function checkAtRefSend(sandboxRoot) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const sessionsRoot = join(sandboxRoot, 'sessions')
  const files = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, t: statSync(join(sessionsRoot, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : []
  say(files.length > 0, `找到了会话文件（共 ${files.length} 个）`)
  if (!files.length) return { ok, lines }

  const file = files[0].f
  const raw = readFileSync(join(sessionsRoot, file), 'utf8')
  lines.push(`  最新会话 = ${file}（${raw.length} 字节）`)

  say(raw.includes('@README.md'), '引用路径原样送达模型（RPC 不展开 @，模型自行读取）')
  const readIt = raw.includes('fixture project')
  lines.push(`  （模型本轮是否真去读了该文件：${readIt ? '是' : '否'}；会话 ${raw.length} 字节）`)
  say(/read|已读|第一行/.test(raw), '模型按任务回了话（引用语法没有打断这一轮）')

  return { ok, lines }
}

function checkGitWriteApplied(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }
  const repo = join(sandboxRoot, 'fixture-project', 'write')
  const bare = join(sandboxRoot, 'fixture-project', 'write-remote.git')
  const read = (args, cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  try {
    lines.push(
      '  ⓘ 实际：HEAD=' +
        read(['log', '-1', '--pretty=%s']) +
        ' / 分支=' +
        read(['rev-parse', '--abbrev-ref', 'HEAD']) +
        ' / 最近三条=' +
        JSON.stringify(read(['log', '-3', '--pretty=%s']).split(String.fromCharCode(10)))
 +
        ' / 全部分支提交=' +
        JSON.stringify(read(['log', '--all', '--pretty=%h %s']).split(String.fromCharCode(10))) +
        ' / main=' +
        read(['rev-parse', 'main']) +
        ' live-made=' +
        read(['rev-parse', '--verify', 'live-made'])
    )
    say(
      read(['log', '-1', '--pretty=%s']) === 'feat: live 写操作验收',
      'HEAD 上的提交正是界面上输入的那条说明'
    )
    say(read(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main', '收尾时停在 main 分支（探针最后切回来了）')
    say(read(['branch', '--list', 'live-made']) !== '', '新建的分支 live-made 真的存在')

    const status = read(['status', '--porcelain'])
    const aLine = status.split('\n').find((l) => l.endsWith('a.txt')) ?? ''
    say(
      aLine === '' || aLine.startsWith('??') === false,
      'a.txt 没有留在「已暂存」里（暂存的内容随提交进了历史）[' + aLine + ']'
    )

    const localHead = read(['rev-parse', 'HEAD'])
    const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    say(localHead === remoteHead, 'bare remote 里的 main 与本地 HEAD 相同（推送成功）')
  } catch (error) {
    say(false, '退出后读仓库失败：' + (error instanceof Error ? error.message : String(error)))
  }

  say(/\[gitwrite\]/.test(probeText), '探针确实跑到了写操作场景（输出里有 [gitwrite] 小结）')

  try {
    const trustFile = join(sandboxRoot, 'pi-agent', 'trust.json')
    const table = JSON.parse(readFileSync(trustFile, 'utf8'))
    const keys = Object.keys(table)
    const wtKey = keys.find((k) => /live-carry/i.test(k))
    say(keys.length >= 2, 'trust.json 里至少有两条（主仓库 + 工作树）：' + keys.length)
    say(!!wtKey, '其中一条是工作树目录：' + String(wtKey ?? '(无)'))
    say(keys.every((k) => table[k] === true), '两条的值都是 true（没有写出 false 条目）')
  } catch (error) {
    say(false, '退出后读 trust.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  if (/\[gitwrite\]\s+[1-9]\d*\s+条失败/.test(probeText)) say(false, '探针自身有失败项（见上面的 ✗）')

  const sessionId = /worktreelink\.sessionId=([A-Za-z0-9._-]+)/.exec(probeText)?.[1]
  const worktree = /worktreelink\.worktree=(.+)/.exec(probeText)?.[1]?.trim()
  say(!!sessionId && !!worktree, `探针报告了新会话与工作树（${sessionId} / ${worktree}）`)
  const linkFile = join(sandboxRoot, 'data', 'worktree-links.json')
  if (!existsSync(linkFile)) {
    say(false, `没有找到 ${linkFile}（关系没落盘）`)
  } else {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(linkFile, 'utf8'))
    } catch {
    }
    const item = Array.isArray(parsed?.links) ? parsed.links.find((x) => x?.sessionId === sessionId) : null
    say(!!item, '磁盘上的那条关系就是探针登记的那条（会话 id 对得上）', JSON.stringify(item ?? null))
    if (item) {
      say(item.worktree === worktree, '工作树目录对得上', String(item.worktree))
      say(!!item.fromSessionId, '源会话记下来了（不是一条孤立记录）', String(item.fromSessionId))
      say(item.fromSessionId !== item.sessionId, '源会话与新会话不是同一条（方向没写反）')
      say(Number.isFinite(item.at) && item.at > 0, '带时间戳', String(item.at))
    }
  }

  return { ok, lines }
}

async function checkProjectOpenedLayout(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const openedId = /projectopened\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!openedId, `探针报告了被打开的会话（${openedId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }
  const file = join(sandboxRoot, 'data', 'session-layout.json')
  if (!existsSync(file)) {
    say(false, `没有找到 ${file}（打开记录没落盘）`)
    return { ok, lines }
  }
  let doc = null
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
  }
  const entries = Array.isArray(doc?.entries) ? doc.entries : null
  say(!!entries, 'session-layout.json 是合法的（有 entries 数组）')
  if (!entries) return { ok, lines }
  const opened = entries.find((e) => e?.sessionId === openedId)
  const hot = entries.find((e) => String(e?.sessionId ?? '').includes('yan-n05-hot'))
  say(!!opened, '被打开的那条在布局索引里')
  if (opened) say(Number.isFinite(opened.lastOpenedAt) && opened.lastOpenedAt > 0, '它的 lastOpenedAt 真的落盘了', String(opened.lastOpenedAt))
  say(!!hot, 'hot 那条也在索引里（对照项没有缺席）')
  if (hot) say(!hot.lastOpenedAt, 'hot 那条没有被写上 lastOpenedAt（没打开过就不该有）', String(hot.lastOpenedAt ?? '无'))
  return { ok, lines }
}

async function checkSourceLocateLinked(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }
  const text = String(probeText ?? '')
  const sid = /sourcelink\.sessionId=([A-Za-z0-9._-]+)/.exec(text)?.[1]
  const messageId = /sourcelink\.messageId=([A-Za-z0-9._:-]+)/.exec(text)?.[1]
  const sourceId = /sourcelink\.sourceId=(image:[A-Za-z0-9._-]+)/.exec(text)?.[1]
  say(!!sid && !!messageId && !!sourceId, `探针报告了定位信息（${sid} / ${messageId} / ${sourceId}）`)
  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok, lines }
  }

  const safe = String(sid ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  const hits = []
  const walk = (dir, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'links.json' && full.includes(safe)) hits.push(full)
    }
  }
  walk(sandboxRoot)
  say(hits.length === 1, `磁盘上找得到 links.json（${hits.length} 个）`, hits[0] ?? '')
  if (hits.length === 1) {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(hits[0], 'utf8'))
    } catch {
    }
    say(Array.isArray(parsed), '文件是合法 JSON 数组')
    const item = Array.isArray(parsed) ? parsed.find((x) => x?.sourceId === sourceId) : null
    say(!!item && item.messageId === messageId, '文件里那条关联的 sourceId + messageId 都对得上', JSON.stringify(item))
    say(Array.isArray(parsed) && parsed.length === 1, '只有一条（幂等：重复登记没写第二条）', String(parsed?.length))
  }
  return { ok, lines }
}

function checkExitSnapshot(sandboxRoot, tempBefore, lastProbeText) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data')
  const file = join(dir, 'exit-snapshot.json')
  const expectMode = /expect-mode=(\w+)/.exec(lastProbeText)?.[1] ?? null
  const probeAt = Number(/probe-at=(\d+)/.exec(lastProbeText)?.[1] ?? 0)
  const runnerCount = Number(/^runners=(\d+)$/m.exec(lastProbeText)?.[1] ?? -1)

  say(!!expectMode, `探针声明了期望的 mode（${expectMode ?? '缺失'}）`)
  say(probeAt > 0, `探针报了自己的时刻（${probeAt || '缺失'}）`)
  if (!existsSync(file)) {
    say(false, '退出快照 exit-snapshot.json 已写下', file)
    return { ok, lines }
  }
  say(true, '退出快照 exit-snapshot.json 已写下')

  let snapshot = null
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
  }
  if (!snapshot) {
    say(false, '文件是合法 JSON')
    return { ok, lines }
  }

  say(snapshot.version === 1, 'version=1（格式契约）', String(snapshot.version))
  say(
    !!expectMode && snapshot.mode === expectMode,
    `mode 与本次请求一致（期望 ${expectMode}，实际 ${snapshot.mode}）`
  )
  say(
    typeof snapshot.at === 'number' && snapshot.at >= probeAt && snapshot.at - probeAt < 120_000,
    'at 是这次退出写的（探针时刻之后、120s 之内）',
    `at-probe=${(snapshot.at ?? 0) - probeAt}ms`
  )

  const runners = Array.isArray(snapshot.runners) ? snapshot.runners : null
  say(!!runners, 'runners 是数组')
  if (runners) {
    say(
      runnerCount >= 0 && runners.length === runnerCount,
      `runners 条数与窗口里看到的一致（窗口 ${runnerCount} / 快照 ${runners.length}）`
    )
    const shaped = runners.every((r) => r && typeof r.cwd === 'string' && typeof r.conn === 'string' && typeof r.running === 'boolean')
    say(shaped, '每条都带 cwd / conn / running（元数据，不含消息正文）')
    const bodies = JSON.stringify(snapshot)
    say(!/"(content|text|message|messages)"\s*:/.test(bodies), '快照里没有消息正文/消息数组字段')
    lines.push(`    实例：${runners.map((r) => `${r.id}@${r.conn}${r.running ? '(running)' : ''}`).join(' ') || '（空）'}`)
  }

  const temps = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('exit-snapshot.json.') && f.endsWith('.tmp'))
    : []
  say(temps.length === 0, '没有留下写一半的 .tmp（原子写：tmp → rename）', temps.join(' '))
  return { ok, lines }
}

function checkSubagentFail(sandboxRoot, tempBefore) {
  const lines = []
  let ok = true
  const say = (good, text, extra = '') => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text + (extra ? '  ' + extra : ''))
    if (!good) ok = false
  }

  if (!sandboxRoot) {
    lines.push('  （非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'subagents')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const records = []
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
    }
  }
  lines.push(`  元数据 ${records.length} 份：${files.join(' ') || '（空）'}`)

  const run = records.find((r) => String(r.task ?? '').includes('YAN-SUBFAIL'))
  say(!!run, '找到 YAN-SUBFAIL 的归档记录', String(run?.task ?? ''))
  if (run) {
    say(run.status === 'error', `归档里 status=error（实际 ${run.status}）`)
    say(run.review === 'none', `没有改动 → review=none（实际 ${run.review}）`)
    say(run.endedAt > 0 && run.startedAt > 0, '有起止时间（可追溯）')
  }

  const leftovers = readdirSync(tmpdir()).filter(
    (n) => n.startsWith('yan-subagent-') && !(tempBefore ?? new Set()).has(n)
  )
  say(leftovers.length === 0, `退出后没有残留的隔离目录（新增 ${leftovers.length} 个）`, leftovers.join(' '))

  return { ok, lines }
}

const SEED_BEFORE_RESTART = {
  interruptedSnapshot: seedInterruptedSnapshot
}

function seedInterruptedSnapshot(sandboxRoot) {
  if (!sandboxRoot) return '（无沙箱，跳过）'
  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  if (!files.length) return '（没有计时日志，跳过）'
  const file = join(dir, files[files.length - 1])
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return '（日志为空，跳过）'
  const last = JSON.parse(lines[lines.length - 1])
  const snapshot = {
    ...last,
    final: false,
    elapsedMs: Math.max(1, Math.round((Number(last.elapsedMs) || 1) * 0.4))
  }
  appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
  return `${basename(file)}：追加中途快照（final=false，logicalTurnId=${last.logicalTurnId}）`
}

const AFTER_EXIT = {
  exitSnapshot: checkExitSnapshot,
  remoteRoutes: checkRemoteRoutes,
  subagentFail: checkSubagentFail,
  subagentArchive: checkSubagentArchive,
  subagentForkCache: checkSubagentForkCache,
  knowledgeCli: checkKnowledgeCli,
  sessionabArchive: checkSessionabArchive,
  atrefsendArchive: checkAtRefSend,
  browserBoundaryDownloads: checkBrowserBoundaryDownloads,
  sourceLocateLinked: checkSourceLocateLinked,
  projectOpenedLayout: checkProjectOpenedLayout,
  gitWriteApplied: checkGitWriteApplied,
  taskFixtureReadonly: checkTaskFixtureReadonly,
  taskCliLog: checkTaskCliLog,
  taskPlanMultiStep: checkTaskPlanMultiStep,
  turnTimingIsolation: checkTurnTimingIsolation,
  turnTimingInterrupted: checkTurnTimingInterrupted,
  turnTimingHardKill: checkTurnTimingHardKill,
  languageInjection: checkLanguageInjection
}

let taskFixtureBaseline = null

function captureSessionFile(sessionsRoot, needle) {
  const found = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.jsonl') && e.name.includes(needle)) found.push(p)
    }
  }
  walk(sessionsRoot)
  if (!found[0]) return null
  return { path: found[0], text: readFileSync(found[0], 'utf8') }
}

async function checkTaskFixtureReadonly() {
  const lines = []
  if (!taskFixtureBaseline) {
    return { ok: false, lines: ['✗ 没有会话只读基线（场景里没找到 fixture 会话）'] }
  }
  let after = ''
  try {
    after = readFileSync(taskFixtureBaseline.path, 'utf8')
  } catch (err) {
    return { ok: false, lines: [`✗ 读不到基线会话文件：${err.message}`] }
  }
  let ok = true
  lines.push(
    `基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
  )
  if (after.startsWith(taskFixtureBaseline.text)) {
    lines.push('✓ 原有内容逐字节不变（只允许在末尾追加）')
  } else {
    ok = false
    lines.push('✗ 原有内容被改写了（前缀不一致）—— 契约要求历史文件不回写、不批量转换')
  }
  const added = after.slice(taskFixtureBaseline.text.length)
  const addedLines = added.split('\n').filter(Boolean)
  lines.push(`追加 ${addedLines.length} 行：`)
  for (const l of addedLines.slice(0, 5)) lines.push(`  · ${l.slice(0, 200)}`)
  const taskWrites = addedLines.filter(
    (l) => l.includes('left-panel-tasks') || l.includes('yan-task-plan')
  )
  if (taskWrites.length) {
    ok = false
    lines.push(`✗ 追加里出现了任务快照条目（${taskWrites.length} 条）—— 砚不应替模型伪造任务写入`)
  } else {
    lines.push('✓ 追加里没有任务快照条目（没有伪造任务写入）')
  }
  return { ok, lines }
}

async function checkTurnTimingIsolation(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  let snapshot = null
  try {
    const raw = /^\s*turn-timing-isolation\.snapshot=(.+)$/m.exec(probeText)?.[1]
    snapshot = raw ? JSON.parse(raw) : null
  } catch {
    snapshot = null
  }
  say(!!snapshot?.a && !!snapshot?.b, '探针保存 A / B 的实际 sessionFile、用户锚点和读回消息 id')

  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const checkSession = (tag) => {
    const entry = snapshot?.[tag]
    const expectedUserId = entry?.userId
    const fileName = entry?.sessionFile ? `${basename(entry.sessionFile).replace(/\.jsonl$/i, '')}.jsonl` : ''
    const path = fileName ? join(dir, fileName) : ''
    let records = []
    if (path && existsSync(path)) {
      records = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    }
    say(!!path && existsSync(path), `${tag.toUpperCase()} 写入自己的计时文件（${fileName || '缺少 sessionFile'}）`)
    say(/^m\d+$/.test(String(expectedUserId ?? '')), `${tag.toUpperCase()} 读回用户锚点（${expectedUserId ?? '缺失'}）`)
    const matching = records.filter((record) => record?.logicalTurnId === expectedUserId)
    say(matching.length >= 1, `${tag.toUpperCase()} 的分桶包含自己的逻辑回合（${matching.length} 条快照）`)
    const final = matching.filter((record) => record.final === true).at(-1)
    const latest = matching.at(-1)
    lines.push(`  ${tag.toUpperCase()} 最近快照 = ${JSON.stringify(latest ? { final: latest.final, terminalReason: latest.terminalReason, elapsedMs: latest.elapsedMs, runId: latest.runId } : null)}`)
    say(!!final, `${tag.toUpperCase()} 有终止快照`)
    say(latest?.final === true, `${tag.toUpperCase()} 的最新快照就是终止快照（final=${String(latest?.final)}）`)
    if (!final) return null
    say(final.anchorId === expectedUserId, `${tag.toUpperCase()} 的落盘锚点仍指向本会话的用户消息`)
    say(final.terminalReason === 'completed', `${tag.toUpperCase()} 回合正常完成（${final.terminalReason}）`)
    say(
      Array.isArray(final.sourceIds) && final.sourceIds.length >= 1,
      `${tag.toUpperCase()} 收尾记录保留运行时 sourceIds（${JSON.stringify(final.sourceIds ?? [])}）`
    )
    say(
      (entry?.timedAssistantIds ?? []).length >= 1,
      `${tag.toUpperCase()} 的计时呈现在重读后的本回合助手回复上（${JSON.stringify(entry?.timedAssistantIds ?? [])}）`
    )
    return final
  }

  const a = checkSession('a')
  const b = checkSession('b')
  if (a && b) {
    say(
      !!a.runId && !!b.runId && a.runId !== b.runId,
      `A、B 两个 runner 各有自己的 runId（${a.runId} / ${b.runId}）`
    )
    say(
      Number(b.elapsedMs) > Number(a.elapsedMs) + 2500,
      `不同 fixture 延迟仍按会话归属（A=${a.elapsedMs}ms，B=${b.elapsedMs}ms）`
    )
  }
  say(
    Number(handoffFailureState?.maxConcurrent ?? 0) >= 2,
    `本机 provider 确认两条请求曾同时在途（最大并发 ${handoffFailureState?.maxConcurrent ?? 0}）`
  )
  say(Number(handoffFailureState?.turnRequests ?? 0) >= 2, `本机 provider 收到两条回合请求（${handoffFailureState?.turnRequests ?? 0}）`)
  return { ok, lines }
}

async function checkLanguageInjection() {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  let records = []
  try {
    records = readFileSync(LANG_EXT_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  } catch {
    return { ok: false, lines: [`✗ 没有扩展注入日志（${LANG_EXT_LOG}）—— 语言规则没有经扩展注入`] }
  }
  const starts = records.filter((record) => record.hook === 'start')
  const langs = starts.map((record) => record.lang)
  say(starts.length >= 3, `每轮都经过 before_agent_start 注入（${starts.length} 次）`)
  say(
    langs.every((lang) => lang === 'zh-CN' || lang === 'en-US'),
    `每轮读到具体语言（${[...new Set(langs)].join(', ') || '无'}）`
  )
  say(starts.every((record) => record.injected === true), '每轮真的注入了语言提示（injected=true）')
  say(starts.every((record) => Number(record.baseLen) > 0), '注入时带着 pi 的原始系统提示（baseLen > 0）')
  const firstEnglish = langs.indexOf('en-US')
  say(firstEnglish > 0, `切英文界面后下一轮就注入 en-US（第 ${firstEnglish + 1} 次起）`)
  say(firstEnglish > 0 && langs.slice(firstEnglish).includes('zh-CN'), '切回中文后下一轮注入又变回 zh-CN')
  lines.push(`  记录顺序：${langs.join(' → ') || '无'}`)
  lines.push('  （模型是否真按注入的语言回复属模型行为，不在本检查里判；探针只打印观察值）')
  return { ok, lines }
}

async function loadTurnTimingStore() {
  const file = join(root, 'out/test/turn-timing-store.mjs')
  if (!existsSync(file)) {
    try {
      await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
        build({
          entryPoints: ['src/main/turn-timing-store.ts'],
          outfile: 'out/test/turn-timing-store.mjs',
          bundle: true,
          format: 'esm',
          platform: 'node',
          logLevel: 'silent'
        })
      )
    } catch {
      return null
    }
  }
  try {
    const { pathToFileURL } = await import('node:url')
    return await import(pathToFileURL(file).href)
  } catch {
    return null
  }
}

async function checkTurnTimingInterrupted(sandboxRoot, _tempBefore, probeText = '') {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const dir = join(sandboxRoot, 'data', 'turn-timing')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`  目录 = ${dir}`)
  const records = []
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
      }
    }
  }
  const last = records[records.length - 1]
  const realHardKill = String(probeText).includes('turn-timing.hardkill.processExitedAfterForce=true')
  lines.push(`  turn-timing.disk.records=${JSON.stringify(records)}`)
  say(
    realHardKill ? records.length === 1 : records.length >= 2,
    realHardKill
      ? `真强杀后磁盘只保留中途快照（${records.length} 条）`
      : `同一回合有收尾 + 中途两条记录（${records.length}）`
  )
  say(last?.final === false, `盘上最后一条是中途快照（final=${String(last?.final)}）`)

  const store = await loadTurnTimingStore()
  say(
    store.effectiveTerminalReason(last) === 'interrupted',
    `中途快照被归一为「中断」（${store.effectiveTerminalReason(last)}）`
  )

  const uiReason = /turn-timing\.interrupted\.reason=(\w+)/.exec(probeText)?.[1]
  say(uiReason === 'interrupted', `重启后的探针从 peeking 的历史里读到「中断」（${uiReason}）`)
  const footer = /turn-timing\.interrupted\.footer=("[^\n]*")/.exec(probeText)?.[1]
  say(/中断/.test(footer ?? ''), `真实页脚里写出「已中断」（${footer}）`)
  return { ok, lines }
}

async function checkTurnTimingHardKill(sandboxRoot, tempBefore, probeText = '') {
  const base = await checkTurnTimingInterrupted(sandboxRoot, tempBefore, probeText)
  const lines = [...base.lines]
  let ok = base.ok
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  const text = String(probeText)
  say(text.includes('turn-timing.hardkill.processExitedAfterForce=true'), '隔离 Electron 在强制终止请求后退出')
  say(text.includes('turn-timing.hardkill.snapshot='), '父进程输出了强杀前读到的完整快照')
  say(text.includes('turn-timing.interrupted.userMarkerPresent=true'), '重启后从同一测试会话读到唯一用户标记')
  say(text.includes('turn-timing.interrupted.toolCallPresent=true'), '重启后会话保留了触发中途快照的 bash tool call')
  say(handoffFailureState?.failureMode === 'turn-timing-kill', '场景使用隔离的本机 fixture provider')
  say(handoffFailureState?.bashToolOffered === true && handoffFailureState?.toolCallSent === true, 'fixture 确认收到工具 schema 并返回 bash tool call')
  say(handoffFailureState?.followupHeld === true, 'pi 已执行工具并发出第二次模型请求，该请求仍在途时才强杀')
  say(Number(handoffFailureState?.turnRequests ?? 0) === 2, `本机 provider 收到首轮工具调用与第二轮续接请求（${handoffFailureState?.turnRequests ?? 0}）`)
  return { ok, lines }
}

async function checkTaskCliLog(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskcli\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskcli\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志目录：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)

  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名（不是 runner id / 时间戳）')
  say(
    files.every((f) => /^[0-9A-Za-z._-]+\.jsonl$/.test(f)),
    '文件名都是合法会话 id（没有 pending: / 路径分隔符）'
  )

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length === 2, `两次提交写了两行（实际 ${valid.length} 行）`)
  say(
    valid.every((r) => r.data?.schemaVersion === 1),
    '每行都带 schemaVersion = 1（读回来判版本用）'
  )
  say(
    valid[0]?.data?.revision === 1 && valid[1]?.data?.revision === 2,
    `revision 从 1 递增到 2（实际 ${valid.map((r) => r.data?.revision).join(' → ')}）`
  )
  say(
    !!valid[0]?.data?.operationId && valid[0].data.operationId !== valid[1]?.data?.operationId,
    '两次提交各有自己的 operationId（幂等键随提交变化）'
  )
  say(valid[0]?.data?.todos?.length === 3, `第一行是三项（实际 ${valid[0]?.data?.todos?.length}）`)
  say(valid[1]?.data?.todos?.[1]?.done === true, '第二行第 2 项已完成（complete 真的落盘了）')
  say(
    valid.every((r) => Number.isInteger(r.round) && r.round >= 1),
    '每行都记了轮次（历史分组靠它）'
  )
  say(valid.every((r) => typeof r.at === 'string' && r.at.length > 0), '每行都有提交时间')

  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(
      !sessionText.includes('left-panel-tasks'),
      '也没有旧标识的任务条目（本场景没有旧扩展）'
    )
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

async function checkTaskPlanMultiStep(sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  if (!sandboxRoot) {
    lines.push('（非隔离运行：没有可检查的沙箱，跳过）')
    return { ok: true, lines }
  }

  const text = String(probeText ?? '')
  const sid = /taskplan\.sessionId=([0-9A-Za-z._-]+)/.exec(text)?.[1] ?? ''
  const sessionFile = /taskplan\.sessionFile=(.+)/.exec(text)?.[1]?.trim() ?? ''
  const todoLine = text.split(/\r?\n/).find((l) => l.startsWith('taskplan.todos=')) ?? ''
  let uiTodos = []
  try {
    const parsed = JSON.parse(todoLine.slice('taskplan.todos='.length))
    if (Array.isArray(parsed)) uiTodos = parsed
  } catch {
    uiTodos = []
  }

  const tasksDir = join(sandboxRoot, 'fixture-project', 'tasks')
  const steps = [1, 2, 3].map((n) => join(tasksDir, `step-${n}.txt`))
  const made = steps.filter((p) => existsSync(p))
  const nonEmpty = made.filter((p) => readFileSync(p, 'utf8').trim().length > 0)
  lines.push(`真实文件：` + `tasks/step-*.txt 存在 ${made.length}/3（非空 ${nonEmpty.length}）`)
  say(made.length >= 2, '模型真的建了文件（多步任务确实执行了，不是只登记计划）')
  say(nonEmpty.length === made.length, '建出来的文件都有内容（不是空文件占位）')

  const dir = join(sandboxRoot, 'data', 'task-plans')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []
  lines.push(`任务日志：${files.length ? files.join('、') : '（空）'}；会话 id = ${sid || '（探针没报）'}`)
  say(!!sid && files.includes(`${sid}.jsonl`), '日志按会话 id 命名')

  const path = sid ? join(dir, `${sid}.jsonl`) : null
  const raw = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  const bad = rows.filter((r) => r === null).length
  const valid = rows.filter(Boolean)
  say(bad === 0, `没有写坏的行（坏行 ${bad} 条）`)
  say(valid.length >= 2, `模型自主提交了 ${valid.length} 次（登记 + 勾选）`)
  const revisions = valid.map((r) => r.data?.revision)
  const increasing = revisions.every((v, i) => (i === 0 ? v === 1 : v === revisions[i - 1] + 1))
  say(increasing, `revision 逐次 +1（实际 ${revisions.join(' → ')}）`)
  say(valid.every((r) => r.data?.schemaVersion === 1), '每行都带 schemaVersion = 1')

  const last = valid[valid.length - 1]
  const diskTodos = Array.isArray(last?.data?.todos) ? last.data.todos : []
  lines.push('  磁盘最后一行 todos = ' + JSON.stringify(diskTodos.map((t) => ({ text: t.text, done: t.done }))))
  say(diskTodos.length === 3, `日志最后一行是 3 条（实际 ${diskTodos.length}）`)

  say(
    JSON.stringify(uiTodos.map((t) => t.text)) === JSON.stringify(diskTodos.map((t) => t.text)),
    '界面清单与磁盘日志的文字逐条一致（不是各显示一套）',
    uiTodos.length ? '' : '（探针没报 todos，比对不可信）'
  )
  say(
    JSON.stringify(uiTodos.map((t) => !!t.done)) === JSON.stringify(diskTodos.map((t) => !!t.done)),
    '勾选状态也一致'
  )
  say(
    diskTodos.every((t) => typeof t.text === 'string' && t.text.trim().length > 0),
    '日志里每条都有非空文字（没有空条目）'
  )

  if (sessionFile && existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, 'utf8')
    say(
      !sessionText.includes('yan-task-plan'),
      '会话 JSONL 里没有被写入任务条目（宿主日志在砚自己的目录）'
    )
    say(!sessionText.includes('left-panel-tasks'), '也没有旧标识的任务条目（本场景没有旧扩展）')
  } else {
    lines.push('（探针没报会话文件路径，跳过会话 JSONL 检查）')
  }

  return { ok, lines }
}

function orphanPiProcesses() {
  if (process.platform !== 'win32') return null
  const script = [
    '$all = Get-CimInstance Win32_Process',
    '$ids = @{}',
    'foreach ($p in $all) { $ids[[int]$p.ProcessId] = 1 }',
    'foreach ($p in $all) {',
    "  if ($p.CommandLine -and $p.CommandLine -match '--mode\\s+rpc') {",
    '    if (-not $ids.ContainsKey([int]$p.ParentProcessId)) {',
    '      "ORPHAN pid=$($p.ProcessId) parent=$($p.ParentProcessId)"',
    '    }',
    '  }',
    '}'
  ].join('; ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ORPHAN'))
  } catch {
    return null
  }
}

const BOUNDARY_PORT = 39873
const BOUNDARY_ORIGIN = `http://127.0.0.1:${BOUNDARY_PORT}`
let REMOTE_ROUTE_API_PORT = Number(process.env.YAN_TEST_REMOTE_PORT ?? 37893)
const REMOTE_ROUTE_TOKEN = 'yan-remote-route-probe-token-2026'
let remoteRouteProbeState = null
let handoffFailureState = null
const BOUNDARY_SECRET = `yan-probe-cookie-${Date.now()}`

function startRemoteRouteProvider() {
  const state = {
    requests: 0,
    canceledStreams: 0,
    completedStreams: 0,
    targetRequests: 0,
    canceledTargetStreams: 0,
    completedTargetStreams: 0,
    responses: new Set()
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      state.requests++
      const isTargetRequest = raw.includes('Reply briefly. This is an isolated local route test; do not use tools.')
      if (isTargetRequest) state.targetRequests++
      try {
        const payload = JSON.parse(raw)
        state.models ??= []
        state.models.push(payload.model)
      } catch {
        state.invalidBodies = (state.invalidBodies ?? 0) + 1
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      state.responses.add(res)
      res.write(
        `data: ${JSON.stringify({
          id: 'remote-route-probe',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'route-probe',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'local route fixture' }, finish_reason: null }]
        })}\n\n`
      )
      const finish = setTimeout(() => {
        if (res.destroyed) return
        state.completedStreams++
        if (isTargetRequest) state.completedTargetStreams++
        res.end('data: [DONE]\n\n')
      }, 60_000)
      finish.unref()
      res.on('close', () => {
        clearTimeout(finish)
        state.responses.delete(res)
        if (!res.writableFinished) {
          state.canceledStreams++
          if (isTargetRequest) state.canceledTargetStreams++
        }
      })
    })
  })
  server.unref()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('远程路由本机 provider 未分配 TCP 端口'))
        return
      }
      remoteRouteProbeState = state
      resolvePromise({ server, port: address.port, state })
    })
  })
}

async function closeRemoteRouteProvider(provider) {
  if (!provider) return
  for (const response of provider.state.responses) response.destroy()
  await new Promise((resolvePromise) => provider.server.close(() => resolvePromise()))
}

function startHandoffFailureProvider(failureMode = 'invalid-json') {
  const successReceiptFixture = failureMode === 'handoff-start-receipt'
  const reportCommand = 'yan goal report --report-id rp-commit-1 --phase executing --goal-revision 0'
  const handoffPackage = JSON.stringify({
    goal: '在隔离 Electron 中验证交接启动回执。',
    deliverable: '目的片段收到一条 handoff custom 消息并开始 provider 请求。',
    constraints: ['仅使用本机假 provider。'],
    acceptance: ['同 operationId 有 before_provider_request 回执。'],
    done: ['本机 provider 完成了首次目标报告。'],
    remaining: ['确认目的片段的启动回执。'],
    nextActions: ['确认回执后停止目标。'],
    blockers: [],
    files: [],
    notes: []
  })
  const state = {
    failureMode,
    requests: 0,
    turnRequests: 0,
    handoffRequests: 0,
    handoffFailureResponses: 0,
    handoffFailureStatus: 0,
    handoffFailureBody: '',
    activeRequests: 0,
    maxConcurrent: 0,
    promptTokensLast: 0,
    reportToolSent: false,
    responses: new Set()
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (part) => (raw += part))
    req.on('end', async () => {
      state.requests++
      let promptChars = 0
      let wantsStream = true
      let payload = null
      try {
        payload = JSON.parse(raw)
        promptChars = JSON.stringify(payload.messages ?? []).length
        wantsStream = payload?.stream !== false
      } catch {
      }
      const hasHandoffPrompt = raw.includes('跨会话交接')
      const isHandoff =
        hasHandoffPrompt &&
        (!successReceiptFixture || !Array.isArray(payload?.tools) || payload.tools.length === 0)
      if (isHandoff) state.handoffRequests++
      else {
        state.turnRequests++
        state.activeRequests++
        state.maxConcurrent = Math.max(state.maxConcurrent, state.activeRequests)
      }
      state.promptTokensLast = Math.ceil(promptChars / 2)
      if (failureMode === 'provider-http-failure' && isHandoff) {
        state.handoffFailureResponses++
        state.handoffFailureStatus = 503
        state.handoffFailureBody = 'fixture_handoff_provider_unavailable'
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          error: {
            message: state.handoffFailureBody,
            type: 'server_error',
            code: state.handoffFailureBody
          }
        }))
        return
      }
      const timingTag = raw.includes('YAN_TIMING_ISOLATION_B') ? 'B' : 'A'
      const timingFixture = failureMode === 'turn-timing' || failureMode === 'turn-timing-kill'
      const responseModel = timingFixture
        ? 'turn-timing-isolation-fixture'
        : successReceiptFixture
          ? 'handoff-start-receipt-fixture'
          : 'handoff-fail-fixture'
      const shouldSendReportTool =
        successReceiptFixture && !isHandoff && !state.reportToolSent && raw.includes(reportCommand)
      const text = failureMode === 'subagent-normal'
        ? '本机子代理 fixture：任务已收到。'
        : failureMode === 'turn-timing'
        ? `TURN_TIMING_ISOLATION_REPLY_${timingTag}`
        : failureMode === 'turn-timing-kill'
          ? 'H6B_TIMING_KILL_FIXTURE_REPLY'
        : successReceiptFixture
          ? isHandoff
            ? handoffPackage
            : '本机 handoff 回执 fixture 已完成。'
        : isHandoff
        ? failureMode === 'incomplete-package'
          ? '{}'
          : '这一次只回了一句话，没有按交接包要求的 JSON 形状输出。'
        : 'F7R_FILL ' + '这段文本只是把上下文写长，让真实的策略压缩能够触发。'.repeat(160)
      const completionTokens = Math.max(1, Math.ceil(text.length / 2))
      const usage = {
        prompt_tokens: state.promptTokensLast,
        completion_tokens: completionTokens,
        total_tokens: state.promptTokensLast + completionTokens
      }
      const id = timingFixture
        ? 'turn-timing-isolation-fixture'
        : successReceiptFixture
          ? 'handoff-start-receipt-fixture'
          : 'handoff-failure-fixture'
      if (failureMode === 'turn-timing') {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, timingTag === 'B' ? 10000 : 4000))
      }
      if (failureMode === 'turn-timing-kill' && state.turnRequests > 1) {
        state.followupHeld = true
        state.responses.add(res)
        res.once('close', () => {
          state.responses.delete(res)
          state.activeRequests = Math.max(0, state.activeRequests - 1)
        })
        return
      }
      if (shouldSendReportTool) {
        state.reportToolSent = true
        state.bashToolOffered = true
        state.toolCallSent = true
        const toolCall = {
          id: 'call_handoff_start_receipt_goal_report',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: reportCommand }) }
        }
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: responseModel,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage
          }))
        } else {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          state.responses.add(res)
          const writeChunk = (choice) => res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: responseModel,
            choices: [choice]
          })}\n\n`)
          writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
          writeChunk({ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null })
          writeChunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })
          res.end('data: [DONE]\n\n')
          res.once('close', () => state.responses.delete(res))
        }
        state.activeRequests = Math.max(0, state.activeRequests - 1)
        return
      }
      if (failureMode === 'turn-timing-kill' && payload?.tools?.some((tool) => tool?.function?.name === 'bash')) {
        state.bashToolOffered = true
        state.toolCallSent = true
        const toolCall = {
          id: 'call_h6b_turn_timing_kill',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'echo H6B_TURN_TIMING_KILL_TOOL_RAN' }) }
        }
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'turn-timing-isolation-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage
          }))
        } else {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          state.responses.add(res)
          const writeChunk = (choice) => res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'turn-timing-isolation-fixture',
            choices: [choice]
          })}\n\n`)
          writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
          writeChunk({ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null })
          writeChunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })
          res.end('data: [DONE]\n\n')
          res.once('close', () => state.responses.delete(res))
        }
        state.activeRequests = Math.max(0, state.activeRequests - 1)
        return
      }
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: responseModel,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage
          })
        )
        if (!isHandoff) state.activeRequests--
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      state.responses.add(res)
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: responseModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: responseModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage
        })}\n\n`
      )
      res.end('data: [DONE]\n\n')
      if (!isHandoff) state.activeRequests--
      res.on('close', () => state.responses.delete(res))
    })
  })
  server.unref()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('交接故障本机 provider 未分配 TCP 端口'))
        return
      }
      handoffFailureState = state
      resolvePromise({ server, port: address.port, state })
    })
  })
}

async function closeHandoffFailureProvider(provider) {
  if (!provider) return
  for (const response of provider.state.responses) response.destroy()
  await new Promise((resolvePromise) => provider.server.close(() => resolvePromise()))
}

async function assertPortAvailable(port) {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    })
  })
}

async function checkRemoteRoutes(_sandboxRoot, _tempBefore, probeText) {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '  ✓ ' : '  ✗ ') + text)
    if (!good) ok = false
  }
  say(String(probeText ?? '').includes('remote-routes.driver.ok=true'), 'Node 客户端对真实 Electron 远程路由的断言全绿')
  const state = remoteRouteProbeState
  lines.push(
    `本机 provider：总请求 ${state?.requests ?? 0}；测试消息请求 ${state?.targetRequests ?? 0}；目标流取消 ${state?.canceledTargetStreams ?? 0}`
  )
  say((state?.targetRequests ?? 0) === 1, '本机 provider 收到且只收到一次目标消息请求')
  say(
    (state?.canceledTargetStreams ?? 0) === 1 && (state?.completedTargetStreams ?? 0) === 0,
    '定向 abort 关闭了该目标消息对应的未完成 provider 流'
  )
  say((state?.invalidBodies ?? 0) === 0, '本机 provider 收到有效的 OpenAI 兼容请求体')
  return { ok, lines }
}

async function driveFilePreviewMutation({ caseCwd, delay }) {
  const file = join(caseCwd, 'README.md')
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay) + 5000))

  const original = readFileSync(file, 'utf8')
  const updated = `${original.trimEnd()}\nEXTERNAL_PROCESS_CHANGE_H4\n`
  writeFileSync(file, updated, 'utf8')
  const changedAt = new Date(Date.now() + 3000)
  utimesSync(file, changedAt, changedAt)

  return {
    ok: true,
    text: `✓ 独立 Node 测试进程改写 fixture README.md 并推进 mtime（${file}）`
  }
}

async function connectProbePage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
      const page = targets.find((t) => t.type === 'page' && /\/index\.html/.test(t.url ?? '') && !/auxwin|devtools:/.test(t.url ?? ''))
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolveOpen, rejectOpen) => {
          socket.addEventListener('open', resolveOpen, { once: true })
          socket.addEventListener('error', rejectOpen, { once: true })
        })
        let nextId = 0
        const pending = new Map()
        let closed = false
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data))
          const waiter = message.id ? pending.get(message.id) : null
          if (!waiter) return
          pending.delete(message.id)
          if (message.error) waiter.reject(new Error(message.error.message))
          else waiter.resolve(message.result)
        })
        socket.addEventListener('close', () => {
          closed = true
          for (const waiter of pending.values()) waiter.reject(new Error('CDP 连接已关闭'))
          pending.clear()
        })
        const send = (method, params = {}) =>
          new Promise((resolveSend, rejectSend) => {
            if (closed) return rejectSend(new Error('CDP 连接已关闭'))
            const id = ++nextId
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            socket.send(JSON.stringify({ id, method, params }))
          })
        const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value
        return { send, evaluate, isClosed: () => closed, close: () => socket.close() }
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function driveFollowupPointer() {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push(`  ${good ? '✓' : '✗'} ${text}`)
    if (!good) ok = false
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const cdp = await connectProbePage(FOLLOWUP_DEBUG_PORT, 60_000)
  say(!!cdp, `外部指针驱动连上主窗口 CDP（端口 ${FOLLOWUP_DEBUG_PORT}）`)
  if (!cdp) return { ok, text: lines.join('\n') }
  let scale = 1
  const mouse = (type, x, y, pressed = false) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: x * scale, y: y * scale, button: pressed || type !== 'mouseMoved' ? 'left' : 'none', buttons: pressed && type !== 'mouseReleased' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const calibrate = async () => {
    await cdp.evaluate(`window.__followupProbeX = null, window.addEventListener('pointermove', (e) => { window.__followupProbeX = e.clientX }, { capture: true, once: true })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 400, button: 'none', buttons: 0 })
    await pause(150)
    const seen = await cdp.evaluate('window.__followupProbeX')
    if (typeof seen === 'number' && seen > 0) scale = 400 / seen
  }
  const handled = new Set()
  const deadline = Date.now() + 150_000
  try {
    while (Date.now() < deadline && !cdp.isClosed()) {
      const stage = await cdp.evaluate('window.__followupDriver = true, window.__followupStage ?? null')
      if (!stage || handled.has(stage)) {
        await pause(100)
        continue
      }
      handled.add(stage)
      if (stage === 'sidebar-drag') {
        const box = await cdp.evaluate(`(() => {
          const r = document.querySelector('[data-testid="v3-sidebar-resizer"]')?.getBoundingClientRect()
          const w = document.querySelector('[data-testid="v3-sidebar"]')?.getBoundingClientRect().width
          return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w } : null
        })()`)
        if (box) {
          await calibrate()
          await mouse('mouseMoved', box.x, box.y)
          await mouse('mousePressed', box.x, box.y, true)
          for (let dx = 10; dx <= 80; dx += 10) {
            await mouse('mouseMoved', box.x + dx, box.y, true)
            await pause(16)
          }
          await mouse('mouseReleased', box.x + 80, box.y, true)
          await pause(400)
          const after = await cdp.evaluate(`(window.__followupSidebarDrag = document.querySelector('[data-testid="v3-sidebar"]').getBoundingClientRect().width > ${box.w} + 20, document.querySelector('[data-testid="v3-sidebar"]').getBoundingClientRect().width)`)
          lines.push(`  · 外部指针拖动会话列表：${Math.round(box.w)}px → ${Math.round(after ?? 0)}px`)
        } else {
          lines.push('  · 外部指针拖动：没找到会话列表拖拽条')
        }
      } else if (stage === 'sidebar-hover') {
        const y = await cdp.evaluate('Math.round(innerHeight / 2)')
        await mouse('mouseMoved', 300, y)
        await pause(50)
        await mouse('mouseMoved', 4, y)
        await pause(700)
      } else if (stage === 'sidebar-leave') {
        const size = await cdp.evaluate('({ w: innerWidth, h: innerHeight })')
        await mouse('mouseMoved', size.w - 240, Math.round(size.h / 2))
        await pause(60)
        await mouse('mouseMoved', size.w - 200, Math.round(size.h / 2) + 10)
        await pause(1000)
      } else if (stage === 'narrow') {
        const height = await cdp.evaluate('innerHeight')
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height, deviceScaleFactor: 0, mobile: false })
        await pause(600)
      } else if (stage === 'done') {
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      }
      await cdp.evaluate(`window.__followupDone = ${JSON.stringify(stage)}`)
      if (stage === 'done') break
    }
    say(handled.has('done'), '外部指针驱动走完所有阶段')
  } catch (error) {
    if (!handled.has('done')) say(false, `外部指针驱动异常：${error?.message ?? error}`)
  } finally {
    cdp.close()
  }
  return { ok, text: lines.join('\n') }
}

async function driveRemoteRoutes() {
  const lines = []
  let ok = true
  const say = (good, text) => {
    lines.push((good ? '✓ ' : '✗ ') + text)
    if (!good) ok = false
  }
  const origin = `http://127.0.0.1:${REMOTE_ROUTE_API_PORT}/remote/v1`
  const token = REMOTE_ROUTE_TOKEN
  const request = async (path, { auth = true, method = 'GET', body, timeoutMs = 2500 } = {}) => {
    const headers = {}
    if (auth) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    let json = null
    try {
      json = await response.json()
    } catch {
    }
    return { status: response.status, json }
  }
  const untilStatus = async (predicate, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    let latest = null
    while (Date.now() < deadline) {
      try {
        latest = await request('/status')
      } catch (error) {
        latest = { status: 0, error }
      }
      if (latest.status === 200 && predicate(latest.json?.data)) return latest.json.data
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return latest?.json?.data ?? null
  }

  try {
    const healthDeadline = Date.now() + 20000
    let health = null
    while (Date.now() < healthDeadline) {
      try {
        health = await request('/health', { auth: false, timeoutMs: 800 })
        if (health.status === 200) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    say(health?.status === 200 && health.json?.ok === true, `真实 Electron 远程 health 路由返回 ${health?.status ?? '无响应'}`)

    const denied = await request('/status', { auth: false })
    say(denied.status === 401, `无 token 的受保护路由返回 401（实际 ${denied.status}）`)

    const before = await request('/status')
    const activeBefore = before.json?.data?.agent?.activeSessionId
    const targetSessionId = before.json?.data?.sessions?.find((session) => session.id === 'yan-remote-route-target')?.id
    say(before.status === 200 && typeof activeBefore === 'string', '带 token 的状态路由给出桌面当前会话 id')
    say(typeof targetSessionId === 'string' && targetSessionId !== activeBefore, '隔离沙箱中存在独立的后台目标会话')
    if (!targetSessionId) throw new Error('状态快照中找不到合成目标会话')

    const created = await request('/sessions/new', { method: 'POST', body: {} })
    const selectedSessionId = created.json?.data?.sessionId
    say(created.status === 200 && typeof selectedSessionId === 'string', '新建会话路由返回稳定 sessionId')
    if (!selectedSessionId) throw new Error('新建会话路由没有返回 sessionId')
    const active = await untilStatus((data) => data?.agent?.activeSessionId === selectedSessionId)
    say(active?.agent?.activeSessionId === selectedSessionId, '新建会话成为桌面当前视图')
    say(active?.sessions?.some((session) => session.id === targetSessionId), '原目标会话仍在会话列表中')

    const sendRequest = request(`/sessions/${encodeURIComponent(targetSessionId)}/messages`, {
      method: 'POST',
      body: { text: 'Reply briefly. This is an isolated local route test; do not use tools.' },
      timeoutMs: 60000
    }).catch((error) => ({ status: 0, error }))
    const running = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.sessionId === targetSessionId && runner.running)
    )
    const targetRunner = running?.agent?.runners?.find(
      (runner) => runner.sessionId === targetSessionId && runner.running
    )
    const runId = targetRunner?.runId
    say(/^r[1-9]\d{0,8}$/.test(runId ?? ''), `目标 runner 运行中并公开精确 runId（${runId ?? '缺失'}）`)
    if (!runId) throw new Error('目标后台 runner 未进入运行态')
    say(targetRunner.isActive === false, '目标会话由后台 runner 执行，未切换桌面视图')
    say(running?.agent?.activeSessionId === selectedSessionId, '发送期间桌面当前会话未变化')

    await new Promise((resolve) => setTimeout(resolve, 500))
    const aborted = await request('/runs/abort', { method: 'POST', body: { runId } })
    say(aborted.status === 200 && aborted.json?.data?.runId === runId, `按精确 runId 中止成功（HTTP ${aborted.status}）`)

    const sent = await Promise.race([
      sendRequest,
      new Promise((resolve) => setTimeout(() => resolve({ status: 0, error: 'timeout waiting for send route response' }), 8000))
    ])
    say(
      sent.status === 200 && sent.json?.data?.sessionId === targetSessionId && sent.json?.data?.runId === runId,
      `消息路由最终回报了匹配的 sessionId / runId（HTTP ${sent.status}）`
    )

    const settled = await untilStatus((data) =>
      data?.agent?.runners?.some((runner) => runner.runId === runId && !runner.running)
    )
    const finalTarget = settled?.agent?.runners?.find((runner) => runner.runId === runId)
    say(finalTarget?.sessionId === targetSessionId && finalTarget.running === false, '中止后精确目标 runner 已停止')
    say(settled?.agent?.activeSessionId === selectedSessionId, '中止目标任务后桌面当前会话未改变')
  } catch (error) {
    say(false, `远程路由驱动异常：${error instanceof Error ? error.message : String(error)}`)
  }

  lines.push(`remote-routes.driver.ok=${ok}`)
  return { ok, text: lines.join('\n') }
}

function startBoundaryServer() {
  const handleRequest = (req, res) => {
    const url = new URL(req.url ?? '/', BOUNDARY_ORIGIN)
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="yan-probe-download.txt"'
      })
      res.end(`download fixture ${BOUNDARY_SECRET}\n`)
      return
    }
    if (url.pathname === '/whoami') {
      const cookie = /(?:^|;\s*)yan_probe_cookie=([^;]*)/.exec(req.headers.cookie ?? '')
      const value = cookie?.[1] ?? ''
      const hash = value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : 'none'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`cookie=${value ? 'present' : 'none'} hash=${hash}\n`)
      return
    }
    if (url.pathname === '/private') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('private-ok\n')
      return
    }
    if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>popup-opener</title><body>opener' +
          '<script>window.open("/private","_blank")</script></body>'
      )
      return
    }
    if (url.pathname === '/browser-fixture') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>browser-frame-fixture</title>' +
          '<body><h1>frame fixture</h1><output id="result">waiting</output>' +
          `<iframe title="same-origin frame" src="${BOUNDARY_ORIGIN}/browser-fixture-inner"></iframe>` +
          `<iframe title="cross-origin frame" src="http://localhost:${BOUNDARY_PORT}/browser-fixture-cross?private=fixture-secret"></iframe>` +
          '<script>addEventListener("message",e=>{if(e.data==="YAN_FRAME_SUBMITTED"){document.querySelector("#result").textContent="frame submitted";fetch("/browser-fixture-network?private=fixture-secret")}else if(String(e.data).startsWith("YAN_TYPED:")){document.querySelector("#result").textContent=String(e.data)}})</script></body>'
      )
      return
    }
    if (url.pathname === '/browser-fixture-inner') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><label>same choice<select aria-label="same-choice" name="same-choice"><option value="a">A</option><option value="b">B</option></select></label>')
      return
    }
    if (url.pathname === '/browser-fixture-cross') {
      process.stdout.write('[browser fixture] cross-origin iframe request received\n')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>cross-frame-form</title>' +
          '<label>cross input<input aria-label="cross-input" oninput="parent.postMessage(\'YAN_TYPED:\'+this.value, \'*\')"></label>' +
          '<label>cross choice<select aria-label="cross-choice" name="cross-choice"><option value="a">A</option><option value="b">B</option></select></label>' +
          '<button id="continue" onclick="parent.postMessage(\'YAN_FRAME_SUBMITTED\', \'*\')">Continue frame</button>'
      )
      return
    }
    if (url.pathname === '/browser-fixture-network') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('frame-network-ok')
      return
    }
    if (url.pathname === '/ask') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ask</title><body>ask' +
          '<script>' +
          'try{navigator.geolocation.getCurrentPosition(function(){},function(){})}catch(e){}' +
          'try{if(window.Notification)Notification.requestPermission()}catch(e){}' +
          '</script></body>'
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `yan_probe_cookie=${BOUNDARY_SECRET}; Path=/; SameSite=Lax`
    })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>yan boundary fixture</title>' +
        '<a id="dl" href="/download">download</a>'
    )
  }
  const servers = [createServer(handleRequest), createServer(handleRequest)]
  return new Promise((resolvePromise, rejectPromise) => {
    let ready = 0
    let settled = false
    const onListening = () => {
      ready++
      if (ready === servers.length && !settled) {
        settled = true
        resolvePromise({ close: () => servers.forEach((server) => server.close()) })
      }
    }
    for (const server of servers) server.once('error', (error) => {
      if (settled) return
      settled = true
      for (const active of servers) if (active.listening) active.close()
      rejectPromise(error)
    })
    servers[0].listen(BOUNDARY_PORT, '127.0.0.1', onListening)
    servers[1].listen(BOUNDARY_PORT, '::1', onListening)
  })
}

function checkBrowserBoundaryDownloads(sandboxRoot) {
  const lines = []
  if (!sandboxRoot) return { ok: false, lines: ['✗ 非隔离模式无法检查下载目录'] }
  const dir = join(sandboxRoot, 'downloads')
  const names = existsSync(dir) ? readdirSync(dir) : []
  lines.push(`  下载目录（隔离）：${names.length ? names.join(', ') : '（空）'}`)
  const file = names.find((n) => n === 'yan-probe-download.txt')
  let ok = Boolean(file)
  if (!file) {
    lines.push('  ✗ 没有找到 yan-probe-download.txt')
  } else {
    const size = statSync(join(dir, file)).size
    lines.push(`  ✓ yan-probe-download.txt 已落盘，${size} 字节`)
    ok = size > 0
    if (!ok) lines.push('  ✗ 文件是空的')
  }
  return { ok, lines }
}

let activeChild = null

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
    }
  }
  try {
    child.kill()
  } catch {
  }
}

function forceKillTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTree(activeChild)
    process.exit(130)
  })
}

function findIntermediateTurnTiming(dir) {
  if (!dir || !existsSync(dir)) return null
  let latest = null
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record?.final === false && Array.isArray(record.sourceIds) && record.sourceIds.length > 0) {
          if (!latest || Number(record.endedAt) > Number(latest.record.endedAt)) latest = { file, record }
        }
      } catch {
      }
    }
  }
  return latest
}

function runProbe(
  { probe, delay, keys, keysDelay, env: caseEnv, budget, visible, driver, hardKillAfterIntermediateTiming, args: caseArgs },
  env,
  driverContext
) {
  return new Promise((resolvePromise) => {
    const probeDelay = scaledDelay(delay)
    const probeKeysDelay = scaledDelay(keysDelay)
    let probeEnv = {
      ...env,
      ...(caseEnv ?? {}),
      YAN_PROBE: probe,
      YAN_PROBE_DELAY: String(probeDelay),
      ...(process.env.YAN_SHOW_WINDOW || visible ? {} : { YAN_PROBE_HIDDEN: '1' }),
      ...(process.env.YAN_PROBE_SHOT
        ? {
            YAN_PROBE_SHOT: process.env.YAN_PROBE_SHOT,
            ...(process.env.YAN_PROBE_SHOT_DELAY ? { YAN_PROBE_SHOT_DELAY: process.env.YAN_PROBE_SHOT_DELAY } : {})
          }
        : {}),
      ...(keys ? { YAN_PROBE_KEYS: keys } : {}),
      ...(keys && probeKeysDelay ? { YAN_PROBE_KEYS_DELAY: String(probeKeysDelay) } : {})
    }
    if (SYNTHETIC_ONLY) probeEnv = syntheticEnvironment(probeEnv)
    for (const k of [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'YAN_CLI_URL',
      'YAN_CLI_TOKEN',
      'YAN_SESSION_ID',
      'YAN_PROJECT_ID'
    ]) {
      delete probeEnv[k]
    }
    const showWindow = Boolean(process.env.YAN_SHOW_WINDOW || visible)
    const electronArgs = ['.']
    if (process.env.YAN_TEST_DPR) electronArgs.push(`--force-device-scale-factor=${process.env.YAN_TEST_DPR}`)
    if (showWindow) electronArgs.push('--disable-features=CalculateNativeWinOcclusion')
    if (Array.isArray(caseArgs)) electronArgs.push(...caseArgs)
    const child = spawn(electronBin, electronArgs, {
      cwd: root,
      env: probeEnv,
      windowsHide: true,
      ...(hardKillAfterIntermediateTiming && process.platform !== 'win32' ? { detached: true } : {})
    })
    activeChild = child
    const driverPromise = driver
      ? Promise.resolve()
          .then(() => driver(driverContext))
          .catch((error) => ({ ok: false, text: `✗ 外部验收驱动异常：${error?.message ?? error}` }))
      : null

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })

    const keyCost = keys ? (probeKeysDelay ?? 0) + keys.split(',').length * 1500 : 0
    const killChild = () => killTree(child)
    const kill = setTimeout(killChild, probeDelay + keyCost + (budget ?? 90_000))
    let intermediateSnapshot = null
    const snapshotPoll = hardKillAfterIntermediateTiming
      ? setInterval(() => {
          if (intermediateSnapshot || child.exitCode !== null || child.signalCode !== null) return
          const candidate = findIntermediateTurnTiming(join(env.YAN_DATA_DIR ?? '', 'turn-timing'))
          if (candidate && handoffFailureState?.failureMode === 'turn-timing-kill' && handoffFailureState.followupHeld) {
            intermediateSnapshot = candidate
            forceKillTree(child)
          }
        }, 50)
      : null

    child.on('exit', async (code) => {
      clearTimeout(kill)
      if (snapshotPoll) clearInterval(snapshotPoll)
      if (activeChild === child) activeChild = null
      const driven = driverPromise ? await driverPromise : null

      if (hardKillAfterIntermediateTiming && intermediateSnapshot) {
        const record = intermediateSnapshot.record
        let afterExitRecords = []
        try {
          afterExitRecords = readFileSync(join(env.YAN_DATA_DIR, 'turn-timing', intermediateSnapshot.file), 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line)]
              } catch {
                return []
              }
            })
        } catch {
        }
        resolvePromise({
          ok: true,
          hardKilled: true,
          text: [
            buf,
            `  turn-timing.hardkill.processExitedAfterForce=true (code=${String(code)}, signal=${String(child.signalCode)})`,
            `  turn-timing.hardkill.snapshot=${JSON.stringify({ file: intermediateSnapshot.file, record })}`,
            `  turn-timing.hardkill.afterExitRecords=${JSON.stringify(afterExitRecords)}`,
            driven?.text
          ].filter(Boolean).join('\n') + '\n'
        })
        return
      }
      if (hardKillAfterIntermediateTiming) {
        resolvePromise({
          ok: false,
          text: `${buf}\n  turn-timing.hardkill.processExitedAfterForce=false (未在真实 final:false 快照落盘后强杀)\n`,
          hint: 'Electron 在确认强杀条件前退出或达到预算；本场景不接受 seed 代替真强杀。'
        })
        return
      }

      const m = /---PROBE-START---\r?\n([\s\S]*?)\r?\n---PROBE-END---/.exec(buf)
      if (!m) {
        const hadOutput = buf.trim().length > 0
        resolvePromise({
          ok: false,
          text: [buf.slice(-3000), driven?.text].filter(Boolean).join('\n'),
          hint: hadOutput
            ? '没抓到 PROBE 输出（但有其它输出）—— 应用可能启动失败，先跑 `npm run probe-pi`。'
            : `一句输出都没有 —— 进程在探针打印前就被结束了。先看场景预算够不够：delay ${probeDelay}ms + budget ${budget ?? 90_000}ms。机器忙时可以用 YAN_TEST_DELAY_SCALE=2 把固定等待拉长。`
        })
        return
      }

      const body = m[1]
      const combined = [body, driven?.text].filter(Boolean).join('\n')
      const crashed = /探针出错|探针异常|probe threw/i.test(combined)
      const bad = /✗/.test(combined) || crashed
      resolvePromise({
        ok: !bad && code === 0 && (driven?.ok ?? true),
        text: combined + '\n',
        hint: bad
          ? crashed && !/✗/.test(combined)
            ? '探针在断言前就抛错了（不算通过）'
            : '输出里有 ✗ 的行'
          : undefined
      })
    })
  })
}


async function main() {

  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  let names = argv.length ? argv : defaultLiveCases(CASES)
  const skippedDownloads = names.filter((n) => CASES[n]?.needsDownload && process.env.YAN_REAL_GIT_DOWNLOAD !== '1')
  if (skippedDownloads.length) {
    console.log(`跳过需要联网下载的场景：${skippedDownloads.join(', ')}（设置 YAN_REAL_GIT_DOWNLOAD=1 才会真的下载）`)
    names = names.filter((n) => !skippedDownloads.includes(n))
    if (!names.length) process.exit(0)
  }

  for (const n of names) {
    if (!CASES[n]) {
      console.error(`未知场景：${n}。可选：${Object.keys(CASES).join(' / ')}`)
      process.exit(2)
    }
  }

  for (const n of names) {
    try {
      readFileSync(join(root, CASES[n].probe), 'utf8')
    } catch {
      console.error(`场景 ${n} 的探针不存在：${CASES[n].probe} —— 场景表里的残留条目，请一并删除`)
      process.exit(2)
    }
  }

  console.log(`将运行：${names.join(', ')}`)
  console.log(`测试模型：${TEST_MODEL}（可用 YAN_TEST_MODEL 覆盖）`)
  const spends = names.filter((n) => CASES[n].cost > 0)
  if (spends.length) {
    for (const n of spends) {
      console.log(`⚠️  ${n} 会真的调用模型（花少量额度）→ ${modelForCase(CASES[n].model)}`)
    }
  }

  const ISOLATED = process.env.YAN_TEST_ISOLATED !== '0'
  if (SYNTHETIC_ONLY) validateSyntheticSelection(names, CASES, ISOLATED)
  const sandboxRoot = ISOLATED ? mkdtempSync(join(tmpdir(), 'yan-test-')) : null
  if ((names.includes('remoteroutes') || names.includes('turntimingkill')) && !sandboxRoot) {
    console.error('✗ remoteroutes / turntimingkill 必须运行在隔离 sandbox 中；拒绝触碰真实用户数据。')
    process.exit(2)
  }

  const fixtureBase = sandboxRoot ?? mkdtempSync(join(tmpdir(), 'yan-fixture-'))
  const fixtureProject = buildFixtureProject(fixtureBase)

  let boundaryServer = null
  if (names.some((n) => CASES[n].usesBoundaryServer)) {
    try {
      boundaryServer = await startBoundaryServer()
      console.log(`  本地 fixture 服务：${BOUNDARY_ORIGIN}（下载 / Cookie 哨兵 / 内网目标）`)
    } catch (error) {
      console.error(`✗ 端口 ${BOUNDARY_PORT} 起不了本地服务：${error?.message ?? error}`)
      console.error('  可能是另一个 test:live 正在跑，或者别的程序占着这个端口。探针把该端口写在源码里，所以不自动换端口；先关掉占用方再跑。')
      process.exit(2)
    }
  }
  if (names.includes('remoteroutes')) {
    const preferredPort = REMOTE_ROUTE_API_PORT
    try {
      await assertPortAvailable(preferredPort)
    } catch (error) {
      if (process.env.YAN_TEST_REMOTE_PORT) {
        console.error(`✗ 远程 API 测试端口 ${preferredPort} 不可用：${error?.message ?? error}`)
        console.error('  指定了 YAN_TEST_REMOTE_PORT，本场景不自动换端口。')
        process.exit(2)
      }
      const picked = await freeLocalPort().catch(() => null)
      if (!picked) {
        console.error(`✗ 远程 API 测试端口 ${preferredPort} 不可用：${error?.message ?? error}`)
        process.exit(2)
      }
      REMOTE_ROUTE_API_PORT = picked
      console.log(`  端口 ${preferredPort} 被占用（可能是另一个 test:live 在跑），远程 API 改用 ${picked}`)
    }
    console.log(`  远程 API 测试端口：${REMOTE_ROUTE_API_PORT}（仅 127.0.0.1）`)
  }
  let remoteRouteProvider = null
  let handoffFailureProvider = null

  if (sandboxRoot) {
    const cleanupSandbox = () => {
      try {
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(sandboxRoot, { recursive: true, force: true })
      } catch {
      }
    }
    process.once('exit', cleanupSandbox)
    process.once('SIGINT', () => {
      cleanupSandbox()
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      cleanupSandbox()
      process.exit(143)
    })
  } else {
    process.once('exit', () => {
      try {
        allowDirRead(join(fixtureProject, 'noperm'))
        rmSync(fixtureBase, { recursive: true, force: true })
      } catch {
      }
    })
  }

  let env = { ...process.env }
  if (sandboxRoot) {
    const userData = join(sandboxRoot, 'userData')
    const sessions = join(sandboxRoot, 'sessions')
    const data = join(sandboxRoot, 'data')
    const piDir = join(sandboxRoot, 'pi-agent')
    for (const d of [userData, sessions, data, piDir]) mkdirSync(d, { recursive: true })

    const sourceAgentDir = SYNTHETIC_ONLY ? join(sandboxRoot, 'synthetic-source') : process.env.YAN_PI_DIR?.trim() || join(homedir(), '.pi', 'agent')
    if (SYNTHETIC_ONLY) {
      mkdirSync(sourceAgentDir, { recursive: true })
      writeFileSync(join(sourceAgentDir, 'auth.json'), '{}', 'utf8')
      writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ packages: [], enableMcp: false }), 'utf8')
    }
    const copied = []
    const routeOnly = names.length === 1 && names[0] === 'remoteroutes'
    if (!routeOnly) {
      for (const f of ['auth.json', 'models.json', 'models-store.json']) {
        const src = join(sourceAgentDir, f)
        if (existsSync(src)) {
          copyFileSync(src, join(piDir, f))
          copied.push(f)
        }
      }
    }
    if (copied.length) {
      console.log(SYNTHETIC_ONLY ? '  pi 文件：仅使用临时空凭证，不读取个人模型目录' : `  pi 文件：已复制 ${copied.join(' / ')} 到隔离目录（仅本次测试，不进包）`)
    } else if (routeOnly) {      console.log('  pi 文件：远程路由场景使用独立本机 provider，不读取真实 auth.json / models.json')
    } else {
      console.log('  pi 文件：没找到凭证/模型目录 —— 依赖 pi 就绪的场景会失败')
    }

    const maxTokensCap = Number(
      names.map((n) => CASES[n].env?.YAN_TEST_MODEL_MAX_TOKENS).find((v) => v) ?? 0
    )
    if (Number.isFinite(maxTokensCap) && maxTokensCap > 0) {
      const modelsFile = join(piDir, 'models.json')
      try {
        const doc = JSON.parse(readFileSync(modelsFile, 'utf8'))
        let touched = 0
        for (const prov of Object.values(doc.providers ?? {})) {
          for (const model of prov?.models ?? []) {
            if (typeof model.maxTokens === 'number' && model.maxTokens > maxTokensCap) {
              model.maxTokens = maxTokensCap
              touched += 1
            }
          }
        }
        if (touched) {
          writeFileSync(modelsFile, JSON.stringify(doc, null, 2), 'utf8')
          console.log(`  测试前提修正：${touched} 个模型的 maxTokens 压到 ${maxTokensCap}（仅隔离副本）`)
        }
      } catch (err) {
        console.error(`  ⚠️  maxTokens 修正失败（继续跑原始前提）：${err?.message ?? err}`)
      }
    }

    writeFileSync(
      join(data, 'desktop.json'),
      JSON.stringify({ cwd: root, lang: 'zh-CN' }, null, 2),
      'utf8'
    )

    env = {
      ...env,
      YAN_USER_DATA: userData,
      YAN_SESSIONS_DIR: sessions,
      YAN_DATA_DIR: data,
      YAN_PI_DIR: piDir,
      YAN_TEST_SESSION_LIST_LIMIT: '500',
      YAN_DOWNLOADS_DIR: join(sandboxRoot, 'downloads')
    }
    mkdirSync(join(sandboxRoot, 'downloads'), { recursive: true })

    if (names.includes('remoteroutes')) {
      try {
        remoteRouteProvider = await startRemoteRouteProvider()
        const routePiDir = join(sandboxRoot ?? fixtureBase, 'pi-agent-remote-routes')
        mkdirSync(routePiDir, { recursive: true })
        writeFileSync(
          join(routePiDir, 'models.json'),
          JSON.stringify({
            providers: {
              yanrouteprobe: {
                name: 'Yan Remote Route Probe',
                baseUrl: `http://127.0.0.1:${remoteRouteProvider.port}/v1`,
                api: 'openai-completions',
                models: [{ id: 'route-probe', name: 'Route Probe', contextWindow: 32768, maxTokens: 256 }]
              }
            }
          }),
          'utf8'
        )
        writeFileSync(
          join(routePiDir, 'auth.json'),
          JSON.stringify({ yanrouteprobe: { type: 'api_key', key: 'local-route-fixture-only' } }),
          'utf8'
        )
        CASES.remoteroutes.model = 'yanrouteprobe/route-probe'
        CASES.remoteroutes.env = {
          YAN_PI_DIR: routePiDir,
          PI_OFFLINE: '1',
          YAN_REMOTE_ENABLE: '1',
          YAN_REMOTE_HOST: '127.0.0.1',
          YAN_REMOTE_PORT: String(REMOTE_ROUTE_API_PORT),
          YAN_REMOTE_TOKEN: REMOTE_ROUTE_TOKEN
        }
        console.log(`  远程路由本机 provider：127.0.0.1:${remoteRouteProvider.port}（无上游转发）`)
      } catch (error) {
        console.error(`✗ 无法启动远程路由本机 provider：${error?.message ?? error}`)
        process.exit(2)
      }
    }

    const localProviderNames = localProviderCases(names, CASES)
    if (localProviderNames.length > 1) {
      console.error(`✗ 本机 provider fixture 场景请分开运行，避免共享请求统计混淆：${localProviderNames.join(', ')}`)
      process.exit(2)
    }
    if (localProviderNames.length === 1) {
      try {
        const fixtureName = localProviderNames[0]
        const isTurnTiming = fixtureName === 'turntimingisolation' || fixtureName === 'turntimingkill'
        const isSubagentLocal = fixtureName === 'subagentlocal'
        const failureMode = isSubagentLocal ? 'subagent-normal' : fixtureName === 'turntimingkill' ? 'turn-timing-kill' : 'turn-timing'
        const providerId = isTurnTiming ? 'yantimingfixture' : 'yansubagentfixture'
        const modelId = isTurnTiming ? 'turn-timing-isolation-fixture' : 'subagent-local-fixture'
        handoffFailureProvider = await startHandoffFailureProvider(failureMode)
        mkdirSync(piDir, { recursive: true })
        const modelsFile = join(piDir, 'models.json')
        let models = {}
        try {
          models = JSON.parse(readFileSync(modelsFile, 'utf8'))
        } catch {
          models = {}
        }
        models.providers = {
          ...(models.providers ?? {}),
          [providerId]: {
            name: isTurnTiming ? 'Yan Turn Timing Fixture' : 'Yan Subagent Local Fixture',
            baseUrl: `http://127.0.0.1:${handoffFailureProvider.port}/v1`,
            api: 'openai-completions',
            models: [
              {
                id: modelId,
                name: isTurnTiming ? 'Turn Timing Isolation Fixture' : 'Subagent Local Fixture',
                contextWindow: 32768,
                maxTokens: 4096
              }
            ]
          }
        }
        writeFileSync(modelsFile, JSON.stringify(models, null, 2), 'utf8')
        const authFile = join(piDir, 'auth.json')
        let auth = {}
        try {
          auth = JSON.parse(readFileSync(authFile, 'utf8'))
        } catch {
          auth = {}
        }
        auth[providerId] = {
          type: 'api_key',
          key: isTurnTiming ? 'local-turn-timing-fixture' : 'local-subagent-fixture'
        }
        writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf8')
        CASES[fixtureName].model = `${providerId}/${modelId}`
        CASES[fixtureName].env = {
          ...(CASES[fixtureName].env ?? {}),
          PI_OFFLINE: '1'
        }
        console.log(`  本机 provider fixture：127.0.0.1:${handoffFailureProvider.port}（${failureMode}，不发往外部）`)
      } catch (error) {
        console.error(`✗ 无法启动交接故障本机 provider：${error?.message ?? error}`)
        process.exit(2)
      }
    }

    if (boundaryServer) {
      process.once('exit', () => boundaryServer.close())
    }

    const seeded = seedSessions(sessions)
    if (names.includes('v3-shell') && sandboxRoot && process.env.YAN_V3_USAGE_FIXTURE !== '0') {
      const v3Usage = writeV3UsageFixture(sandboxRoot)
      CASES['v3-shell'].env = { ...(CASES['v3-shell'].env ?? {}), YAN_SESSIONS_DIR: v3Usage.usageSessions }
      console.log(
        `  v3-shell 用量夹具：主会话 ${v3Usage.mainTokens} token / ${v3Usage.mainMessages} 消息（15 天前）+ 子代理 ${v3Usage.subTokens} token（今天，仅隔离 sandbox）`
      )
    }
    if (names.includes('remoteroutes')) {
      const routeSession = writeRemoteRouteSession(sessions, fixtureProject)
      console.log(`  远程路由目标会话：${routeSession.id}（仅隔离 sandbox）`)
    }

    if (names.some((n) => CASES[n]?.abSessions)) {
      const made = writeAbSessions(sessions, join(fixtureProject, 'repo'), join(fixtureProject, 'other'))
      console.log(`  N12 A/B 会话：${made.map((m) => m.tag + '→' + m.cwd).join('，')}`)
    }

    if (names.some((n) => CASES[n]?.projectSessions || CASES[n]?.projectPeers)) {
      const made = writeProjectSwitchSessions(sessions, fixtureProject, join(fixtureProject, 'other'), {
        peers: names.some((n) => CASES[n]?.projectPeers),
        peerCwd: join(fixtureProject, 'repo'),
        opened: names.some((n) => CASES[n]?.openedSessions)
      })
      console.log(`  N05 项目会话：${made.map((m) => m.tag.toUpperCase() + '→' + m.cwd).join('，')}`)
    }

    const piDirCapability = join(sandboxRoot, 'pi-agent-capability')
    for (const d of [piDirCapability, join(piDirCapability, 'skills', 'yan-capability-probe')])
      mkdirSync(d, { recursive: true })
    for (const f of ['auth.json', 'models.json', 'models-store.json']) {
      const src = join(sourceAgentDir, f)
      if (existsSync(src)) copyFileSync(src, join(piDirCapability, f))
    }
    writeFileSync(
      join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md'),
      [
        '---',
        'name: yan-capability-probe',
        'description: 能力探测回执技能。用户要求「验证能力发现 / 按技能产出回执」时使用，会生成一份回执文件。',
        '---',
        '',
        '# 能力探测回执技能',
        '',
        '照下面步骤做，不要跳步：',
        '',
        '1. 在系统的临时目录里创建文件 `yan-capability-probe.txt`（`/tmp` 或 `$TEMP` 都可以），内容**恰好**是这一行：',
        '   `YAN-CAPABILITY-PROBE-OK 7f3a91`',
        '2. 用 bash 把该文件读回来，确认内容一致。',
        '3. 在最终回复里原样包含这一行标记。',
        '',
        '这行标记只出现在本技能正文里；没读到本技能就写不出它。'
      ].join('\n'),
      'utf8'
    )
    CASES.capsearch.env = {
      YAN_PI_DIR: piDirCapability,
      YAN_PROBE_SKILL: join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md')
    }
    CASES.capcli.env = {
      YAN_PI_DIR: piDirCapability,
      YAN_PROBE_SKILL: join(piDirCapability, 'skills', 'yan-capability-probe', 'SKILL.md')
    }

    const mcpServersFile = join(sandboxRoot, 'mcp-servers.json')
    writeFileSync(
      mcpServersFile,
      JSON.stringify(
        {
          servers: [
            {
              id: 'fixture',
              title: 'MCP 单测夹具服务',
              transport: 'stdio',
              command: process.execPath,
              args: [join(process.cwd(), 'scripts', 'lib', 'mcp-stdio-fixture.mjs')],
              env: { YAN_MCP_FIXTURE_MARKER: join(sandboxRoot, 'mcp-probe-marker.txt') }
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )
    CASES.mcpcli.env = { YAN_MCP_SERVERS_FILE: mcpServersFile }

    if (names.some((n) => CASES[n].usesMcpRegisterFixture)) {
      const mcpRegFixturePort = await freeLocalPort()
      const mcpRegCatalogPort = await freeLocalPort()
      const mcpRegCatalogOrigin = `http://127.0.0.1:${mcpRegCatalogPort}`
      const mcpRegCatalog = createServer((req, res) => {
        const url = new URL(req.url ?? '/', mcpRegCatalogOrigin)
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (url.pathname.startsWith('/npm')) {
          res.end(JSON.stringify({ objects: [] }))
          return
        }
        res.end(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'yan/fixture-remote',
                  title: '砚远程登记夹具服务',
                  description: '仅用于验证「目录候选 → 授权 → 端点核验 → 登记 → 可用」闭环的远程 MCP 服务。',
                  version: '1.0.0',
                  remotes: [{ type: 'streamable-http', url: `http://127.0.0.1:${mcpRegFixturePort}/mcp` }]
                }
              }
            ]
          })
        )
      })
      const mcpRegHttpFixture = spawn(process.execPath, [join(root, 'scripts', 'lib', 'mcp-http-fixture.mjs')], {
        env: { ...process.env, YAN_MCP_HTTP_PORT: String(mcpRegFixturePort) },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      try {
        await new Promise((resolvePromise, rejectPromise) => {
          mcpRegCatalog.once('error', rejectPromise)
          mcpRegCatalog.listen(mcpRegCatalogPort, '127.0.0.1', resolvePromise)
        })
        await new Promise((resolvePromise, rejectPromise) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            rejectPromise(new Error('MCP HTTP fixture 10s 内没起来'))
          }, 10_000)
          mcpRegHttpFixture.stderr.on('data', (chunk) => {
            if (settled) return
            if (String(chunk).includes('listening')) {
              settled = true
              clearTimeout(timer)
              resolvePromise()
            }
          })
          mcpRegHttpFixture.once('exit', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            rejectPromise(new Error(`MCP HTTP fixture 提前退出（code=${code}）`))
          })
        })
      } catch (error) {
        console.error(`✗ mcpregister 的本地 fixture 起不了：${error?.message ?? error}`)
        process.exit(2)
      }
      console.log(`  本地 fixture 服务：目录 ${mcpRegCatalogOrigin} + MCP HTTP 127.0.0.1:${mcpRegFixturePort}/mcp`)
      CASES.mcpregister.env = {
        YAN_MCP_REGISTRY_URL: `${mcpRegCatalogOrigin}/v0/servers`,
        YAN_NPM_SEARCH_URL: `${mcpRegCatalogOrigin}/npm`,
        YAN_MCP_SERVERS_FILE: join(sandboxRoot, 'mcp-servers-register.json')
      }
      process.on('exit', () => {
        try {
          mcpRegCatalog.close()
        } catch {
        }
        try {
          mcpRegHttpFixture.kill()
        } catch {
        }
      })
    }

    CASES.capmcp.env = {
      YAN_MCP_SERVERS_FILE: mcpServersFile,
      YAN_MCP_FIXTURE_MARKER: join(sandboxRoot, 'mcp-probe-marker.txt')
    }

    console.log(`隔离目录：${sandboxRoot}`)
    console.log(`  fixture：${seeded} 份（${SYNTHETIC_ONLY ? '仅合成，无个人凭证/会话' : '真实会话只读拷贝 + 合成；原件不受影响'}）`)
    console.log('  （不碰真实的会话、派生状态与 localStorage）')
    console.log('  （也不碰真实的 ~/.pi/agent/auth.json —— 里面是用户的密钥）')
  } else {
    console.log('⚠️  YAN_TEST_ISOLATED=0 —— 直接改真实数据，仅用于排查问题')
  }

  let failed = 0

  const SCENARIO_SEED = '.seed'
  const SCENARIO_SEED_SKIP = new Set([SCENARIO_SEED, 'fixture-project'])
  const scenarioSeedRoot = sandboxRoot ? join(sandboxRoot, SCENARIO_SEED) : null
  if (sandboxRoot) {
    mkdirSync(scenarioSeedRoot, { recursive: true })
    for (const entry of readdirSync(sandboxRoot)) {
      if (SCENARIO_SEED_SKIP.has(entry)) continue
      cpSync(join(sandboxRoot, entry), join(scenarioSeedRoot, entry), { recursive: true })
    }
  }
  const restoreScenarioState = () => {
    if (!scenarioSeedRoot) return
    for (const entry of readdirSync(sandboxRoot)) {
      if (SCENARIO_SEED_SKIP.has(entry)) continue
      rmSync(join(sandboxRoot, entry), { recursive: true, force: true })
    }
    for (const entry of readdirSync(scenarioSeedRoot)) {
      cpSync(join(scenarioSeedRoot, entry), join(sandboxRoot, entry), { recursive: true })
    }
  }

  for (const name of names) {
    const c = { ...CASES[name] }
    console.log(`\n${'='.repeat(64)}\n▶ ${name}  (${c.probe})\n${'='.repeat(64)}`)
    restoreScenarioState()

    const wins = c.wins ?? [null]
    let allOk = true
    let hint
    let lastProbeText = ''
    const caseCwd = c.fixture ? (c.fixtureSub ? join(fixtureProject, c.fixtureSub) : fixtureProject) : root
    if (c.bigFileFixture && fixtureProject) {
      mkdirSync(join(fixtureProject, 'bigdata', 'Paks'), { recursive: true })
      writeFileSync(join(fixtureProject, 'bigdata', 'Paks', 'game.pak'), Buffer.alloc(21 * 1024 * 1024, 7))
      mkdirSync(join(fixtureProject, 'smalldata'), { recursive: true })
      writeFileSync(join(fixtureProject, 'smalldata', 'notes.txt'), 'small\n', 'utf8')
    }

    const piSettingsFile = sandboxRoot ? join(sandboxRoot, 'pi-agent', 'settings.json') : null
    if (piSettingsFile) {
      rmSync(piSettingsFile, { force: true })
      const settings = { defaultThinkingLevel: 'off', ...(c.piSettings ?? {}) }
      writeFileSync(piSettingsFile, JSON.stringify(settings, null, 2), 'utf8')
    } else if (c.piSettings) {
      console.log('  ⤺ 跳过：非隔离模式（YAN_TEST_ISOLATED=0）不会写真实 pi 目录的 settings.json')
      continue
    }
    const tempBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('yan-subagent-')))


    taskFixtureBaseline = null
    if (c.readonlySession && sandboxRoot) {
      taskFixtureBaseline = captureSessionFile(join(sandboxRoot, 'sessions'), c.readonlySession)
      console.log(
        taskFixtureBaseline
          ? `  只读基线：${basename(taskFixtureBaseline.path)}（${Buffer.byteLength(taskFixtureBaseline.text)} 字节）`
          : `  ⚠️  找不到只读基线会话：${c.readonlySession}`
      )
    }

    if (c.probePrefix) {
      if (!sandboxRoot) throw new Error('Prefixed probes require an isolated data directory')
      const wrapped = join(sandboxRoot, `probe-${name}.js`)
      writeFileSync(wrapped, c.probePrefix + readFileSync(join(root, c.probe), 'utf8'))
      c.probe = relative(root, wrapped)
    }
    const syntaxErr = checkProbeSyntax(c.probe)
    if (syntaxErr) {
      console.log(`  ✗ 探针脚本语法错误：${syntaxErr}`)
      failed++
      console.log(`\n✗ ${name} 未通过`)
      continue
    }
    let contextGuardFixturePath = null

    for (const win of wins) {
      if (sandboxRoot) {
        const desktop = c.freshDesktop ? { lang: 'zh-CN' } : { cwd: caseCwd, lang: 'zh-CN' }
        if (process.env.YAN_TEST_DESKTOP_THEME === 'light' || process.env.YAN_TEST_DESKTOP_THEME === 'dark') {
          desktop.theme = process.env.YAN_TEST_DESKTOP_THEME
        }
        if (c.freeRemotePort) {
          desktop.remoteAccess = { enabled: false, bind: 'tailscale', port: await freeLocalPort() }
        }
        if (c.knowledgeSeed) {
          desktop.projects = [
            {
              id: KNOWLEDGE_FIXTURE_PROJECT_ID,
              cwd: caseCwd,
              name: 'Fixture',
              archived: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ]
        }
        writeFileSync(join(sandboxRoot, 'data', 'desktop.json'), JSON.stringify(desktop, null, 2), 'utf8')
        if (c.knowledgeSeed) {
          let fixtureSessionId
          try {
            const file = readdirSync(join(sandboxRoot, 'sessions'), { recursive: true })
              .map((name) => String(name))
              .find((name) => name.endsWith('.jsonl'))
            if (file) fixtureSessionId = basename(file).replace(/\.jsonl$/, '').split('_').slice(1).join('_')
          } catch {
          }
          await seedProjectKnowledge(join(sandboxRoot, 'data'), {
            withCandidate: c.knowledgeSeed === 'candidate',
            sessionId: c.knowledgeSeed === 'candidate' ? fixtureSessionId : undefined
          })
        }
        if (c.contextGuardSeed && !contextGuardFixturePath) {
          contextGuardFixturePath = writeContextGuardSession(join(sandboxRoot, 'sessions'))
          console.log(`  上下文守卫 fixture：${basename(contextGuardFixturePath)}（仅本场景）`)
        }
      }
      if (win) console.log(`\n─── 窗口 ${win} ───`)
      let brokenPiBin
      if (c.brokenPi && sandboxRoot) {
        brokenPiBin = join(sandboxRoot, 'broken-pi.js')
        writeFileSync(brokenPiBin, 'process.exit(3)\n', 'utf8')
      }
      const out = await runProbe(c, {
        ...env,
        ...(win ? { YAN_WIN: win } : {}),
        ...(c.env ?? {}),
        ...(brokenPiBin ? { YAN_PI_BIN: brokenPiBin } : {}),
        YAN_TEST_MODEL: modelForCase(c.model)
      }, { sandboxRoot, fixtureProject, caseCwd, delay: c.delay })
      if (contextGuardFixturePath) {
        rmSync(contextGuardFixturePath, { force: true })
        contextGuardFixturePath = null
      }
      if (name === 'remoteroutes' && remoteRouteProvider) {
        await closeRemoteRouteProvider(remoteRouteProvider)
        remoteRouteProvider = null
      }
      if (
        (name === 'turntimingisolation' || name === 'turntimingkill') &&
        handoffFailureProvider
      ) {
        handoffFailureState = handoffFailureProvider.state
        await closeHandoffFailureProvider(handoffFailureProvider)
        handoffFailureProvider = null
      }
      process.stdout.write(out.text)
      lastProbeText = out.text
      if (!out.ok) {
        allOk = false
        hint = hint ?? out.hint
      }
      if (c.usesBoundaryServer) {
        if (out.text.includes(BOUNDARY_SECRET)) {
          allOk = false
          console.log('  ✗ 输出里出现了 Cookie 值（哨兵）—— 凭证不得进日志/状态/结果')
        } else {
          console.log('  ✓ 输出里没有 Cookie 值（哨兵未泄漏）')
        }
        if (c.boundaryCookieCheck) {
          const expectedHash = createHash('sha256').update(BOUNDARY_SECRET).digest('hex').slice(0, 8)
          if (out.text.includes(`cookieHash=${expectedHash}`)) {
            console.log(`  ✓ 目标浏览器拿到的 Cookie 值与源值一致（sha256 前 8 位 ${expectedHash}）`)
          } else {
            allOk = false
            console.log(`  ✗ 目标浏览器里的 Cookie 值对不上（期待 cookieHash=${expectedHash}）`)
          }
        }
      }
    }

    if (allOk && c.restart) {
      if (c.seedBeforeRestart) {
        const seed = SEED_BEFORE_RESTART[c.seedBeforeRestart]
        console.log(
          seed
            ? `  重启前 seed：${seed(sandboxRoot) ?? 'ok'}`
            : `  ✗ 未注册的 seedBeforeRestart：${c.seedBeforeRestart}`
        )
        if (!seed) {
          allOk = false
          hint = hint ?? `未注册的 seedBeforeRestart：${c.seedBeforeRestart}`
        }
      }
      console.log(`\n─── 重启（第二次启动，同一份 YAN_DATA_DIR）───`)
      const out2 = await runProbe(
        { ...c.restart },
        { ...env, YAN_TEST_MODEL: modelForCase(c.restart.model ?? c.model) }
      )
      process.stdout.write(out2.text)
      lastProbeText = lastProbeText + out2.text
      if (!out2.ok) {
        allOk = false
        hint = hint ?? out2.hint
      }
    }

    if (c.afterExit && (allOk || c.afterExitOnFailure)) {
      const check = AFTER_EXIT[c.afterExit]
      if (!check) {
        console.log(`  ✗ 未注册的 afterExit 检查：${c.afterExit}`)
        allOk = false
        hint = hint ?? `未注册的 afterExit 检查：${c.afterExit}`
      } else {
        const res = await check(sandboxRoot, tempBefore, lastProbeText)
        console.log('\n退出后检查（Electron 已关闭）')
        console.log(res.lines.join('\n'))
        if (!res.ok) {
          allOk = false
          hint = hint ?? '退出后检查未通过'
        }
      }
    }

    if (!allOk) {
      failed++
      console.log(`\n✗ ${name} 未通过`)
      if (hint) console.log(`  提示：${hint}`)
      continue
    }

    console.log(`\n✓ ${name} 通过`)
  }

  if (sandboxRoot) {
    try {
      rmSync(sandboxRoot, { recursive: true, force: true })
    } catch {
    }
  } else {
    try {
      rmSync(fixtureBase, { recursive: true, force: true })
    } catch {
    }
  }

  console.log(`\n${'='.repeat(64)}`)
  const orphanPi = orphanPiProcesses()
  if (orphanPi === null) {
    console.log('\n孤儿进程：跳过检查（拿不到进程表，不把“查不到”当成“没残留”）')
  } else if (orphanPi.length === 0) {
    console.log('\n孤儿进程：✓ 没有残留的 pi 进程（命令行含 --mode rpc 且父进程已退出）')
  } else {
    failed++
    console.log(`\n孤儿进程：✗ 发现 ${orphanPi.length} 个残留的 pi 进程`)
    for (const row of orphanPi.slice(0, 6)) console.log(`    · ${row}`)
  }

  console.log(failed === 0 ? `全部通过（${names.length} 个场景）` : `${failed}/${names.length} 个场景失败`)
  process.exit(failed === 0 ? 0 : 1)


}

await main()
