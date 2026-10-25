import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createQuestionTool, TOOL_GUIDANCE } from '../resources/pi-extensions/question.js'
import { capabilityGuide, createTodosTool } from '../resources/pi-extensions/capability-guide.js'
import readOnlyTools from '../resources/pi-extensions/readonly-tools.js'

export async function runPromptSkillContractTests(ok) {
  const match = (value, pattern, label) => ok(pattern.test(value), label)
  const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  const question = createQuestionTool(async request => ({ ok: true, data: { question: request.params.question, answer: 'A' } }))
  const fields = question.parameters.properties.fields.items.properties
  match(fields.options.description, /Required for choice.*multi.*ignored for other kinds/i, 'question options 描述条件必填')
  match(fields.min.description, /Required for range, optional for number/i, 'question 数值边界按类型说明')
  ok(!question.parameters.properties.fields.items.required.includes('options'), '文本字段不被 schema 强制要求 options')
  match(TOOL_GUIDANCE, /cannot settle it from the files.*do not ask what you can verify yourself/s, '可核实信息不向用户重复提问')
  match(TOOL_GUIDANCE, /never relaxes approvals.*explicit user instruction/s, '提问不扩大权限且遵从用户指令')
  const answered = await question.execute('q1', { question: 'Pick one', fields: [{ name: 'note', label: 'Note', kind: 'text' }] })
  ok(answered.details.answer === 'A', 'question execute 使用注入宿主 fixture')
  const cancelled = await createQuestionTool(async () => ({ ok: true, data: { answer: null, cancelled: true } })).execute('q2', {})
  match(cancelled.content[0].text, /Do not guess/i, '提问无答复不猜测')
  for (const tools of [false, true]) {
    const guide = capabilityGuide(tools)
    match(guide, /Batch independent reads and small calls with codemode; print only the needed results/, '能力指引限制批处理输出')
    match(guide, /When direct tools are available, use `write`\/`edit` directly for large file content.*context trimming/, '能力指引让大段写入保留可裁剪参数且兼容仅 codemode 模式')
  }
  let request
  const todos = createTodosTool(async input => { request = input; return { ok: true, data: { action: 'set', revision: 1, todos: input.params.items } } })
  const result = await todos.execute('todo-fixture', { action: 'set', items: [{ text: 'Check', done: false }] }, undefined, undefined, { cwd: '/fixture' })
  ok(request.command === 'tasks.apply' && request.params.operationId === 'todo-fixture' && result.details.todos.length === 1, 'todos execute 保留幂等 ID 与宿主结果')
  const office = await read('resources/skills/office/SKILL.md')
  match(office, /SKILL\.md 所在目录>\/scripts\/check_env\.py/, 'office 环境脚本相对技能定位')
  match(office, /不按项目 cwd 定位/, 'office 不按项目 cwd 猜测脚本位置')
  match(office, /不覆盖已有文件的备份路径.*已提交到 Git 也不能跳过备份/s, 'office 修改前备份不覆盖且不因 Git 豁免')
  match(office, /PDF.*只读与提取.*不要尝试修改已有 PDF 的版式/s, 'office PDF 只读边界')
  const docSync = /^description: (.*)$/m.exec(await read('resources/skills/doc-sync/SKILL.md'))?.[1] ?? ''
  match(docSync, /用户要求同步.*项目约定.*AGENTS\.md.*普通编码任务收尾不用/, 'doc-sync 只在用户或项目约定要求同步文档时触发')
  const subagent = await read('resources/skills/subagent/SKILL.md')
  match(subagent, /没有指定时省略 `--model`.*默认设置.*不主动传当前模型/s, 'subagent 不覆盖宿主默认模型')
  const widget = await read('resources/skills/visual-answer/SKILL.md')
  match(widget, /askInkstone.*用户确认后才填入输入框/s, 'widget 提问须用户确认')
  match(widget, /inkstoneSaveState.*inkstone:restore.*detail/s, 'widget 使用真实保存/恢复接口')
  match(widget, /仅缓存在内存.*64 KB.*32 个/s, 'widget 状态容量和非持久化边界')
  const artifact = await read('resources/skills/artifact/SKILL.md')
  match(artifact, /视频合成.*`sheet`.*总览图.*普通页面/s, 'artifact 自检区分视频 sheet 和网页截图')
  const video = await read('resources/skills/artifact/guides/video.md')
  match(video, /最多 8 格.*不保证每镜都有.*`samples`/s, 'video 8 格抽样不声称覆盖所有镜头')
  match(video, /FFmpeg.*外部前提.*PATH.*YAN_FFMPEG.*不自行安装/s, 'video 导出明确 FFmpeg 依赖与安装边界')
  const cli = await read('resources/yan-cli/yan.mjs')
  match(cli, /allowed 为 true 才继续/, 'CLI consent 必须检查 allowed')
  match(cli, /不保证弹出确认框.*不能代替用户明确要求的事前询问/, 'CLI consent 不替代显式询问')
  match(cli, /只读不代表离线.*付费来源/, 'CLI readonly 明示联网与费用')
  match(cli, /press\s+--key.*Enter.*Tab.*Escape/, 'CLI 按键帮助列出支持的单键')
  match(cli, /query \/ fetch 支持 --refresh.*10 分钟.*进行中请求会合并/, 'CLI 搜索帮助包含 refresh、TTL 和合并')
  match(cli, /共用总时限（默认 30 秒.*5000–60000/, 'CLI 搜索帮助包含默认及自定义总预算')
  match(await read('src/main/subagent-service.ts'), /model: run\.model/, '子 Agent 启动摘要报告实际模型')
  match(await read('src/main/command-registry.ts'), /hotkeys.*设置 → 快捷键.*快捷键表/, 'hotkeys 指向真实桌面入口')
  const tools = new Map()
  readOnlyTools({ registerTool: tool => tools.set(tool.name, tool) })
  const search = tools.get('web_search')
  const fetchPage = tools.get('web_fetch')
  ok(search.parameters.properties.refresh.type === 'boolean' && search.parameters.properties.withContent.type === 'boolean', '只读搜索暴露刷新和正文选项')
  ok(fetchPage.parameters.properties.refresh.type === 'boolean', '只读正文暴露刷新选项')
  await mkdir(resolve('.tmp'), { recursive: true })
  const fixture = await mkdtemp(resolve('.tmp/prompt-skill-fixture-'))
  const envKeys = ['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_PROJECT_ID', 'YAN_SESSION_ID']
  const env = envKeys.map(key => process.env[key])
  const originalFetch = globalThis.fetch
  let hostRequest
  try {
    const resultFile = resolve(fixture, 'result.json')
    await writeFile(resultFile, JSON.stringify({ data: { items: [{ title: 'Fixture', url: 'https://example.com/', source: 'deepseek', published: '2026-10-24', snippet: 'short', summary: 'Long model summary', quality: { provider: 'deepseek', rerank_score: 2, authority: 3 } }] } }))
    for (const key of envKeys) process.env[key] = 'fixture'
    process.env.YAN_CLI_URL = 'http://fixture.invalid/'
    globalThis.fetch = async (_url, options) => {
      hostRequest = JSON.parse(options.body)
      return { json: async () => ({ ok: true, resultFile, summary: {} }) }
    }
    const output = await search.execute('search-fixture', { query: 'fixture', refresh: true, withContent: true })
    ok(hostRequest.command === 'search.query' && hostRequest.params.refresh && hostRequest.params.withContent, '只读搜索把新增参数传给宿主')
    match(output.content[0].text, /Long model summary.*DeepSeek quality/s, '模型读到长摘要和带来源的质量数据')
    match(output.content[0].text, /deepseek.*2026-10-24/s, '模型读到供应商与发布日期')
    await fetchPage.execute('fetch-fixture', { url: 'https://example.com/', refresh: true, maxChars: 1000 })
    ok(hostRequest.command === 'search.fetch' && hostRequest.params.refresh && hostRequest.params.maxChars === 1000, '只读正文把刷新与字数传给宿主')
  } finally {
    globalThis.fetch = originalFetch
    for (const [index, key] of envKeys.entries()) {
      if (env[index] === undefined) delete process.env[key]
      else process.env[key] = env[index]
    }
    await rm(fixture, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let count = 0
  await runPromptSkillContractTests((condition, label) => { assert.ok(condition, label); count++ })
  console.log(`prompt-skill-contracts: ${count} assertions passed (offline)`)
}
