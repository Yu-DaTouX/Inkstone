/**
 * 内置「提问」扩展（resources/pi-extensions/question.js）的纯逻辑测试。
 *
 * 不启动 pi / Electron：直接 import 扩展、喂一个假的 `pi` API，
 * 把注册的 tool 与 before_agent_start 处理器抓出来断言。
 *
 * 覆盖三件事：
 *   · 系统提示按「自主模式」切换（问 vs 不问）
 *   · 自主模式下 execute 不弹 UI、直接让模型自行决策
 *   · 普通模式下 select / 自定义输入 / 取消 都能正确回填并返回工具结果
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runQuestionTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-question-'))
  process.env.YAN_DATA_DIR = dir

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

  const setMode = (autonomous) =>
    writeFile(join(dir, 'desktop.json'), JSON.stringify({ autonomous }), 'utf8')

  /* ---- 系统提示随模式切换 ---- */
  await setMode(false)
  const ask = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(
    typeof ask?.systemPrompt === 'string' && ask.systemPrompt.includes('BASE') && /Interactive questions/.test(ask.systemPrompt),
    '默认模式：系统提示注入「可提问」指引'
  )
  await setMode(true)
  const auto = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(/Autonomous mode is ON/.test(auto?.systemPrompt ?? ''), '自主模式：系统提示注入「不要提问」指引')

  /* ---- execute：自主模式不弹 UI ---- */
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

  /* ---- execute：普通模式选择选项 ---- */
  await setMode(false)
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
  ok(uiCalls === 1 && selectTitle === '使用哪种数据库？', '普通模式调用一次 select，标题是问题原文')
  ok(resPick.details.answer === 'SQLite', '选择结果回填进 details.answer')
  ok(/User selected: SQLite/.test(resPick.content[0].text), '工具结果文本含用户答案')

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
}
