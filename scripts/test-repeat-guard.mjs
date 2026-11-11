import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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

  const { editEscapeHint, resultFingerprint } = await import('../resources/pi-extensions/repeat-guard.js')
  const editError = [{ type: 'text', text: 'Could not find edits[0] in a.ts.' }]
  const escapeHint = editEscapeHint({ toolName: 'edit', isError: true, input: { path: 'a.ts', edits: [{ oldText: '"\\u4e2d\\u6587"', newText: 'x' }] }, content: editError })
  ok(escapeHint?.content.length === 2 && escapeHint.content[0] === editError[0] && escapeHint.content[1].text.includes('\\uXXXX'), 'edit 失败且 oldText 含字面 \\u 转义：在原错误后追加提示')
  ok(editEscapeHint({ toolName: 'edit', isError: true, input: { path: 'a.ts', oldText: '\\u4e2d', newText: 'x' }, content: editError })?.content.length === 2, '旧版单个 oldText 也识别转义')
  ok(editEscapeHint({ toolName: 'edit', isError: true, input: { edits: [{ oldText: '中文', newText: 'x' }] }, content: editError }) === undefined, '写原字符的失败不追加提示')
  ok(editEscapeHint({ toolName: 'edit', isError: false, input: { edits: [{ oldText: '\\u4e2d', newText: 'x' }] }, content: editError }) === undefined, 'edit 成功不追加提示')
  ok(editEscapeHint({ toolName: 'write', isError: true, input: { oldText: '\\u4e2d' }, content: editError }) === undefined, '其他工具不追加提示')

  const bigText = 'x'.repeat(2_000_000)
  const bigEvent = { content: [{ type: 'text', text: bigText }], details: { n: 1 }, isError: false }
  const bigPrint = resultFingerprint(bigEvent)
  ok(bigPrint.length < 100 && !bigPrint.includes('xxxxxxxx'), '大结果的指纹只保留哈希与长度，不含原文', String(bigPrint.length))
  ok(resultFingerprint({ ...bigEvent, content: [{ type: 'text', text: bigText }] }) === bigPrint, '内容相同的结果指纹相等')
  ok(resultFingerprint({ ...bigEvent, content: [{ type: 'text', text: bigText.slice(0, -1) + 'y' }] }) !== bigPrint, '仅末尾一个字符不同的大结果指纹不等')
  ok(resultFingerprint({ ...bigEvent, details: { n: 2 } }) !== bigPrint && resultFingerprint({ ...bigEvent, isError: true }) !== bigPrint, 'details 或 isError 不同则指纹不等')
  ok(resultFingerprint({ isError: false, details: { n: 1 }, content: [{ text: bigText, type: 'text' }] }) === bigPrint, '对象键顺序不影响指纹')

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
    ok(typeof handlers.tool_call === 'function', 'repeat-guard.js 挂在 tool_call 上（唯一能提前拦的地方）')
    ok(typeof handlers.tool_result === 'function', 'repeat-guard.js 挂在 tool_result 上（判断结果有没有变化）')
    ok(handlers.before_provider_request === undefined, '不改写发给模型的请求：软提醒已删，只留硬拦截')
    ok(typeof handlers.message_end === 'function', '用户发言要能归零，所以也挂 message_end')

    const step = (toolName, input, result) => {
      const blocked = handlers.tool_call({ toolName, input })
      if (blocked) return blocked
      handlers.tool_result({ toolName, input, content: result ?? 'ok' })
      return undefined
    }
    const call = (command = 'ls -la', result) => step('bash', { command }, result)

    ok(call() === undefined, '第 1 次相同调用放行')
    ok(call() === undefined, '第 2 次相同调用、同样的结果仍放行（此时才到提醒线）')
    const blocked = call()
    ok(blocked?.block === true, '第 3 次相同调用、同样的结果被拦下')
    ok(typeof blocked.reason === 'string' && blocked.reason.includes('repeat guard'), '拦下带 reason（模型要能看懂为什么）')
    ok((await readCounter())?.blocks === 1, '拦下时累计计数 +1（宿主读这个文件）')
    ok((await readCounter())?.tool === 'bash', '计数文件里带上工具名（排障用）')
    ok(typeof handlers.session_start === 'function', '会话开始时要清理本会话的拦截计数')
    handlers.session_start({})
    ok((await readCounter()) === null, '新会话开始只删本会话自己的计数文件')
    const counterDir = join(root, 'repeat-guard')
    const oldOther = join(counterDir, 'old-session.json')
    const freshOther = join(counterDir, 'other-session.json')
    await writeFile(oldOther, '{"blocks":3}')
    await writeFile(freshOther, '{"blocks":1}')
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(oldOther, longAgo, longAgo)
    handlers.session_start({})
    ok(!(await readFile(oldOther, 'utf8').then(() => true, () => false)), '超过一周的其它会话计数文件会被清掉，不让目录无界累积')
    ok((await readFile(freshOther, 'utf8')).includes('blocks'), '还在有效期内的其它会话计数文件不动')

    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    ok(step('edit', { a: 1, b: [2, 3] }, 'wrote') === undefined, '键序基准：第 1 次')
    ok(step('edit', { b: [2, 3], a: 1 }, 'wrote') === undefined, '键序不同但内容相同、结果相同 → 仍算第 2 次')
    const reordered = step('edit', { a: 1, b: [2, 3] }, 'wrote')
    ok(reordered?.block === true, '键序漂移不会让指纹失效（第 3 次照样拦）')

    await rm(counterFile, { force: true })
    ok(call('echo a') === undefined, 'A 第 1 次')
    ok(call('echo a') === undefined, 'A 第 2 次（到提醒线）')
    ok(call('echo b') === undefined, '换成 B：清零重数')
    ok(call('echo b') === undefined, 'B 第 2 次')
    ok(call('echo b')?.block === true, 'B 第 3 次才拦（A 的计数不该被继承）')

    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    ok(call('pnpm build') === undefined, '归零场景：第 1 次')
    ok(call('pnpm build') === undefined, '归零场景：第 2 次')
    handlers.message_end({ message: { role: 'user' } })
    ok(call('pnpm build') === undefined, '用户发言后同一条命令重新从第 1 次数起')
    ok(call('pnpm build') === undefined, '数到第 2 次，仍不拦')
    const foundReset = (await readLog()).filter((line) => line.hook === 'reset')
    ok(
      foundReset.some((line) => line.reason === 'user'),
      '归零留了诊断行（排障时能看出串为什么断了）'
    )

    await rm(counterFile, { force: true })
    await rm(logFile, { force: true })
    handlers.message_end({ message: { role: 'user' } })
    const poll = (status) => step('mc_operation', { operation_id: 'op-1' }, status)
    ok(poll('已运行 2 秒，仍在进行，用相同 operation_id 再查') === undefined, '轮询第 1 次')
    ok(poll('已运行 12 秒，仍在进行，用相同 operation_id 再查') === undefined, '结果变了（12 秒）：不计入连续次数，不拦')
    ok(poll('已运行 22 秒，仍在进行，用相同 operation_id 再查') === undefined, '结果再变（22 秒）：仍不拦')
    ok(poll('已运行 31 秒，仍在进行，用相同 operation_id 再查') === undefined, '结果继续变化：第 4 次也不拦（超过 BLOCK_AT 次数但每次都有进展）')
    ok(poll('已完成：构建成功') === undefined, '最终结果变成完成：同样不拦')
    const pollResets = (await readLog()).filter((line) => line.hook === 'reset' && line.reason === 'result_changed')
    ok(pollResets.length >= 3, '每次结果变化都留痕为 result_changed，不是被当成普通重复', JSON.stringify(pollResets))

    ok(poll('已完成：构建成功') === undefined, '结果不再变化：第 1 次（重新起算）')
    const stuckBlocked = poll('已完成：构建成功')
    ok(stuckBlocked?.block === true, '参数和结果都连续不变时，仍按原阈值拦（第 3 次）')

  } finally {
    delete process.env.YAN_REPEAT_EXT_LOG
    delete process.env.YAN_REPEAT_WARN_AT
    delete process.env.YAN_REPEAT_BLOCK_AT
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
