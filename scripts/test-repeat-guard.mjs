import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runRepeatGuardTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'yan-repeat-'))
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'r1'
  process.env.YAN_REPEAT_EXT_LOG = join(root, 'ext.jsonl')
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

    const call = (command = 'ls -la') => ({ toolName: 'bash', input: { command } })
    ok(handlers.tool_call(call()) === undefined, '第 1 次相同调用放行')
    ok(handlers.tool_call(call()) === undefined, '第 2 次相同调用仍放行（此时才到提醒线）')
    const blocked = handlers.tool_call(call())
    ok(blocked?.block === true, '第 3 次相同调用被拦下')
    ok(typeof blocked.reason === 'string' && blocked.reason.includes('repeat guard'), '拦下带 reason（模型要能看懂为什么）')
    ok((await readCounter())?.blocks === 1, '拦下时累计计数 +1（宿主读这个文件）')
    ok((await readCounter())?.tool === 'bash', '计数文件里带上工具名（排障用）')

    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    ok(handlers.tool_call({ toolName: 'edit', input: { a: 1, b: [2, 3] } }) === undefined, '键序基准：第 1 次')
    ok(handlers.tool_call({ toolName: 'edit', input: { b: [2, 3], a: 1 } }) === undefined, '键序不同但内容相同 → 仍算第 2 次')
    const reordered = handlers.tool_call({ toolName: 'edit', input: { a: 1, b: [2, 3] } })
    ok(reordered?.block === true, '键序漂移不会让指纹失效（第 3 次照样拦）')

    await rm(counterFile, { force: true })
    ok(handlers.tool_call(call('echo a')) === undefined, 'A 第 1 次')
    ok(handlers.tool_call(call('echo a')) === undefined, 'A 第 2 次（到提醒线）')
    ok(handlers.tool_call(call('echo b')) === undefined, '换成 B：清零重数')
    ok(handlers.tool_call(call('echo b')) === undefined, 'B 第 2 次')
    ok(handlers.tool_call(call('echo b'))?.block === true, 'B 第 3 次才拦（A 的计数不该被继承）')

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

    handlers.message_end({ message: { role: 'user' } })
    ok(handlers.tool_call(call('pnpm build')) === undefined, '用户发言后同一条命令重新从第 1 次数起')
    ok(handlers.before_provider_request({ payload }) === undefined, '刚归零时不会立刻又提醒')
    ok(handlers.tool_call(call('pnpm build')) === undefined, '数到第 2 次（又到提醒线）')
    const foundReset = (await readLog()).filter((line) => line.hook === 'reset')
    ok(
      foundReset.some((line) => line.reason === 'user'),
      '归零留了诊断行（排障时能看出串为什么断了）'
    )

  } finally {
    delete process.env.YAN_REPEAT_EXT_LOG
    delete process.env.YAN_REPEAT_WARN_AT
    delete process.env.YAN_REPEAT_BLOCK_AT
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
