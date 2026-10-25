import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-push-'))
const sessionsDir = join(root, 'sessions')
await mkdir(sessionsDir, { recursive: true })
const sessionFile = join(sessionsDir, 's-branch.jsonl')
const head = { type: 'session', id: 's-branch', cwd: 'C:\\Users\\someone\\private-project', timestamp: new Date(1_700_000_000_000).toISOString(), parentSession: 'C:\\Users\\someone\\sessions\\s-parent.jsonl' }
const messages = [
  { type: 'message', id: 'm1', message: { role: 'user', content: '第一句话' } },
  { type: 'message', id: 'm2', message: { role: 'assistant', content: '好的' } }
]
await writeFile(sessionFile, [head, ...messages].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')

process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_SESSIONS_DIR = sessionsDir
process.env.YAN_USER_DATA = join(root, 'electron')

const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: [
        'export const app = { getPath: () => process.env.YAN_USER_DATA, getName: () => "stub", getVersion: () => "0.0.0", whenReady: async () => undefined, on() {}, once() {}, quit() {}, isPackaged: false }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }',
        'export const BrowserWindow = class { static getAllWindows() { return [] } }',
        'export const Notification = class { static isSupported() { return false } show() {} on() {} }',
        'export const shell = { openExternal: async () => undefined, openPath: async () => undefined, showItemInFolder() {} }',
        'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
        'export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }',
        'export const clipboard = { readText: () => "", writeText() {} }',
        'export const Menu = { buildFromTemplate: (t) => t, setApplicationMenu() {}, getApplicationMenu: () => null }',
        'export const Tray = class { setToolTip() {} setContextMenu() {} on() {} destroy() {} }',
        'export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [], getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }) }',
        'export const session = { defaultSession: { setPermissionRequestHandler() {} } }',
        'export default {}'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

try {
  const outfile = join(root, 'remote-host.mjs')
  await build({ entryPoints: ['src/main/remote-host.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
  const host = await import(pathToFileURL(outfile).href)

  const runner = { id: 'run-1', runId: 'r1', sessionId: 's-branch', projectId: 'p1', generation: 1, cwd: 'C:\\Users\\someone\\private-project', running: true, waiting: false, failed: false, conn: 'connected', createdAt: 1, lastActiveAt: 2, isActive: true, sessionFile: 'C:\\Users\\someone\\sessions\\s-branch.jsonl' }
  const state = { sessionId: 's-branch', cwd: 'C:\\Users\\someone\\private-project', sessionFile: 'C:\\Users\\someone\\sessions\\s-branch.jsonl', thinkingLevel: 'off', availableThinkingLevels: ['off'], isStreaming: false, isCompacting: false, messageCount: 2, pendingMessageCount: 0 }

  host.configureRemoteHost({
    win: () => null,
    remoteAccess: () => null,
    runners: () => ({ agentOf: () => null, statuses: () => [runner] }),
    ac: () => null,
    readHistoryWithArtifacts: async () => ({
      messages: [{ id: 'm1', role: 'user', text: '第一句话' }],
      total: 1,
      truncated: 4096,
      bytes: 8192
    }),
    sessionChains: { load: async () => undefined, chains: () => [], representativeOf: () => null }
  })

  const projectedRunner = host.remotePushPayload('runners', [runner])
  assert.ok(Array.isArray(projectedRunner), 'runners 事件按数组投影')
  assert.equal(projectedRunner[0].cwd, undefined, 'runners 事件不带绝对 cwd')
  assert.equal(projectedRunner[0].sessionFile, undefined, 'runners 事件不带会话文件路径')
  assert.equal(projectedRunner[0].cwdName, 'private-project', 'runners 事件只留目录名')
  assert.equal(projectedRunner[0].runId, 'r1', 'runners 事件保留运行标识')

  const projectedState = host.remotePushPayload('state', state)
  assert.equal(projectedState.cwd, undefined, 'state 事件不带绝对 cwd')
  assert.equal(projectedState.sessionFile, undefined, 'state 事件不带会话文件路径')
  assert.equal(projectedState.cwdName, 'private-project', 'state 事件只留目录名')
  assert.equal(host.remotePushPayload('state', null), null, '清空会话时 state 投影为 null')

  assert.deepEqual(host.remotePushPayload('notify', { text: '随便一条通知' }), {}, '其它通道不转发正文')
  assert.deepEqual(
    host.remotePushPayload('tool', { sessionId: 's1', args: { command: 'cat secret' }, output: 'token=abc', cwd: 'C:\\Users\\someone' }),
    { sessionId: 's1' },
    'tool 事件只留会话 id，不带参数、输出与目录'
  )
  assert.deepEqual(host.remotePushPayload('approval', { sessionId: 's2', detail: 'rm -rf C:\\work' }), { sessionId: 's2' }, '审批事件不带 detail')

  const settled = host.remotePushPayload('turn-settled', { sessionId: 's-branch', outcome: 'failed', secret: 'C:\\Users\\someone' })
  assert.deepEqual(settled, { sessionId: 's-branch', outcome: 'failed' }, '回合终态只留会话 id 与结果')
  assert.equal(host.remotePushPayload('turn-settled', { outcome: 'unknown' }).outcome, 'completed', '无法识别的终态按完成处理')

  const modelError = host.remotePushPayload('agent-error', {
    message: '服务商拒绝了模型或请求配置',
    text: '400: invalid_request_error',
    source: 'stop-reason',
    traceId: 'should-drop'
  })
  assert.deepEqual(modelError, { message: '服务商拒绝了模型或请求配置', text: '400: invalid_request_error', source: 'stop-reason' }, '模型错误只留说明与原文')

  const summary = host.remoteSessionSummary({
    id: 's-branch',
    title: '分支会话',
    path: 'C:\\Users\\someone\\sessions\\s-branch.jsonl',
    cwd: 'C:\\Users\\someone\\private-project',
    parentSession: 'C:\\Users\\someone\\sessions\\s-parent.jsonl',
    branchOrigin: '用户提出的那句话'.repeat(40),
    projectCandidates: ['p1', 'p2'],
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2
  })
  assert.equal(summary.path, undefined, '会话摘要不带会话文件路径')
  assert.equal(summary.parentSession, undefined, '会话摘要不带父会话路径')
  assert.equal(summary.projectCandidates, undefined, '会话摘要不带项目候选 id 列表')
  assert.equal(summary.parentSessionId, 's-parent', '父子关系只留会话 id')
  assert.equal(summary.projectCandidateCount, 2, '项目候选只留数量')
  assert.ok(summary.branchOriginTitle.length <= 120, '分叉来源文案有长度上限')
  assert.equal(summary.cwdName, 'private-project', '会话摘要只留目录名')

  const cached = await Promise.all([host.remoteHistory('s-branch', 10), host.remoteHistory('s-branch', 10)])
  assert.equal(cached[0].ok, true, '远程历史能按稳定 id 读取')
  assert.equal(cached[0].data.truncated, true, '历史截断标记是布尔值')
  assert.equal(cached[0].data.truncatedBytes, 4096, '历史截断字节数单独给出')
  assert.equal(cached[1].data.truncated, true, '缓存命中的历史也返回布尔截断标记')

  const accessSource = readFileSync('src/main/remote-access.ts', 'utf8')
  assert.ok(/publish\(message: MainPush\)[\s\S]{0,200}remotePushPayload\(message\.ch/.test(accessSource), '远程广播前先投影载荷')
  assert.ok(/new RemotePushCoalescer\(\(message\) => this\.deliver\(message\)\)/.test(accessSource), '远程广播先过合并器')
  assert.ok(/\bdispose\(\)/.test(accessSource), '停止远程访问时丢弃未发出的快照')

  console.log('remote-push: 远程事件与摘要降敏、历史截断口径通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
