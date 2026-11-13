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
  assert.ok(!zhHiddenHint.includes('声明位置'), '不再要求用户猜测声明位置')
  for (const language of ['zh-CN', 'en-US']) {
    const hint = capsText(language, 'promptsHiddenHint')
    assert.ok(hint.includes('.md'), '说明模板文件格式')
    assert.ok(hint.length <= 60, '目录说明保持一句话，不再堆调用命令与重载解释')
    for (const key of ['promptsRefresh', 'promptUserDirectory', 'promptProjectDirectory', 'promptOpenDirectory', 'promptOpenFailed', 'promptCreate', 'promptName', 'promptNameHint', 'promptContent', 'promptContentPlaceholder', 'promptCreateHint', 'promptSave', 'promptSaveFailed', 'promptRetryReload', 'promptSavedReloadFailed', 'promptSavedNoSession', 'promptSavedLocation', 'promptCreated', 'promptNotLoaded']) {
      assert.ok(capsText(language, key).length > 0, `目录入口有 ${language} 文案`)
    }
  }
}

console.log('test-v3-capability-safety: ok')
