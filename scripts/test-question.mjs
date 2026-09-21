/**
 * 内置「提问」扩展（resources/pi-extensions/question.js）的纯逻辑测试。
 *
 * 不启动 pi / Electron：直接 import 扩展、喂一个假的 `pi` API，
 * 把注册的 tool 与 before_agent_start 处理器抓出来断言。
 *
 * 覆盖四件事：
 *   · 工作模式（实施-05）从**宿主写的每会话快照**读，三档提示不同；
 *   · 快照缺失时的回退链（新字段 defaultWorkMode → 旧布尔 autonomous → 标准）；
 *   · 自主模式下 execute 不弹 UI、直接让模型自行决策；
 *   · 其余模式 select / 自定义输入 / 取消 都能正确回填并返回工具结果。
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runQuestionTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-question-'))
  process.env.YAN_DATA_DIR = dir
  /* 宿主注入的运行实例 id —— 扩展按它找模式快照文件 */
  process.env.YAN_SESSION_ID = 'r1'

  const modeFile = join(dir, 'work-mode', 'r1.json')
  const setModeFile = async (mode) => {
    await mkdir(join(dir, 'work-mode'), { recursive: true })
    await writeFile(modeFile, JSON.stringify({ version: 1, mode }), 'utf8')
  }
  const clearModeFile = () => rm(modeFile, { force: true })
  const setSettings = (raw) => writeFile(join(dir, 'desktop.json'), JSON.stringify(raw), 'utf8')

  const mod = await import(new URL('../resources/pi-extensions/question.js', import.meta.url))
  const factory = mod.default
  ok(typeof factory === 'function', 'question.js 默认导出扩展工厂函数')

  const handlers = {}
  let tool = null
  factory({
    on: (evt, h) => {
      handlers[evt] = h
    },
    registerTool: (t) => {
      tool = t
    }
  })

  ok(!!tool && tool.name === 'question', '注册了 question 工具')
  ok(typeof handlers.before_agent_start === 'function', '注册了 before_agent_start')
  ok(tool.executionMode === 'sequential', 'question 工具串行执行（多个问题不会互相覆盖弹窗）')

  /* ---- 系统提示随会话模式切换 ---- */
  await setModeFile('standard')
  const std = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(
    typeof std?.systemPrompt === 'string' && std.systemPrompt.includes('BASE') && /Interactive questions/.test(std.systemPrompt),
    '标准模式：系统提示注入「模糊时先问」指引'
  )
  await setModeFile('clarify')
  const clarify = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(/Clarify mode is ON/.test(clarify?.systemPrompt ?? ''), '澄清模式：系统提示注入「先把目标问清」指引')
  await setModeFile('autonomous')
  const auto = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(/Autonomous mode is ON/.test(auto?.systemPrompt ?? ''), '自主模式：系统提示注入「不要提问」指引')

  /* ---- 回退链（快照缺失时）---- */
  await clearModeFile()
  await setSettings({ defaultWorkMode: 'clarify', autonomous: true })
  const byNewField = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(
    /Clarify mode is ON/.test(byNewField?.systemPrompt ?? ''),
    '回退链：新字段 defaultWorkMode 优先于旧布尔 autonomous'
  )
  await setSettings({ autonomous: true })
  const byLegacy = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(/Autonomous mode is ON/.test(byLegacy?.systemPrompt ?? ''), '回退链：没有新字段时旧布尔 true → 自主')
  await setSettings({})
  const byDefault = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(/Interactive questions/.test(byDefault?.systemPrompt ?? ''), '回退链：都没有时回到标准模式')

  /* ---- execute：自主模式不弹 UI ---- */
  await setModeFile('autonomous')
  let uiCalls = 0
  const ctxAuto = {
    hasUI: true,
    mode: 'rpc',
    ui: {
      select: async () => {
        uiCalls++
        return 'A'
      },
      input: async () => {
        uiCalls++
        return ''
      }
    }
  }
  const resAuto = await tool.execute('t1', { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }, undefined, undefined, ctxAuto)
  ok(uiCalls === 0, '自主模式下不弹出任何 UI')
  ok(/Autonomous mode/i.test(resAuto.content[0].text), '自主模式返回「请自行决策」')

  /* ---- execute：标准 / 澄清模式都照常提问 ---- */
  await setModeFile('standard')
  const opts = { question: '使用哪种数据库？', options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }] }
  let selectTitle = ''
  uiCalls = 0
  const ctxPick = {
    hasUI: true,
    mode: 'rpc',
    ui: {
      select: async (title, list) => {
        uiCalls++
        selectTitle = title
        return list[0]
      },
      input: async () => 'typed'
    }
  }
  const resPick = await tool.execute('t2', opts, undefined, undefined, ctxPick)
  ok(uiCalls === 1 && selectTitle === '使用哪种数据库？', '标准模式调用一次 select，标题是问题原文')
  ok(resPick.details.answer === 'SQLite', '选择结果回填进 details.answer')
  ok(/User selected: SQLite/.test(resPick.content[0].text), '工具结果文本含用户答案')

  await setModeFile('clarify')
  uiCalls = 0
  const resClarify = await tool.execute('t2b', opts, undefined, undefined, ctxPick)
  ok(uiCalls === 1 && resClarify.details.answer === 'SQLite', '澄清模式同样弹窗并把答案回填')

  /* ---- execute：选「其他」→ 输入自定义答案 ---- */
  const ctxCustom = {
    hasUI: true,
    mode: 'rpc',
    ui: {
      select: async (_t, list) => list[list.length - 1],
      input: async () => '用 MySQL'
    }
  }
  const resCustom = await tool.execute('t3', opts, undefined, undefined, ctxCustom)
  ok(resCustom.details.wasCustom === true && resCustom.details.answer === '用 MySQL', '可自定义输入并回填')
  ok(/User wrote: 用 MySQL/.test(resCustom.content[0].text), '自定义答案的工具结果文本正确')

  /* ---- execute：取消 ---- */
  const ctxCancel = { hasUI: true, mode: 'rpc', ui: { select: async () => undefined, input: async () => '' } }
  const resCancel = await tool.execute('t4', opts, undefined, undefined, ctxCancel)
  ok(resCancel.details.answer === null, '取消时 answer 为 null')
  ok(/cancel/i.test(resCancel.content[0].text), '取消时告诉模型自行决定')

  /* ---- execute：无选项 → 纯输入 ---- */
  const ctxInput = { hasUI: true, mode: 'rpc', ui: { select: async () => undefined, input: async () => '自由答案' } }
  const resInput = await tool.execute('t5', { question: '随便说点什么', options: [] }, undefined, undefined, ctxInput)
  ok(resInput.details.answer === '自由答案', '无选项时走文本输入')

  await rm(dir, { recursive: true, force: true })
  delete process.env.YAN_DATA_DIR
  delete process.env.YAN_SESSION_ID
}
