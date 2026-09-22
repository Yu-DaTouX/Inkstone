/**
 * 单轮重复动作兜底（`resources/pi-extensions/repeat-guard.js` + `shared/repeat-guard.ts`）。
 *
 * 这一层要证明的是**边界**，不是「能拦」：
 *   · 判据只认「同一工具 + 规范化参数逐字相同 + 连续」—— 中间换了调用就清零；
 *   · 3 次只提醒（不打断）、5 次才拦（用户明确要求：不干扰正常工作）；
 *   · 用户发言 / `yan goal report` 归零；
 *   · 计数文件的键与宿主清洗规则**同语义**（不一致 = 「薄层一直拦、宿主不知道」）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runRepeatGuardTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'yan-repeat-'))
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'r1'
  process.env.YAN_REPEAT_EXT_LOG = join(root, 'ext.jsonl')
  /* 阈值收窄到 2 / 3：生产值是 3 / 5，由常量断言与 live 场景覆盖 */
  process.env.YAN_REPEAT_WARN_AT = '2'
  process.env.YAN_REPEAT_BLOCK_AT = '3'

  const counterFile = join(root, 'repeat-guard', 'r1.json')
  const logFile = process.env.YAN_REPEAT_EXT_LOG

  const readLog = async () => {
    try {
      return (await readFile(logFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const readCounter = async () => {
    try {
      return JSON.parse(await readFile(counterFile, 'utf8'))
    } catch {
      return null
    }
  }

  try {
    const mod = await import(new URL('../resources/pi-extensions/repeat-guard.js', import.meta.url))
    const factory = mod.default
    ok(typeof factory === 'function', 'repeat-guard.js 默认导出扩展工厂函数')

    const handlers = {}
    factory({
      on: (evt, handler) => {
        handlers[evt] = handler
      },
      /* 薄层不许注册模型工具 / 命令（01 §1 的架构检查） */
      registerTool: () => {
        throw new Error('repeat-guard.js 不应注册模型工具')
      },
      registerCommand: () => {
        throw new Error('repeat-guard.js 不应注册命令')
      }
    })
    ok(typeof handlers.tool_call === 'function', 'repeat-guard.js 挂在 tool_call 上（唯一能看参数的地方）')
    ok(typeof handlers.before_provider_request === 'function', '提醒走 before_provider_request（tool_call 只能 block）')
    ok(typeof handlers.message_end === 'function', '用户发言要能归零，所以也挂 message_end')

    /* ── 1. 连续相同调用：前两次放行、第 3 次拦下（单测阈值 2/3） ───── */
    const call = (command = 'ls -la') => ({ toolName: 'bash', input: { command } })
    ok(handlers.tool_call(call()) === undefined, '第 1 次相同调用放行')
    ok(handlers.tool_call(call()) === undefined, '第 2 次相同调用仍放行（此时才到提醒线）')
    const blocked = handlers.tool_call(call())
    ok(blocked?.block === true, '第 3 次相同调用被拦下')
    ok(typeof blocked.reason === 'string' && blocked.reason.includes('repeat guard'), '拦下带 reason（模型要能看懂为什么）')
    ok((await readCounter())?.blocks === 1, '拦下时累计计数 +1（宿主读这个文件）')
    ok((await readCounter())?.tool === 'bash', '计数文件里带上工具名（排障用）')

    /* ── 2. 参数规范化：键序不同但内容相同算同一个调用 ──────────────── */
    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    ok(handlers.tool_call({ toolName: 'edit', input: { a: 1, b: [2, 3] } }) === undefined, '键序基准：第 1 次')
    ok(handlers.tool_call({ toolName: 'edit', input: { b: [2, 3], a: 1 } }) === undefined, '键序不同但内容相同 → 仍算第 2 次')
    const reordered = handlers.tool_call({ toolName: 'edit', input: { a: 1, b: [2, 3] } })
    ok(reordered?.block === true, '键序漂移不会让指纹失效（第 3 次照样拦）')

    /* ── 3. 夹了别的调用 → 清零（正常干活碰不到这条线） ─────────────── */
    await rm(counterFile, { force: true })
    ok(handlers.tool_call(call('echo a')) === undefined, 'A 第 1 次')
    ok(handlers.tool_call(call('echo a')) === undefined, 'A 第 2 次（到提醒线）')
    ok(handlers.tool_call(call('echo b')) === undefined, '换成 B：清零重数')
    ok(handlers.tool_call(call('echo b')) === undefined, 'B 第 2 次')
    ok(handlers.tool_call(call('echo b'))?.block === true, 'B 第 3 次才拦（A 的计数不该被继承）')

    /* ── 4. 提醒：注入一条消息、且只提醒一次 ────────────────────────── */
    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    const payload = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '帮我看看' }
      ]
    }
    ok(handlers.tool_call(call('pnpm build')) === undefined, '提醒场景：第 1 次')
    ok(handlers.tool_call(call('pnpm build')) === undefined, '提醒场景：第 2 次（到提醒线）')
    const warned = handlers.before_provider_request({ payload })
    ok(Array.isArray(warned?.messages) && warned.messages.length === payload.messages.length + 1, '第 2 次之后注入一条提醒')
    ok(
      JSON.stringify(warned.messages[1]).includes('Repeat guard'),
      '提醒插在用户消息**之前**（与 language.js 同一个位置口径）'
    )
    ok(handlers.before_provider_request({ payload }) === undefined, '同一条串只提醒一次（不做复读机）')

    /* ── 5. 归零：用户发言 / 目标报进展 ─────────────────────────────── */
    handlers.message_end({ message: { role: 'user' } })
    ok(handlers.tool_call(call('pnpm build')) === undefined, '用户发言后同一条命令重新从第 1 次数起')
    ok(handlers.before_provider_request({ payload }) === undefined, '刚归零时不会立刻又提醒')
    ok(handlers.tool_call(call('pnpm build')) === undefined, '数到第 2 次（又到提醒线）')
    ok(handlers.tool_call({ toolName: 'bash', input: { command: 'cd repo && yan goal report --phase executing' } }) === undefined, '报进展的调用本身放行')
    ok(handlers.before_provider_request({ payload }) === undefined, '报进展后提醒线也归零（换路径了）')
    const foundReset = (await readLog()).filter((line) => line.hook === 'reset')
    ok(
      foundReset.some((line) => line.reason === 'user') && foundReset.some((line) => line.reason === 'goal-report'),
      '两种归零都留了诊断行（排障时能看出串为什么断了）'
    )

    /* ── 6. 宿主侧纯逻辑 ─────────────────────────────────────────────── */
    const shared = await import(new URL('../out/test/repeat-guard.mjs', import.meta.url))
    const goal = await import(new URL('../out/test/goal.mjs', import.meta.url))
    ok(shared.REPEAT_WARN_AT === 3 && shared.REPEAT_BLOCK_AT === 5, '生产阈值是 3 / 5（不随测试 env 漂移）')
    ok(
      shared.repeatGuardKey('C:\\sessions\\a b.jsonl') === 'C__sessions_a_b.jsonl',
      '键清洗与薄层 safeKey 同语义（冒号 / 反斜杠 / 空格 → 下划线）'
    )
    ok(shared.repeatGuardKey('') === 'session', '空键退化成 session（与薄层一致）')
    ok(mod.safeKey() === shared.repeatGuardKey(process.env.YAN_SESSION_ID), '薄层 safeKey 与宿主 repeatGuardKey 交叉一致')

    const snapshot = shared.parseRepeatGuardSnapshot({ blocks: 2.7, tool: ' bash ', updatedAt: 5 })
    ok(snapshot.blocks === 2 && snapshot.tool === 'bash' && snapshot.updatedAt === 5, '计数宽容解析：向下取整 + 去空白')
    ok(shared.parseRepeatGuardSnapshot(null).blocks === 0, '脏值（null）当 0')
    ok(shared.parseRepeatGuardSnapshot({ blocks: 'x' }).blocks === 0, '脏值（非数字）当 0')

    const blank = goal.emptyGoal(1)
    ok(shared.pendingRepeatFailures(0, 3) === 3, '没有消费游标时全部要补记')
    const once = goal.applyRepeatFailure(blank, shared.REPEAT_BLOCK_SIGNATURE, 2)
    ok(once.failure?.count === 1 && once.phase === 'planning', '补记一次：只加计数、不动 phase（没到阈值）')
    ok(shared.pendingRepeatFailures(1, 3) === 2, '已消费过的不会重复记（用独立消费游标，不用 failure.count）')
    ok(shared.pendingRepeatFailures(3, 1) === 0, '计数变小（文件被清）不会倒退记账')
    ok(shared.pendingRepeatFailures(0, 999) === 10, '一次最多补记 10 次（脏文件不会把目标瞬间打爆）')

    const twice = goal.applyRepeatFailure(once, shared.REPEAT_BLOCK_SIGNATURE, 3)
    ok(twice.phase === 'blocked' && twice.failure === null, '同一签名连续两次 → blocked（与 §5 的失败签名同一阈值）')
    ok(String(twice.blocker ?? '').includes(shared.REPEAT_BLOCK_SIGNATURE), 'blocked 的 blocker 写明是重复动作拦下')

    const done = { ...blank, phase: 'completed' }
    const afterDone = goal.applyRepeatFailure(done, shared.REPEAT_BLOCK_SIGNATURE, 4)
    ok(afterDone.phase === 'completed', '已完成的目标不会被重复拦下改写（不假装失败）')
  } finally {
    delete process.env.YAN_REPEAT_EXT_LOG
    delete process.env.YAN_REPEAT_WARN_AT
    delete process.env.YAN_REPEAT_BLOCK_AT
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
