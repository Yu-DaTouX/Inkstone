import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { AntigravitySession, antigravityPrompt } = await compile('src/main/antigravity.ts')
  const longHistory = [{ role: 'user', text: '甲' + '砚'.repeat(110_000) + '乙' }]
  const handoff = antigravityPrompt('继续', longHistory)
  ok(handoff.includes(longHistory[0].text) && handoff.endsWith('\nCurrent user message:\n继续'), '超过旧字符上限时仍交接完整历史和新消息')
  assert.throws(() => antigravityPrompt('a'.repeat(100_001), []), /消息太长/)
  assert.throws(() => antigravityPrompt('继续', [{ role: 'user', text: '砚'.repeat(1_400_000) }]), /历史未裁剪/)
  ok(true, '分别限制新消息字符数和完整历史传输字节数')
  const { parseAntigravityQuota } = await compile('src/main/antigravity-quota.ts')
  const quota = { status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [{
    name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.925, reset_time: '2026-11-21T00:30:00Z' },
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0 },
      { id: 'disabled', name: 'Disabled', status: 'disabled', remaining_fraction: 1 },
      { id: 'missing', name: 'Missing', remaining_fraction: null },
      { id: 'invalid', name: 'Invalid', remaining_fraction: 2 }
    ]
  }] } } }
  const [group] = parseAntigravityQuota(JSON.stringify(quota))
  ok(group.models.join(',') === 'Gemini 4 Neon,Gemini 3.8 Flash' && group.windows.length === 2 &&
    group.windows[0].resetAt === Date.parse('2026-11-21T00:30:00Z') && group.windows[0].remainingFraction === 0.925 &&
    group.windows[1].remainingFraction === 0 && group.windows[1].resetAt === undefined, '官方额度 JSON 保留分组、剩余数和时间，忽略无效或禁用窗口')
  ok(parseAntigravityQuota(JSON.stringify({ ...quota, num_turns: 1 })).length === 0 &&
    parseAntigravityQuota(JSON.stringify({ ...quota, command: { ...quota.command, name: 'model' } })).length === 0, '仅接受零模型回合的 usage 命令结果')
  const cwd = process.cwd()
  const start = (...args) => {
    const child = spawn(process.execPath, [resolve('debug/lib/fake-antigravity.mjs'), ...args], { windowsHide: true })
    const session = new AntigravitySession(child, async () => { child.kill() })
    const events = []
    session.onEvent = (event) => events.push(event)
    return { session, events }
  }
  const wait = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const value = fn()
      if (value) return value
      await delay(15)
    }
    assert.fail('等待 ACP 事件超时')
  }

  const { session, events } = start()
  try {
    const models = await session.start(cwd)
    ok(models.current === 'flash' && models.available.map((m) => m.id).join() === 'flash,pro,third-party', '解析分组模型列表')
    ok(models.mode === 'default' && models.thinking.options.map((m) => m.id).join() === 'low,high', '确认默认审批并解析 CLI 思考档')
    await wait(() => session.context?.used === 120)
    ok(true, '建会话回执后一行的初始上下文已接收')
    await assert.rejects(session.selectModel('unlisted'))
    const pro = await session.selectModel('pro')
    ok(pro.current === 'pro' && pro.thinking.options.at(-1).name === 'Extra', '切换模型后读取相关档位和显示名')
    await assert.rejects(session.selectThinking('ultracode'))
    const high = await session.selectThinking('xhigh')
    ok(high.thinking.current === 'xhigh', '使用模型对应的 config ID 并读取确认回执')
    await wait(() => session.context?.used === 360)
    ok(true, '空闲时更改思考档也接收上下文')
    await assert.rejects(session.selectMode('bypass'))
    ok((await session.selectMode('plan')).modes.current === 'plan', '用真实的 CLI 配置 ID 切到计划权限档')
    await assert.rejects(session.prompt('检查权限档'), /权限档/)
    await session.prompt('检查权限档', 'pro', 'xhigh', 'plan')
    ok(events.some((event) => event.text === '当前权限档 · plan'), '仅按会话明确选定的权限档发送')
    await session.selectMode('default')
    await session.prompt('检查档位')
    ok(events.some((e) => e.text === '当前档位 · pro/xhigh'), '后续真实走 ACP 配置后的夹具档位')
    await session.prompt('统计数据')
    ok(events.some((e) => e.type === 'thought' && e.text === '夹具思考') &&
      events.some((e) => e.type === 'context' && e.used === 5000 && e.size === 20000) &&
      events.some((e) => e.type === 'usage' && e.usage.output === 30 && e.usage.cacheWrite === undefined && e.usage.cost === undefined),
    '区分思考、上下文、终态用量和缺失字段；累计费用不归给回合')
    events.length = 0
    await session.prompt('你好')
    ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === '模拟回复 · pro', '增量文本按序输出，忽略其他会话的事件')
    const pending = session.prompt('权限')
    await assert.rejects(session.prompt('重入'))
    const ask = await wait(() => events.find((e) => e.type === 'permission'))
    ok(ask.title === '查看夹具项目' && ask.detail.includes('README.md') && ask.options.map((e) => e.id).join() === 'once,deny', '显示工具详情，并移除永久授权选项')
    session.reply(ask.id, 'always')
    session.reply(ask.id, 'once')
    ok(await pending === 'end_turn' && events.some((e) => e.text === '审批结果 · once'), '拒绝伪造永久授权、只回传单次批准，并拒绝越权文件 IPC')
    const missing = session.prompt('详情缺失')
    const denyOnly = await wait(() => events.find((e) => e.type === 'permission' && e.id !== ask.id))
    ok(denyOnly.options.every((e) => !e.allow), '缺少操作详情时只允许拒绝')
    session.cancel()
    ok(await missing === 'cancelled' && events.some((e) => e.type === 'permission-cleared' && e.id === denyOnly.id), '停止回复并清除待审批')
    const crash = session.prompt('崩溃')
    await assert.rejects(crash, /断开连接/)
    ok(events.some((e) => e.type === 'closed'), '进程退出时结束待处理请求并通知界面')
  } finally { await session.close() }

  const unknown = start().session
  try {
    await unknown.start(cwd)
    ok((await unknown.selectModel('third-party')).thinking === undefined, '未公布思考档的模型清除前一模型档位')
  } finally { await unknown.close() }

  const legacy = start('legacy').session
  try {
    ok((await legacy.start(cwd)).current === 'flash' && (await legacy.selectModel('pro')).current === 'pro', '兼容旧版 ACP 模型列表和切换')
  } finally { await legacy.close() }

  const auth = start('auth').session
  try {
    await assert.rejects(auth.start(cwd), /agy acp --login/)
    ok(true, '未登录时提示使用官方 CLI 登录')
  } finally { await auth.close() }

  const probe = start().session
  try {
    const discovered = await probe.start(cwd, undefined, { discoverOnly: true })
    ok(discovered.mode === 'auto' && discovered.available.length === 3, '发现模型时只读取 CLI 配置')
    await assert.rejects(probe.prompt('未在当前会话选定自动审批档'), /权限档/)
    ok(true, '拒绝沿用 CLI 全局自动模式')
  } finally { await probe.close() }
})
