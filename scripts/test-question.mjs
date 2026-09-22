/**
 * 内置「提问」薄层（resources/pi-extensions/question.js）的纯逻辑测试。
 *
 * 01-S5 收口后，question.js 只保留工作模式提示钩子；真正的交互请求由宿主
 * `yan question ask` 处理，因此这里必须明确断言它**不再注册模型工具**。
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runQuestionTests(ok) {
  const dir = await mkdtemp(join(tmpdir(), 'yan-question-'))
  process.env.YAN_DATA_DIR = dir
  process.env.YAN_SESSION_ID = 'r1'

  const modeFile = join(dir, 'work-mode', 'r1.json')
  const setModeFile = async (mode) => {
    await mkdir(join(dir, 'work-mode'), { recursive: true })
    await writeFile(modeFile, JSON.stringify({ version: 1, mode }), 'utf8')
  }
  const clearModeFile = () => rm(modeFile, { force: true })
  const setSettings = (raw) => writeFile(join(dir, 'desktop.json'), JSON.stringify(raw), 'utf8')

  try {
    const mod = await import(new URL('../resources/pi-extensions/question.js', import.meta.url))
    const factory = mod.default
    ok(typeof factory === 'function', 'question.js 默认导出扩展工厂函数')

    const handlers = {}
    let registerCalls = 0
    factory({
      on: (evt, handler) => {
        handlers[evt] = handler
      },
      registerTool: () => {
        registerCalls += 1
      }
    })

    ok(registerCalls === 0, 'question.js 不再注册模型 question 工具（唯一入口是宿主 CLI）')
    ok(typeof handlers.before_agent_start === 'function', '仍保留工作模式提示钩子')

    /* ---- 系统提示随会话模式切换 ---- */
    await setModeFile('standard')
    const std = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(
      typeof std?.systemPrompt === 'string' &&
        std.systemPrompt.includes('BASE') &&
        /Interactive questions/.test(std.systemPrompt) &&
        /yan question ask/.test(std.systemPrompt),
      '标准模式：系统提示指引模型调用 yan question ask'
    )

    await setModeFile('clarify')
    const clarify = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(
      /Clarify mode is ON/.test(clarify?.systemPrompt ?? '') &&
        /yan question ask/.test(clarify?.systemPrompt ?? ''),
      '澄清模式：系统提示允许通过宿主 CLI 提问'
    )

    await setModeFile('autonomous')
    const auto = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(
      /Autonomous mode is ON/.test(auto?.systemPrompt ?? '') &&
        /do NOT call `yan question ask`/i.test(auto?.systemPrompt ?? ''),
      '自主模式：系统提示明确禁止调用 yan question ask'
    )

    /* ---- 回退链（快照缺失时）---- */
    await clearModeFile()
    await setSettings({ defaultWorkMode: 'clarify', autonomous: true })
    const byNewField = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(/Clarify mode is ON/.test(byNewField?.systemPrompt ?? ''), '回退链：新字段 defaultWorkMode 优先于旧布尔 autonomous')

    await setSettings({ autonomous: true })
    const byLegacy = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(/Autonomous mode is ON/.test(byLegacy?.systemPrompt ?? ''), '回退链：没有新字段时旧布尔 true → 自主')

    await setSettings({})
    const byDefault = handlers.before_agent_start({ systemPrompt: 'BASE' })
    ok(/Interactive questions/.test(byDefault?.systemPrompt ?? ''), '回退链：都没有时回到标准模式')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.YAN_DATA_DIR
    delete process.env.YAN_SESSION_ID
  }
}
