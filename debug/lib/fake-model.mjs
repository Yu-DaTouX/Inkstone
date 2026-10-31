import { createServer } from 'node:http'
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

export const FAKE_TRIGGERS = {
  LONGTEXT: '约 20KB markdown 长文本，慢速逐块流出',
  MANYTOOLS: '连续 40 步，每步一句话加一次 bash 工具调用',
  BIGOUT: '一次 bash 输出 6000 行，期间分段停顿',
  FAIL: '返回 502，用来看模型错误与重试',
  APPROVAL: '一次命中危险规则的 bash（删除不存在的注册表项），用来看审批',
  QUESTION: '一次带 3 个选项的 question 提问，用来看问答卡的待回答与已回答',
  FLOW: '五步：每步先慢速思考，夹叙述与 bash（含无叙述步、慢参数），最后流出较长答案（含 SHORT 时答案很短），用来看消息流跳动与顺序'
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
    for (let i = 0; i < content.length; i += chunk) {
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: content.slice(i, i + chunk) })
      if (delay) await sleep(delay)
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
  try {
    if (text.includes('LONGTEXT')) await streamText(longText(), 12, 15)
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
    } else if (text.includes('BIGOUT')) {
      if (done < 1) await callTool('bash', { command: 'for i in $(seq 1 6000); do echo "line $i ................................................................"; if [ $((i % 400)) -eq 0 ]; then sleep 0.25; fi; done', description: 'long output' })
      else await streamText('长输出结束。', 20, 10)
    } else if (text.includes('APPROVAL')) {
      if (done < 1) await callTool('bash', { command: 'reg delete "HKCU\\Software\\InkstoneApprovalTest" /f', description: 'approval probe' })
      else await streamText('审批测试结束。', 20, 10)
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
      requests.push({ at: Date.now(), text: text.slice(0, 40), done, tools: (json.tools ?? []).length })
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
