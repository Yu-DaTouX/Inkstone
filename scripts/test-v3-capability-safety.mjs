import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function loadTs(relativePath) {
  const entryPoints = [fileURLToPath(new URL(relativePath, import.meta.url))]
  const result = await build({
    entryPoints,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const { createOperationTracker, runGuardedOperation, runConfirmedOperation } = await loadTs(
  '../src/renderer/src/features/settings/capabilities/operation-state.ts'
)
const { formatImportPreviewDetail, httpOriginOf, summarizeNativeEntry } = await loadTs(
  '../src/renderer/src/features/settings/capabilities/native-preview.ts'
)
const { capsText } = await loadTs('../src/renderer/src/features/settings/capabilities/text.ts')

{
  const tracker = createOperationTracker()
  const action = deferred()
  const busy = []
  const results = []
  const stales = []
  let mounted = true
  const running = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(value),
    action: () => action.promise,
    onResult: (value) => results.push(value),
    onStale: (value) => stales.push(value)
  })
  tracker.invalidateScope()
  action.resolve({ ok: true, output: 'done' })
  await running
  assert.deepEqual(busy, [true, false], '项目变化后仍会清掉自己的 busy 锁')
  assert.deepEqual(results, [], '过期结果不应用（不冒充当前项目成功）')
  assert.deepEqual(stales, [{ ok: true, output: 'done' }], '过期结果走 onStale，不静默失败')
}

{
  const tracker = createOperationTracker()
  const first = deferred()
  const second = deferred()
  const busy = []
  let mounted = true
  const runFirst = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(['first', value]),
    action: () => first.promise,
    onResult: () => {},
    onStale: () => {}
  })
  const runSecond = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(['second', value]),
    action: () => second.promise,
    onResult: () => {},
    onStale: () => {}
  })
  first.resolve({ ok: true })
  await runFirst
  assert.deepEqual(busy, [['first', true], ['second', true]], '旧操作的 finally 不解锁新操作的 busy')
  second.resolve({ ok: true })
  await runSecond
  assert.deepEqual(
    busy,
    [['first', true], ['second', true], ['second', false]],
    '新操作只清自己的锁'
  )
}

{
  const tracker = createOperationTracker()
  const first = deferred()
  const second = deferred()
  const busy = []
  const stales = []
  let mounted = true
  const runFirst = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(['first', value]),
    action: () => first.promise,
    onResult: () => {},
    onStale: (value) => stales.push(value)
  })
  tracker.invalidateScope()
  const runSecond = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(['second', value]),
    action: () => second.promise,
    onResult: () => {},
    onStale: () => {}
  })
  first.resolve({ ok: true })
  await runFirst
  assert.deepEqual(stales, [{ ok: true }], 'op1 结果因项目变化而过期')
  assert.deepEqual(busy, [['first', true], ['second', true]], 'op1 的 finally 不解锁 op2 的 busy')
  second.resolve({ ok: true })
  await runSecond
  assert.deepEqual(
    busy,
    [['first', true], ['second', true], ['second', false]],
    '只有 op2 自己清锁'
  )
}

{
  const tracker = createOperationTracker()
  const action = deferred()
  const busy = []
  const results = []
  const stales = []
  let mounted = true
  const running = runGuardedOperation({
    tracker,
    isMounted: () => mounted,
    setBusy: (value) => busy.push(value),
    action: () => action.promise,
    onResult: (value) => results.push(value),
    onStale: (value) => stales.push(value)
  })
  mounted = false
  action.resolve({ ok: true })
  await running
  assert.deepEqual(busy, [true], '卸载后不再清 busy（组件已不存在）')
  assert.deepEqual(results, [], '卸载后不应用结果')
  assert.deepEqual(stales, [], '卸载后不提示')
}

{
  let runCalls = 0
  const cancelled = await runConfirmedOperation({
    captureScope: () => 'session-A',
    isMounted: () => true,
    confirm: async () => false,
    run: async () => {
      runCalls += 1
    }
  })
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(runCalls, 0, '取消时零 IPC（不调用删除）')
}
{
  let runCalls = 0
  const done = await runConfirmedOperation({
    captureScope: () => 'session-A',
    isMounted: () => true,
    confirm: async () => true,
    run: async () => {
      runCalls += 1
    }
  })
  assert.equal(done.phase, 'done')
  assert.equal(runCalls, 1, '确认后执行一次')
}
{
  let scope = 'session-A'
  let runCalls = 0
  const pending = deferred()
  const running = runConfirmedOperation({
    captureScope: () => scope,
    isMounted: () => true,
    confirm: () => pending.promise,
    run: async () => {
      runCalls += 1
    }
  })
  scope = 'session-B'
  pending.resolve(true)
  const outcome = await running
  assert.equal(outcome.phase, 'scope-changed')
  assert.equal(runCalls, 0, '确认期间换会话时不得删除新会话的同名技能')
}
{
  let mounted = true
  let runCalls = 0
  const running = runConfirmedOperation({
    captureScope: () => 'session-A',
    isMounted: () => mounted,
    confirm: async () => {
      mounted = false
      return true
    },
    run: async () => {
      runCalls += 1
    }
  })
  const outcome = await running
  assert.equal(outcome.phase, 'scope-changed')
  assert.equal(runCalls, 0, '确认期间卸载则不执行')
}

assert.equal(httpOriginOf('https://user:pass@example.com:8443/a/b?token=x#h'), 'https://example.com:8443')
assert.equal(httpOriginOf('http://example.com/x'), 'http://example.com')
assert.equal(httpOriginOf('ws://example.com/x'), null, '非 http(s) 不给 origin')
assert.equal(httpOriginOf('file:///etc/passwd'), null)
assert.equal(httpOriginOf('not a url'), null)
assert.equal(httpOriginOf(42), null)

const entry = {
  description: 'demo server',
  command: 'npx',
  args: ['--token', 'ARG-SECRET-456', '--api-key=KEY-SECRET-789'],
  env: {
    PATH: '/usr/bin',
    API_TOKEN: 'ENV-SECRET-ABC',
    NESTED: { deep: 'NESTED-SECRET' }
  },
  url: 'https://user:pass@example.com:8443/private/path?token=URL-SECRET&x=1',
  headers: { Authorization: 'Bearer HEADER-SECRET', nested: { cookie: 'COOKIE-SECRET' } }
}

const summary = summarizeNativeEntry(entry)
assert.deepEqual(summary.envKeys, ['API_TOKEN', 'NESTED', 'PATH'], 'env 只留排序后的键名')
assert.equal(summary.argCount, 3, 'args 只留个数')
assert.equal(summary.urlOrigin, 'https://example.com:8443')

const labels = {
  sourceTitle: '来源服务',
  nativeName: 'pi 服务名',
  scope: '范围：全局（用户级）',
  targetPath: '目标文件',
  entry: '将写入的原生条目',
  warnings: '提醒',
  description: '说明',
  transport: '传输方式',
  command: '命令',
  args: '参数个数',
  envKeys: '环境变量（仅键名）',
  url: '服务地址（仅来源）'
}
const preview = {
  token: 'TOKEN-SECRET-000',
  expiresAt: '2026-01-01T00:00:00.000Z',
  serverId: 'srv',
  nativeName: 'srv',
  scope: 'project',
  targetPath: '/home/u/.pi/mcp.json',
  content: '{"mcpServers":{"other":{"env":{"SECRET":"FILE-SECRET"}}}}',
  serverEntry: entry,
  warnings: ['authRef「ref-name」凭证不迁移'],
  requiresReauth: true,
  reauthNotice: 'authRef 凭证不迁移；导入后请在 pi 里重新登录服务 srv'
}

const entrySnapshot = JSON.stringify(entry)
const detail = formatImportPreviewDetail(preview, 'Demo', labels)

for (const secret of [
  'ARG-SECRET-456',
  'KEY-SECRET-789',
  'ENV-SECRET-ABC',
  'NESTED-SECRET',
  'URL-SECRET',
  'HEADER-SECRET',
  'COOKIE-SECRET',
  'user:pass',
  'pass@example.com',
  '/private/path',
  'TOKEN-SECRET-000',
  'FILE-SECRET'
]) {
  assert.ok(!detail.includes(secret), `展示文本不得含敏感值：${secret}`)
}
assert.ok(!detail.includes('"headers"'), '未知字段 headers 不展示')
assert.ok(!detail.includes('"env"'), '不把 serverEntry 原样 JSON 出来（无 JSON.stringify 兜底）')
assert.ok(detail.includes('API_TOKEN'), 'env 键名可显示')
assert.ok(detail.includes('PATH'), 'env 键名可显示')
assert.ok(detail.includes('https://example.com:8443'), 'URL 只显示 http(s) origin')
assert.ok(detail.includes('/home/u/.pi/mcp.json'), '目标路径可显示')
assert.ok(/参数个数[:：]\s*3/.test(detail), 'args 只显示个数')
assert.equal(JSON.stringify(entry), entrySnapshot, '脱敏只影响展示，不改写 preview.serverEntry')
assert.equal(preview.token, 'TOKEN-SECRET-000', '不改写 preview.token（commit 仍用原令牌）')

{
  const zhHidden = capsText('zh-CN', 'promptHiddenTag')
  assert.ok(!/禁用|停用/.test(zhHidden), 'hiddenInMenu 不得标为已禁用')
  assert.ok(/隐藏/.test(zhHidden), 'hiddenInMenu 标为隐藏')
  const enHidden = capsText('en-US', 'promptHiddenTag')
  assert.ok(!/disabled/i.test(enHidden), 'hiddenInMenu 英文不得标为 disabled')
  assert.ok(/hidden/i.test(enHidden), 'hiddenInMenu 英文标为 hidden')

  const zhEmpty = capsText('zh-CN', 'promptsEmpty')
  assert.ok(zhEmpty.length > 0)
  assert.ok(!/Skill|技能/.test(zhEmpty), '提示词空态不得误用技能文案')
  const enEmpty = capsText('en-US', 'promptsEmpty')
  assert.ok(!/skill/i.test(enEmpty), 'prompt empty state must not reuse skill wording')

  const zhHiddenHint = capsText('zh-CN', 'promptsHiddenHint')
  assert.ok(/不是停用|并非停用/.test(zhHiddenHint), '隐藏说明要点明并非停用')
}

console.log('test-v3-capability-safety: ok')
