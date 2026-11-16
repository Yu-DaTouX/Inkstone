import './lib/test-isolate.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const shell = { openPath: async () => "" }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const BrowserWindow = class {}',
        'export const ipcMain = { handle: () => undefined }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({}) }',
        'export default {}'
      ].join('\n')
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const A = await compile('src/main/remote-activity.ts')
  const host = await compile('src/main/remote-host.ts', { plugins: [electronStub], external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] })
  const { RemoteServer } = await compile('src/main/remote-server.ts')

  const notice = A.remoteNoticeOf({ id: 'n1', method: 'notify', notifyType: 'warning', message: '读取 C:\\Users\\u\\secret.txt 失败' }, { sessionId: 's-1' })
  ok(notice.level === 'warning' && notice.sessionId === 's-1' && !notice.message.includes('C:\\Users'), '通知带级别与会话，本机路径遮掉', JSON.stringify(notice))
  ok(A.remoteNoticeOf({ id: 'x', message: 'y'.repeat(1000) }).message.length === 301, '通知文本截到 300 字')
  const switched = A.remoteNoticeOf({ id: 'n3', message: '已切到 bob@example.com，Bearer abcdefghijklmnop 失效' })
  ok(switched.message.includes('b***@example.com') && !switched.message.includes('abcdefghijklmnop'), '通知里的邮箱打码、凭据遮掉', switched.message)
  ok(A.remoteNoticeOf({ method: 'setStatus' }) === null, '没有文本的不当通知')
  const pushed = host.remotePushPayload('notify', { id: 'n2', notifyType: 'error', message: '额度用完，已换号继续', extra: { token: 'abc' } })
  ok(pushed.message === '额度用完，已换号继续' && pushed.level === 'error' && !('extra' in pushed), '推给手机的通知只带必要字段')
  ok(JSON.stringify(host.remotePushPayload('terminal-jobs', [{ command: 'secret', cwd: 'C:/x' }])) === '{}', '后台任务推送只当刷新信号，不带命令与目录')
  ok(host.remotePushPayload('workflow', { id: 'wf-1', sessionId: 's-1', cwd: 'C:/x', logs: ['a'] }).sessionId === 's-1' && !('cwd' in host.remotePushPayload('workflow', { sessionId: 's-1', cwd: 'C:/x' })), '工作流推送只带会话 id')

  const esc = String.fromCharCode(27)
  const tail = A.terminalOutputTail(`${esc}[32mok${esc}[0m\r\nline2\r\n\r\n\r\n\r\nend`)
  ok(tail.output === 'ok\nline2\n\nend' && tail.truncated === false, '终端输出去掉颜色码并整理换行', JSON.stringify(tail))
  const long = A.terminalOutputTail('a'.repeat(5000) + 'END')
  ok(long.truncated && long.output.endsWith('END') && long.output.length === 4000, '长输出只给最后 4000 字')
  const jobs = [
    { id: 'j1', terminalId: 't1', owners: ['s-1'], command: 'npm test', cwd: 'C:/p', startedAt: 1, endedAt: 5, exitCode: 0, state: 'completed' },
    { id: 'j2', terminalId: 't2', owners: ['C:\\Sessions\\S.jsonl'], command: 'npm run dev', cwd: 'C:/p', startedAt: 2, state: 'running' },
    { id: 'j3', terminalId: '', kind: 'bash', owners: ['s-1'], command: 'sleep 10', cwd: 'C:/p', startedAt: 3, state: 'running' },
    { id: 'j4', terminalId: 't4', owners: ['s-2'], command: 'other', cwd: 'C:/p', startedAt: 4, state: 'running' }
  ]
  const read = (id) => (id === 't1' ? 'done' : id === 't2' ? 'listening' : null)
  const listed = A.remoteJobsFor(['s-1', 'c:/sessions/s.jsonl'], jobs, read)
  ok(listed.map((job) => job.id).join() === 'j3,j2,j1', '只列本会话的任务，运行中的在前', listed.map((job) => job.id).join())
  ok(listed[1].output === 'listening' && listed[0].output === undefined && listed[2].output === 'done', '有终端的带输出尾部，后台 bash 不带')
  ok(!JSON.stringify(listed).includes('C:/p') && listed[0].live === true && listed[2].live === false, '不带工作目录，标明是否仍在运行')
  const secretJobs = A.remoteJobsFor(['s-1'], [{ id: 'j9', terminalId: 't9', owners: ['s-1'], command: 'API_KEY=sk-abcdefghijklmnop npm run dev --token hunter22', cwd: 'C:/p', startedAt: 9, state: 'running' }], () => 'Local: http://localhost:3000/?token=abc123secret\nkey sk-zyxwvutsrqponm\nlog at C:\\Users\\u\\app.log')
  ok(!/sk-abcdefghijklmnop|hunter22/.test(secretJobs[0].command), '命令里的密钥与令牌参数遮掉', secretJobs[0].command)
  ok(!/abc123secret|sk-zyxwvutsrqponm|C:\\Users/.test(secretJobs[0].output), '终端输出里的令牌、密钥形状与本机路径遮掉', secretJobs[0].output)

  const view = (over = {}) => ({ id: 'wf-0000000a', sessionId: 's-1', cwd: 'C:/p', name: '批量翻译', description: '把文档翻成英文', declaredPhases: [], status: 'running', startedAt: 10, attempt: 1, concurrency: 4, agents: [{ seq: 1, status: 'done' }, { seq: 2, status: 'running' }, { seq: 3, status: 'failed' }, { seq: 4, status: 'queued' }], logs: ['开始', '写入 C:\\Users\\u\\out.md'], dir: 'C:/p/.yan/wf', ...over })
  const shown = A.remoteWorkflowOf(view())
  ok(shown.progress.total === 4 && shown.progress.done === 1 && shown.progress.failed === 1 && shown.progress.running === 1, '没有模型统计时按步骤算进度')
  ok(shown.canPause && !shown.canResume && shown.canStop && !JSON.stringify(shown).includes('C:/p') && !shown.logs.join().includes('C:\\Users'), '运行中可暂停与停止，不带目录，日志遮掉路径')
  const withModels = A.remoteWorkflowOf(view({ models: { total: 10, done: 4, cached: 2, failed: 0, stopped: 0, running: 3, queued: 1, waitingQuota: true, cost: 0.5 } }))
  ok(withModels.progress.done === 6 && withModels.waitingQuota && withModels.cost === 0.5, '有模型统计时用统计（缓存算完成）')
  ok(A.remoteWorkflowsFor('s-1', [view(), view({ id: 'wf-0000000b', sessionId: 's-2' })]).length === 1, '只列本会话的工作流')

  const controls = []
  const control = async (id, action) => { controls.push([id, action]); return { ok: true } }
  const paused = await A.remoteWorkflowControl('s-1', 'wf-0000000a', 'pause', [view()], control)
  ok(paused.ok && controls.at(-1)[1] === 'pause', '运行中的工作流可暂停')
  const badResume = await A.remoteWorkflowControl('s-1', 'wf-0000000a', 'resume', [view()], control)
  ok(!badResume.ok && badResume.code === 'workflow_state' && controls.length === 1, '运行中不能继续')
  const foreign = await A.remoteWorkflowControl('s-2', 'wf-0000000a', 'stop', [view()], control)
  ok(!foreign.ok && foreign.status === 404 && controls.length === 1, '不能控制别的会话的工作流')
  const done = await A.remoteWorkflowControl('s-1', 'wf-0000000a', 'stop', [view({ status: 'done' })], control)
  ok(!done.ok && controls.length === 1, '已结束的不能停止')

  const quota = A.remoteQuotaOf({ checkedAt: 9, cards: [
    { key: 'claude:a', source: 'yan', provider: 'anthropic', name: 'Claude', email: 'alice@example.com', plan: 'Max', active: true, status: 'ok', checkedAt: 9, windows: [{ id: '5h', label: '5 小时', used: 40, total: 100, resetAt: 99 }, { id: 'info', label: '说明', used: 0, total: 0, informational: true }], resetCredits: { count: 2 } },
    { key: 'x', source: 'yan', provider: 'openai', name: 'OpenAI', label: '工作号', status: 'error', checkedAt: 9, windows: [], error: '读取 C:\\Users\\u\\auth.json 失败' }
  ] })
  ok(quota.cards[0].title === 'a***@example.com' && quota.cards[0].windows.length === 1 && !('resetCredits' in quota.cards[0]), '额度卡遮住邮箱，去掉说明类窗口与重置券', JSON.stringify(quota.cards[0]))
  ok(quota.cards[0].key === 'card-0' && quota.cards[1].key === 'card-1' && !JSON.stringify(quota).includes('claude:a'), '额度卡用不透明 id，不下发账号 key')
  let loads = 0
  let clock = 0
  const cached = A.createQuotaCache(async () => ++loads, 45_000, () => clock)
  await cached(); await cached(); clock = 30_000; await cached()
  ok(loads === 1, '45 秒内重复读取额度只算一次')
  clock = 46_000; await cached()
  ok(loads === 2, '过期后重新读取')
  let failing = 0
  const flaky = A.createQuotaCache(async () => { failing++; throw new Error('x') }, 45_000, () => 0)
  await flaky().catch(() => undefined); await flaky().catch(() => undefined)
  ok(failing === 2, '读取失败不缓存')
  ok(quota.cards[1].title === '工作号' && !quota.cards[1].error.includes('C:\\Users'), '错误里的本机路径遮掉')
  const usage = A.remoteUsageOf({ range: '7d', sessions: 3, messages: 40, tokens: 1000, tokenBreakdown: {}, cost: 1.2, costBreakdown: {}, activeDays: 2, peakHour: 10, models: Array.from({ length: 8 }, (_, i) => ({ key: `anthropic/claude-${i}`, tokens: 100 - i, cost: 0.1, sources: ['yan'] })), heat: [{ date: '2026-11-16', tokens: 1 }], at: 1 })
  ok(usage.models.length === 5 && usage.models[0].name === 'claude-0' && !('heat' in usage) && !('sources' in usage.models[0]), '用量只带汇总和前 5 个模型')

  const stopped = []
  const stopFn = (id) => { stopped.push(id); return true }
  const okStop = await A.remoteStopJob(['s-1'], 'j3', jobs, stopFn)
  ok(okStop.ok && stopped.join() === 'j3', '本会话运行中的后台任务可停止')
  const foreignStop = await A.remoteStopJob(['s-1'], 'j4', jobs, stopFn)
  ok(!foreignStop.ok && foreignStop.status === 404 && stopped.length === 1, '不能停别的会话的后台任务')
  const doneStop = await A.remoteStopJob(['s-1'], 'j1', jobs, stopFn)
  ok(!doneStop.ok && doneStop.status === 409 && doneStop.code === 'job_not_running' && stopped.length === 1, '已结束的任务不能停')
  ok((await A.remoteStopJob(['s-1'], 'j3', [{ ...jobs[2], state: 'stopping' }], stopFn)).status === 409, '正在停止的不重复发')

  const dir = await mkdtemp(join(tmpdir(), 'yan-remote-patch-'))
  try {
    const small = join(dir, 'small.patch')
    await writeFile(small, 'diff --git a/x b/x\n+新增\n')
    const head = await A.readTextHead(small)
    ok(head.text === 'diff --git a/x b/x\n+新增\n' && !head.truncated, '小补丁整份读出')
    const big = join(dir, 'big.patch')
    await writeFile(big, '+一二三四五\n'.repeat(100))
    const cut = await A.readTextHead(big, 50)
    ok(cut.truncated && cut.bytes > 50 && cut.text.endsWith('\n') && !cut.text.includes('\uFFFD'), '大补丁按字节截断，不留半个字也不留半行', JSON.stringify(cut.text))
    ok(await A.readTextHead(join(dir, 'none.patch')) === null, '文件不在时返回空')
    const runs = [
      { id: 'sub-a', parentSessionId: 's-1', diff: { files: 1, additions: 1, deletions: 0, patchPath: small } },
      { id: 'sub-b', parentSessionId: 's-1', diff: { files: 0, additions: 0, deletions: 0 } },
      { id: 'sub-c', parentSessionId: 's-1', diff: { files: 2, additions: 1, deletions: 1, patchPath: join(dir, 'gone.patch') } }
    ]
    const patched = await A.remoteSubagentPatch('s-1', 'sub-a', runs, (path) => A.readTextHead(path))
    ok(patched.ok && patched.data.patch.includes('+新增') && patched.data.files === 1 && !JSON.stringify(patched.data).includes(dir), '读出子代理补丁，不带本机路径')
    const secretKey = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'
    const leaky = await A.remoteSubagentPatch('s-1', 'sub-a', runs, async () => ({ text: `diff --git a/.env b/.env\n+ANTHROPIC_API_KEY=${secretKey}\n+PORT=3000\n`, truncated: false, bytes: 80 }))
    ok(leaky.ok && !leaky.data.patch.includes(secretKey) && leaky.data.patch.includes('+PORT=3000') && leaky.data.patch.split('\n').length === 4, '补丁正文里的密钥下发前遮蔽，其余行与行数不变', leaky.data?.patch)
    ok((await A.remoteSubagentPatch('s-2', 'sub-a', runs, A.readTextHead)).status === 404, '别的会话读不到这个子代理的补丁')
    ok((await A.remoteSubagentPatch('s-1', 'sub-b', runs, A.readTextHead)).code === 'subagent_no_patch', '没有改动时说明没有补丁')
    ok((await A.remoteSubagentPatch('s-1', 'sub-c', runs, A.readTextHead)).status === 410, '补丁文件已清理时返回 410')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const calls = []
  const server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    token: 'legacy-remote-token-1234567890',
    handlers: {
      async snapshot() { return { sessions: [] } },
      async history() { return { ok: true, data: { messages: [] } } },
      async command(command) { calls.push(['command', command]); return { ok: true, data: {} } },
      async jobs(sessionId) { calls.push(['jobs', sessionId]); return { ok: true, data: { jobs: [] } } },
      async workflows(sessionId) { calls.push(['workflows', sessionId]); return { ok: true, data: { runs: [] } } },
      async workflowControl(sessionId, id, action) { calls.push(['control', sessionId, id, action]); return { ok: true, data: { id, action } } },
      async quota() { calls.push(['quota']); return { ok: true, data: { cards: [], checkedAt: 1 } } },
      async usage(range) { calls.push(['usage', range]); return { ok: true, data: { range } } },
      async stopJob(sessionId, jobId) { calls.push(['stopJob', sessionId, jobId]); return { ok: true, data: { id: jobId } } },
      async subagentPatch(sessionId, runId) { calls.push(['patch', sessionId, runId]); return { ok: true, data: { patch: '', truncated: false, bytes: 0, files: 0, additions: 0, deletions: 0 } } }
    }
  })
  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const auth = { authorization: `Bearer ${info.token}` }
  const get = async (path) => { const response = await fetch(base + path, { headers: auth }); return { status: response.status, body: await response.json() } }
  const post = async (path, key = 'k-12345678') => { const response = await fetch(base + path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: '{}' }); return { status: response.status, body: await response.json() } }
  try {
    const caps = (await get('/remote/v1/info')).body.capabilities
    ok(['notices', 'jobs', 'job-stop', 'subagent-patch', 'new-worktree', 'workflows', 'workflow-control', 'quota', 'usage'].every((cap) => caps.includes(cap)), '电脑声明新能力', JSON.stringify(caps))
    ok((await get('/remote/v1/sessions/s-1/jobs')).status === 200 && calls.at(-1)[0] === 'jobs', '后台任务路由')
    ok((await get('/remote/v1/sessions/s-1/workflows')).status === 200 && calls.at(-1)[0] === 'workflows', '工作流路由')
    ok((await get('/remote/v1/quota')).status === 200 && calls.at(-1)[0] === 'quota', '额度路由')
    ok((await get('/remote/v1/usage?range=30d')).status === 200 && calls.at(-1)[1] === '30d', '用量路由带范围')
    ok((await get('/remote/v1/usage?range=1y')).status === 400, '非法范围拒绝')
    const stop = await post('/remote/v1/sessions/s-1/workflows/wf-0000000a/stop')
    ok(stop.status === 200 && calls.at(-1)[3] === 'stop', '工作流停止路由')
    ok((await post('/remote/v1/sessions/s-1/workflows/wf-0000000a/pause', '')).status === 400, '工作流控制必须带幂等键')
    ok((await post('/remote/v1/sessions/s-1/workflows/..%2Fx/stop', 'k-abcdefgh')).status === 400, '非法工作流 id 拒绝')
    const jobStop = await post('/remote/v1/sessions/s-1/jobs/term-job-abc123-7/stop')
    ok(jobStop.status === 200 && calls.at(-1).join() === 'stopJob,s-1,term-job-abc123-7', '后台任务停止路由')
    ok((await post('/remote/v1/sessions/s-1/jobs/term-job-abc123-8/stop', '')).status === 400, '停止后台任务必须带幂等键')
    ok((await post('/remote/v1/sessions/s-1/jobs/..%2Fx/stop', 'k-abcdefgh')).status === 400, '非法任务 id 拒绝')
    ok((await get('/remote/v1/sessions/s-1/subagents/sub-abc/patch')).status === 200 && calls.at(-1).join() === 'patch,s-1,sub-abc', '子代理补丁路由')
    ok((await get('/remote/v1/sessions/s-1/subagents/..%2Fx/patch')).status === 400, '非法子代理 id 拒绝')
    ok((await fetch(`${base}/remote/v1/sessions/s-1/subagents/sub-abc/patch`)).status === 401, '补丁需要令牌')
    const created = await fetch(`${base}/remote/v1/sessions/new`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-newtree1' }, body: JSON.stringify({ worktree: true }) })
    ok(created.status === 200 && calls.at(-1)[1].action === 'new' && calls.at(-1)[1].worktree === true, '新建会话可带工作树选项')
    await fetch(`${base}/remote/v1/sessions/new`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'k-newtree2' }, body: JSON.stringify({ worktree: 'yes' }) })
    ok(!('worktree' in calls.at(-1)[1]), '工作树选项只认 true')
    const unauth = await fetch(`${base}/remote/v1/quota`)
    ok(unauth.status === 401, '额度需要令牌')
  } finally {
    await server.stop()
  }
})
