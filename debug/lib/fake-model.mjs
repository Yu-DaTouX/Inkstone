import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { sleep } from './env.mjs'

function lastUserText(input) {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (item.role !== 'user') continue
    const content = item.content
    return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')
  }
  return ''
}

function toolOutputsSinceUser(input) {
  let count = 0
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].role === 'user') break
    if (input[i].type === 'function_call_output') count++
  }
  return count
}

export function longText() {
  const parts = ['# 长文本流式测试\n\n这是一段用来检验流式渲染的长回复。\n\n']
  for (let i = 1; i <= 120; i++) parts.push(`- 列表第 ${i} 项：砚把模型输出逐字显示在界面上，这一行用来撑长末尾块。\n\n  补充说明 ${i}，缩进续行。\n`)
  parts.push('\n```ts\n')
  for (let i = 1; i <= 120; i++) parts.push(`const value${i} = compute(${i}, 'segment-${i}')\n`)
  parts.push('```\n\n| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n')
  for (let i = 1; i <= 60; i++) parts.push(`| a${i} | b${i} | c${i} |\n`)
  parts.push('\n结束。\n')
  return parts.join('')
}

function mdShow() {
  const image = 'fig/pic.png'
  const code = Array.from({ length: 26 }, (_, i) => `const item${i} = await load('segment-${i}', { retry: ${i % 3}, label: "第 ${i} 项" }) // 注释 ${i}`).join('\n')
  const rows = Array.from({ length: 14 }, (_, i) => `| ${'x'.repeat(1 + (i * 7) % 11)}${i} | ${i % 4 === 3 ? '较长的一格内容用来撑宽这一列，看列宽会不会跳' : '值 ' + i} | ${i * 17 % 100}% |`).join('\n')
  return [
    '## 流式渲染检查\n\n',
    '先看行内：调用 `loadSegment(index)` 会返回 **加粗强调** 的结果，详见[官方文档页面](https://example.com/docs/streaming/guide)，路径 `src/main/index.ts` 也在里面，再来一句收尾的话。\n\n',
    '### 代码\n\n```ts\n' + code + '\n```\n\n',
    '### 表格\n\n| 名称 | 说明 | 占比 |\n| --- | --- | --- |\n' + rows + '\n\n',
    '### 公式\n\n行内公式 $E = mc^2$ 与 $a_i + b_i$ 夹在句子里，块公式如下：\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n',
    '### 图\n\n```mermaid\nflowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[处理]\n  B -->|否| D[结束]\n  C --> D\n```\n\n',
    '### 图片\n\n![示例图](' + image + ')\n\n',
    '- 列表项一：普通文字\n- 列表项二：含 `代码` 与 [链接](https://example.com/x)\n- 列表项三：收尾\n\n',
    '全部内容到此结束。\n'
  ].join('')
}

function mdReal() {
  return [
    '## 修复结果\n\n',
    '问题出在 `src/main/agent.ts` 的**重试逻辑**：失败后没有清掉旧的订阅，导致同一事件被处理了两次。详见[排查记录](https://example.com/notes/retry)。\n\n',
    '### 改动\n\n',
    '1. **清理订阅**：重试前先调用 `unsubscribe()`，再重新挂上。\n',
    '2. **去重事件**：用 `eventId` 做幂等，重复的直接丢弃。\n',
    '   - 覆盖断线重连\n   - 覆盖超时重试\n',
    '3. ~~旧的计时器~~ 已移除。\n\n',
    '| 文件 | 改动 | 行数 |\n| --- | --- | --- |\n| agent.ts | 清理订阅 | +12 -3 |\n| events.ts | 事件去重 | +20 -0 |\n| retry.test.ts | 新增用例 | +48 -0 |\n\n',
    '> 注意：旧会话里已有的重复事件不会被回填，只影响新事件。\n\n',
    '运行测试：\n\n```bash\nnpm run test -- retry\n```\n\n',
    '---\n\n',
    '**结论**：已修复，测试通过。如需我顺带清理日志，请告诉我。\n'
  ].join('')
}

const SUGGESTION_MARKER ="[Inkstone: predict the user's next message]"

function reportDemo() {
  return [
    '6 份提示词清单都回来了。汇报难读的根子是最终回复的规则散在 5 处、互相打架。*主会话每次固定带约 1.5 万字符，其中一处明确要求「只写散文、不用列表」。*',
    '',
    '*原本打算直接改提示词，你说先不急，已经撤回，草稿存在 `.tmp/prompt-refactor/`。*',
    '',
    '草案已写好，分三期做。**要你定：子代理带不带 AGENTS.md。***这关系到并行派子代理时的成本。*',
    '',
    '真实模型会不会遵守新格式还没测。*要花额度，跑之前会先问你。*'
  ].join('\n')
}

export const FAKE_TRIGGERS = {
  MDREAL: '一段常见的编程助手总结（标题、加粗、行内代码、链接、有序与嵌套列表、删除线、表格、引用、代码块、分隔线），不规则块长与间隔，用来看 markdown 流式渲染',
  MDSHOW: '一篇含行内代码、链接、代码块、表格、公式、Mermaid、图片、列表的短文，慢速逐块流出，用来看 markdown 流式渲染（CHUNK<n> 每块字符数，GAP<n> 间隔毫秒）',
  LONGTEXT: '约 20KB markdown 长文本，慢速逐块流出',
  REPORTDEMO: '一段三层字色的汇报（主体、*附带说明*、**需要注意**），用来看汇报字色',
  MANYTOOLS: '连续 40 步，每步一句话加一次 bash 工具调用',
  BIGOUT: '一次 bash 输出 6000 行，期间分段停顿',
  WRITES: '用 write 工具新建两个文件（notes/a.md、notes/b.md），再流出一句答复，用来看运行结束时的改动卡',
  FAIL: '返回 502，用来看模型错误与重试',
  APPROVAL: '一次命中危险规则的 bash（删除不存在的注册表项），用来看审批',
  QUESTION: '一次带 3 个选项的 question 提问，用来看问答卡的待回答与已回答',
  MOBILEDEMO: '先用 read 读一张仓库里的 PNG，再发一个多字段表单提问，最后流出带长行代码块的答复，用来看手机端看图、表单与代码',
  TERMINAL: '用 yan terminal run 在会话终端里跑一条快命令、一条慢命令，再 list 一次，看终端面板自动打开与 agent 提示（含 DANGER 时改为一条要审批的删除注册表命令）',
  FLOW: '五步：每步先慢速思考，夹叙述与 bash（含无叙述步、慢参数），最后流出较长答案（含 SHORT 时答案很短），用来看消息流跳动与顺序',
  'STORM-<名字>': '压测：60 步（含 STEPS<n> 时为 n 步；含 ASK 时跑完先提一次两选项问题；含 SLOW 时每步慢速思考约 6 秒），每步快速思考、叙述、一次改项目文件（storm/）并输出 120 行的 bash，每 15 步一段表格与代码，最后流出约 20KB 长文',
  'CAMSHOT': '仿「拍照确认」：6 步（含 STEPS<n> 时为 n 步），每步一次快 bash、一次 read 读 DIR=<目录>（缺省为项目里 cam）下的 check<步>.png、一句叙述、一次约 20 秒的慢 bash；图片由场景预先放好',
  SUBAGENTS: '先用 yan subagent start 派 4 个假模型子代理（SUBSTORM；写成 SUBAGENTS<n> 时派 n 个），再按 STORM 跑 60 步',
  'SUBSTORM-<名字>': '子代理压测：40 步，每步叙述加一次改文件（sub/）并输出 60 行的 bash',
  '<subagent-notification': '子代理完成回传只回一句，避免再次触发',
  [SUGGESTION_MARKER]: '砚的「预测下一句」请求，固定回「继续下一步」'
}

function stormTag(text, word) {
  return new RegExp(`${word}-([A-Za-z0-9]+)`).exec(text)?.[1] ?? 'x'
}

function stormCommand(dir, tag, step, lines) {
  const touch = `mkdir -p ${dir} && for i in 1 2 3; do printf 'step ${step} ${tag} %s\\n' "$RANDOM" >> "${dir}/${tag}-$(( (${step} + i) % 12 )).txt"; done`
  const tracked = step % 10 === 0 ? ` && printf 'touch ${tag} ${step}\\n' >> README.md` : ''
  return `${touch}${tracked} && seq -f 'out ${step} line %g ................................................' 1 ${lines}`
}

function stormNarration(step) {
  if (step % 15 !== 14) return `第 ${step + 1} 步：继续处理。`
  const rows = Array.from({ length: 8 }, (_, i) => `| ${step}-${i} | 值 ${i * step} | 状态 ${i % 3 ? '通过' : '待查'} |`).join('\n')
  return `第 ${step + 1} 步小结：\n\n| 项 | 值 | 状态 |\n| --- | --- | --- |\n${rows}\n\n\`\`\`ts\nconst step${step} = ${JSON.stringify({ step, ok: true })}\n\`\`\`\n`
}

function flowThinking(step) {
  const lines = [`Step ${step + 1}: weighing what to check next.`]
  for (let i = 1; i <= 9; i++) lines.push(`- consideration ${i} for step ${step + 1}: compare the ledger totals and the float rounding path before touching code.`)
  return lines.join('\n')
}

function flowAnswer(short) {
  const parts = ['## 修复结果\n\n金额改为以分为单位的整数计算，避免了浮点误差。\n\n']
  for (let i = 1; i <= (short ? 3 : 24); i++) parts.push(`- 第 ${i} 项：核对账本第 ${i} 行，金额与汇总一致，测试覆盖对应分支。\n`)
  parts.push('\n全部测试通过，最终答案结束。\n')
  return parts.join('')
}

const FLOW_STEPS = [
  { text: '先看看项目结构。', command: 'echo list files', description: '列出项目文件' },
  { text: '', command: 'echo read readme', description: '读取 README 与事件说明' },
  { text: '开始修复金额精度，先复现一次。', command: 'echo reproduce', description: '验证浮点误差复现数值', slowArgs: true },
  { text: '', command: 'echo run tests', description: '运行测试', slowArgs: true }
]

async function respond(res, text, done, requestNo) {
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const id = `resp_${requestNo}`
  const output = []
  send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
  const streamText = async (content, chunk, delay) => {
    const index = output.length
    const item = { id: `msg_${requestNo}_${index}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    send({ type: 'response.output_item.added', output_index: index, item })
    send({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '' } })
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < content.length;) {
      const step = chunk < 0 ? 2 + Math.floor(next() * (-chunk - 1)) : chunk
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: content.slice(i, i + step) })
      i += step
      if (delay) await sleep(chunk < 0 ? Math.round(delay * (0.3 + next() * 1.7)) : delay)
    }
    send({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: content })
    const finished = { ...item, status: 'completed', content: [{ type: 'output_text', text: content }] }
    send({ type: 'response.output_item.done', output_index: index, item: finished })
    output.push(finished)
  }
  const streamThinking = async (content, chunk, delay) => {
    const index = output.length
    const item = { id: `rs_${requestNo}_${index}`, type: 'reasoning', summary: [] }
    send({ type: 'response.output_item.added', output_index: index, item })
    send({ type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } })
    for (let i = 0; i < content.length; i += chunk) {
      send({ type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: index, summary_index: 0, delta: content.slice(i, i + chunk) })
      if (delay) await sleep(delay)
    }
    send({ type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: index, summary_index: 0, text: content })
    const finished = { ...item, summary: [{ type: 'summary_text', text: content }] }
    send({ type: 'response.output_item.done', output_index: index, item: finished })
    output.push(finished)
  }
  const callTool = async (name, args, chunkDelay = 5) => {
    const index = output.length
    const item = { id: `fc_${requestNo}_${index}`, type: 'function_call', call_id: `call_${requestNo}_${index}`, name, arguments: '', status: 'in_progress' }
    send({ type: 'response.output_item.added', output_index: index, item })
    const raw = JSON.stringify(args)
    for (let i = 0; i < raw.length; i += 40) {
      send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: raw.slice(i, i + 40) })
      await sleep(chunkDelay)
    }
    send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: raw })
    const finished = { ...item, arguments: raw, status: 'completed' }
    send({ type: 'response.output_item.done', output_index: index, item: finished })
    output.push(finished)
  }
  const stormStep = async (dir, tag, step, lines) => {
    if (text.includes('SLOW')) await streamThinking(`Storm ${tag} step ${step + 1}: ` + 'slowly weigh the evidence before the next edit. '.repeat(10), 4, 50)
    else await streamThinking(`Storm ${tag} step ${step + 1}: ` + 'check the files, compare outputs, decide the next edit. '.repeat(5), 12, 8)
    await streamText(stormNarration(step), 6, 10)
    await callTool('bash', { command: stormCommand(dir, tag, step + 1, lines), description: `storm ${tag} ${step + 1}` })
  }
  try {
    if (text.includes(SUGGESTION_MARKER)) await streamText('继续下一步', 20, 5)
    else if (text.includes('<subagent-notification')) await streamText('好的，收到。', 20, 10)
    else if (text.includes('SUBSTORM')) {
      if (done < 40) await stormStep('sub', stormTag(text, 'SUBSTORM'), done, 60)
      else await streamText('子任务四十步完成。', 20, 10)
    } else if (text.includes('SUBAGENTS')) {
      const count = Number(/SUBAGENTS(\d+)/.exec(text)?.[1] ?? 4)
      if (done < 1) await callTool('bash', { command: `for i in $(seq 1 ${count}); do yan subagent start --task "SUBSTORM-sub$i 压测子任务" --title "压测$i" --model fake/fake-model; done`, description: 'start subagents' })
      else if (done < 61) await stormStep('storm', stormTag(text, 'SUBAGENTS'), done - 1, 120)
      else await streamText(longText(), 24, 8)
    } else if (text.includes('CAMSHOT')) {
      const steps = Number(/STEPS(\d+)/.exec(text)?.[1] ?? 6)
      const step = Math.floor(done / 3)
      const phase = done % 3
      if (step >= steps) await streamText('拍照确认结束。', 20, 10)
      else if (phase === 0) await callTool('bash', { command: `echo shot ${step + 1}`, description: `拍照确认新取景 ${step + 1}` })
      else if (phase === 1) await callTool('read', { path: `${/DIR=(\S+)/.exec(text)?.[1] ?? 'cam'}/check${step + 1}.png` })
      else {
        await streamText(`第 ${step + 1} 张：手机屏幕现在约占画面宽度的 80%，比之前大了不少；接下来上机测试并统计采样行。`, 6, 20)
        await callTool('bash', { command: `sleep 20; echo run ${step + 1}`, description: `上机 v${step + 1} 并统计采样行` })
      }
    } else if (text.includes('STORM')) {
      const steps = Number(/STEPS(\d+)/.exec(text)?.[1] ?? 60)
      if (done < steps) await stormStep('storm', stormTag(text, 'STORM'), done, 120)
      else if (done === steps && text.includes('ASK')) await callTool('question', { question: `${stormTag(text, 'STORM')} 跑完了，下一步怎么做？`, options: ['继续', '停下'] })
      else await streamText(longText(), 24, 8)
    } else if (text.includes('MDREAL')) await streamText(mdReal(), -14, 22)
    else if (text.includes('MDSHOW')) await streamText(mdShow(), Number(/CHUNK(\d+)/.exec(text)?.[1] ?? 6), Number(/GAP(\d+)/.exec(text)?.[1] ?? 20))
    else if (text.includes('LONGTEXT')) await streamText(longText(), 12, 15)
    else if (text.includes('REPORTDEMO')) await streamText(reportDemo(), 40, 10)
    else if (text.includes('MANYTOOLS')) {
      if (done < 40) {
        await streamText(`第 ${done + 1} 步。`, 20, 0)
        await callTool('bash', { command: `echo step ${done + 1}`, description: `step ${done + 1}` })
      } else await streamText('四十步都完成了。', 20, 10)
    } else if (text.includes('FLOW')) {
      await streamThinking(flowThinking(done), 24, 45)
      const step = FLOW_STEPS[done]
      if (step) {
        if (step.text) await streamText(step.text, 6, 30)
        await callTool('bash', { command: step.command, description: step.description }, step.slowArgs ? 300 : 5)
      } else await streamText(flowAnswer(text.includes('SHORT')), 16, 25)
    } else if (text.includes('WRITES')) {
      if (done < 2) await callTool('write', { path: `notes/${done ? 'b' : 'a'}.md`, content: Array.from({ length: 6 + done * 4 }, (_, i) => `第 ${i + 1} 行`).join('\n') + '\n' })
      else await streamText('两个文件都写好了。', 6, 30)
    } else if (text.includes('BIGOUT')) {
      if (done < 1) await callTool('bash', { command: 'for i in $(seq 1 6000); do echo "line $i ................................................................"; if [ $((i % 400)) -eq 0 ]; then sleep 0.25; fi; done', description: 'long output' })
      else await streamText('长输出结束。', 20, 10)
    } else if (text.includes('APPROVAL')) {
      if (done < 1) await callTool('bash', { command: 'reg delete "HKCU\\Software\\InkstoneApprovalTest" /f', description: 'approval probe' })
      else await streamText('审批测试结束。', 20, 10)
    } else if (text.includes('TERMINAL')) {
      const steps = text.includes('DANGER')
        ? [{ command: `yan terminal run --command 'reg delete "HKCU\\Software\\InkstoneTerminalApproval" /f'`, description: '终端里删除注册表项' }]
        : [
            { command: `yan terminal run --command 'Write-Output "agent-terminal-ok"; Get-ChildItem -Name | Select-Object -First 5'`, description: '在会话终端里列文件' },
            { command: `yan terminal run --command 'Start-Sleep -Seconds 3; Write-Output "slow-done"'`, description: '终端里跑一条慢命令' },
            { command: 'yan terminal list', description: '查看会话终端' }
          ]
      if (done < steps.length) {
        await streamText(`终端第 ${done + 1} 步。`, 20, 0)
        await callTool('bash', steps[done])
      } else await streamText('终端测试结束。', 20, 10)
    } else if (text.includes('MOBILEDEMO')) {
      if (done < 1) await callTool('read', { path: resolve(import.meta.dirname, '../../build/icon.png') })
      else if (done < 2) await callTool('question', { question: '发布前还要确认几件事：版本号怎么定、哪些平台要打包、什么时候发，另外有没有要写进更新说明的。', fields: [
        { name: 'bump', label: '版本号', kind: 'choice', options: ['补丁 0.14.1', '次版本 0.15.0'] },
        { name: 'platforms', label: '打包平台', kind: 'multi', options: ['Windows', 'macOS', 'Linux', 'Android'] },
        { name: 'date', label: '发布日期', kind: 'date' },
        { name: 'retries', label: '失败重试次数', kind: 'range', min: 0, max: 5 },
        { name: 'notes', label: '更新说明补充', kind: 'text', optional: true }
      ] })
      else await streamText('收到。打包脚本大致是这样：\n\n```ts\nexport async function packageAll(platforms: string[], version: string, options: { sign: boolean; publish: boolean; retries: number }): Promise<void> { for (const platform of platforms) await runBuild(platform, version, options) }\nconst veryLongConfigurationLine = { appId: "com.inkstone.desktop", productName: "Inkstone", artifactName: "${productName}-${version}-${os}-${arch}.${ext}" }\n```\n\n上面第一行很长，手机上应该能横向滑动。', 20, 10)
    } else if (text.includes('QUESTION')) {
      if (done < 1) await callTool('question', { question: '会话栏（环境/统计/上下文/更改那一列）和右栏，你想要哪种？现在的逻辑是右栏一打开会话栏就让位隐藏，而右栏的「概览」标签又和会话栏内容重复。', options: ['两者共存：右栏打开时会话栏照常显示（窗口太窄才让位），右栏去掉重复的「概览」', '合并：去掉独立会话栏，概览变成右栏固定的第一个标签（T3 式只有一个右侧区域）', '保持现状'] })
      else await streamText('好的，按你的选择来。', 20, 10)
    } else await streamText('好的，收到。', 20, 10)
  } catch {}
  send({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 } } } })
  res.end()
}

export function startFakeModel(port = 0) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let json = {}
      try { json = JSON.parse(body) } catch {}
      const input = Array.isArray(json.input) ? json.input : []
      const text = lastUserText(input)
      const done = toolOutputsSinceUser(input)
      const images = JSON.stringify(input).split('"input_image"').length - 1
      requests.push({ at: Date.now(), text: text.slice(0, 40), done, tools: (json.tools ?? []).length, images })
      if (text.includes('FAIL')) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fake upstream failure' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      void respond(res, text, done, requests.length)
    })
  })
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ server, port: server.address().port, requests })))
}
