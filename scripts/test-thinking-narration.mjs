import './lib/test-isolate.mjs'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'
import { exposeThinkingSignature } from '../resources/pi-extensions/anthropic-progress-updates.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/thinking-narration.json', import.meta.url), 'utf8')).messages
const bySource = (line) => fixture.find((message) => message.source === line)
const clean = (message) => {
  const { source: _source, ...rest } = message
  return structuredClone(rest)
}

const varint = (value) => {
  const out = []
  while (value >= 128) {
    out.push((value % 128) | 128)
    value = Math.floor(value / 128)
  }
  out.push(value)
  return out
}
const lenField = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]
const intField = (field, value) => [...varint(field * 8), ...varint(value)]
const ascii = (text) => [...Buffer.from(text, 'latin1')]
const encode = (bytes) => Buffer.from(bytes).toString('base64')
const kindMessage = (kind) => lenField(1, [...intField(1, 19), ...intField(3, 2), ...intField(7, 1), ...lenField(8, ascii(kind))])
const signed = (kind, { before = [], top = [] } = {}) => encode([...top, ...intField(1, 4), ...lenField(2, [...before, ...kindMessage(kind), ...lenField(2, ascii('x'.repeat(48)))])])

await runSuite(import.meta.url, async (ok, compile) => {
  const m = await compile(null, {
    stdin: {
      contents: [
        "export * from './src/shared/thinking-narration'",
        "export * from './src/main/session-items/projector'",
        "export { StreamProjection } from './src/main/stream-projection'",
        "export { normalizeMessage } from './src/main/normalize'",
        "export { setThinkingDisplayMode } from './src/shared/thinking-display'",
        "export { groupIntoTurns } from './src/shared/turns'",
        "export { extractSearchText } from './src/shared/session-search-text'",
        "export { describeEntry } from './src/shared/native-session'",
        "export { sessionMarkdown } from './src/shared/session-markdown'"
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'thinking-narration-entry.ts',
      loader: 'ts'
    }
  })

  const narrationTurn = bySource(2280)
  const textTurn = bySource(2282)
  const mixedTurn = bySource(1812)
  const finalTurn = bySource(1594)
  const [plainThinking, narration] = narrationTurn.content

  {
    const kinds = fixture.filter((message) => message.role === 'assistant').map((message) => message.content.filter((block) => block.type === 'thinking').map(m.thinkingBlockKind))
    ok(JSON.stringify(kinds) === JSON.stringify([['thinking', 'narration'], ['thinking'], ['thinking', 'narration', 'thinking'], ['thinking']]), '真实签名：旁白与普通思考按签名区分', kinds)
    ok(m.signatureKind(signed('narration')) === 'narration' && m.signatureKind(signed('thinking')) === 'thinking', '合成签名：2 > 1 > 8 路径上的值决定种类')
    ok(m.signatureKind(signed('summary')) === 'unknown', '路径上是不认识的值时返回 unknown')
    ok(m.signatureKind(signed('thinking', { top: lenField(3, ascii('narration')) })) === 'thinking', '其他字段里出现 narration 字样不影响判定，不按字符串查找')
    ok(m.signatureKind(signed('narration', { before: lenField(3, new Array(1200).fill(7)) })) === 'narration', '目标字段在长字段之后也能逐层读到')
    ok(m.signatureKind(signed('narration').replace(/=+$/, '')) === 'narration', '无填充的 base64 同样可解')
    const full = signed('narration')
    ok(m.signatureKind(full.slice(0, 12)) === 'unknown', '截断签名（长度前缀越界）返回 unknown')
    ok(m.signatureKind(encode([...intField(1, 4), ...varint(2 * 8 + 3), 0])) === 'unknown', '分组线型等不认识的格式返回 unknown')
    ok(m.signatureKind(encode([...intField(1, 4), ...varint(2 * 8 + 2), 0xff, 0xff, 0xff, 0xff, 0x0f])) === 'unknown', '长度超出数据返回 unknown')
    ok(m.signatureKind(encode([0x80, 0x80, 0x80])) === 'unknown', '不完整的 varint 返回 unknown')
    ok(['', 'abc', '!!!!', 'QUJD$', 12, null, undefined, {}].every((value) => m.signatureKind(value) === 'unknown'), '缺失、非 base64 与非字符串签名返回 unknown')
    ok(m.signatureKind(encode(ascii('narration narration narration'))) === 'unknown', '不是 protobuf 的内容返回 unknown')
    ok(m.thinkingBlockKind({ ...narration, redacted: true }) === 'unknown', '已遮蔽的思考块不判为旁白')
    ok(m.thinkingBlockKind({ type: 'text', text: 'x', thinkingSignature: narration.thinkingSignature }) === 'unknown', '非思考块返回 unknown')
    ok(m.thinkingBlockKind({ type: 'thinking', thinking: 'x' }) === 'unknown', '没有签名的思考块返回 unknown')
  }

  const history = fixture.map(clean)
  const before = structuredClone(history)
  const projected = m.projectHistory(history)
  ok(JSON.stringify(history) === JSON.stringify(before), '投影不改会话记录：思考块与签名原样保留')
  const assistants = projected.filter((message) => message.role === 'assistant')
  {
    const first = projected[1]
    ok(first.text === narration.thinking, '旁白按正文显示', first.text)
    ok(first.thinking === plainThinking.thinking, '普通思考仍在思考里，不含旁白', first.thinking)
    const mixed = projected.find((message) => message.text.includes('litert-community'))
    ok(mixed.text === mixedTurn.content[1].thinking + mixedTurn.content[3].text, '旁白与正文块按块顺序拼接', mixed.text)
    ok(mixed.thinking === mixedTurn.content[0].thinking + mixedTurn.content[2].thinking, '旁白前后的普通思考都留在思考里', mixed.thinking)
    ok(assistants.length >= 4 && !assistants.some((message) => message.thinkingEmpty), '只有旁白的消息不标成空思考')
    const normalized = m.normalizeMessage(clean(narrationTurn), 0)
    ok(normalized.text === narration.thinking && normalized.thinking === plainThinking.thinking, 'normalizeMessage 与投影一致')
    const replay = new m.SessionItemProjector()
    for (const raw of fixture.slice(0, 3).map(clean)) replay.appendPersisted(raw)
    const owner = replay.uiMessages()[1]
    ok(owner.toolCalls?.length === 1 && owner.text === narration.thinking, '旁白和它前面的工具调用在同一步')
    const turns = m.groupIntoTurns(projected)
    const turn = turns.find((item) => item.kind === 'assistant')
    ok(turn.commentary.some((part) => part.text === narration.thinking.trim()), '回合投影：旁白归入过程说明', turn.commentary.map((part) => part.text))
    ok(!turn.thinking.includes(narration.thinking), '回合投影：思考不含旁白')
    ok(turn.response?.text === finalTurn.content[1].text, '回合投影：最终答案仍是最后的正文', turn.response?.text)
  }

  {
    m.setThinkingDisplayMode('updates')
    const signedThinking = { role: 'assistant', model: 'claude-opus-5-5', content: [structuredClone(plainThinking), { type: 'toolCall', id: 'x1', name: 'bash', arguments: {} }], timestamp: 5 }
    const unsigned = { ...signedThinking, content: [{ type: 'thinking', thinking: 'Checking now.' }, signedThinking.content[1]] }
    const view = (raw) => m.projectHistory([{ role: 'user', content: 'q', timestamp: 1 }, raw]).find((message) => message.role === 'assistant')
    ok(view(signedThinking).thinking === plainThinking.thinking && view(signedThinking).text === '', '签名判为普通思考时，即使紧贴工具调用也不转正文')
    ok(view(unsigned).text === 'Checking now.', '签名未知时沿用原有的进度更新判定')
    m.setThinkingDisplayMode('summarized')
    ok(view(clean(narrationTurn)).text === narration.thinking, '思考展示设为摘要时，旁白也按正文显示')
  }

  const chunks = (text, size = 7) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
  const streamTurn = (withSignature) => {
    let clock = 1000
    const items = new m.SessionItemProjector()
    items.liveMessageStart({ role: 'user', content: 'q' }, clock)
    const header = items.liveMessageStart({ role: 'assistant', model: 'claude-opus-5-5' }, clock)
    const pushes = []
    const stream = new m.StreamProjection({
      items, push: (msg) => pushes.push(msg),
      clock: { now: () => clock, mono: () => clock, setTimer: () => 1, clearTimer: () => undefined },
      modelId: () => 'claude-opus-5-5', turnStartedAt: () => 1000, idleBacklog: () => 0, checkDelta: () => undefined
    })
    stream.streaming = { id: header.id, responseDetail: 'unknown', pushedText: 0, pushedThinking: 0 }
    const event = (assistantMessageEvent) => stream.messageUpdate({ type: 'message_update', assistantMessageEvent })
    const view = { text: '', thinking: '', textResets: 0, shrinks: 0 }
    let read = 0
    const flush = () => {
      stream.flushNow()
      for (; read < pushes.length; read++) {
        const patch = pushes[read].payload.patch
        if (!patch) continue
        if (patch.text !== undefined) { view.text = patch.text; view.textResets++ }
        if (patch.textDelta) view.text += patch.textDelta
        if (patch.thinking !== undefined) { view.thinking = patch.thinking; view.shrinks++ }
        if (patch.thinkingDelta) view.thinking += patch.thinkingDelta
        view.thinkingLive = patch.thinkingLive
        view.thinkingMs = patch.thinkingMs
        view.thinkingStartedAt = patch.thinkingStartedAt
      }
      return { ...view }
    }
    const signature = (block) => withSignature ? { thinkingSignature: block.thinkingSignature } : {}
    event({ type: 'thinking_start', contentIndex: 0 })
    for (const delta of chunks(plainThinking.thinking)) event({ type: 'thinking_delta', contentIndex: 0, delta })
    clock += 400
    event({ type: 'thinking_end', contentIndex: 0, content: plainThinking.thinking, ...signature(plainThinking) })
    const afterThinking = flush()
    clock += 100
    event({ type: 'thinking_start', contentIndex: 1 })
    for (const delta of chunks(narration.thinking)) event({ type: 'thinking_delta', contentIndex: 1, delta })
    const midNarration = flush()
    clock += 300
    event({ type: 'thinking_end', contentIndex: 1, content: narration.thinking, ...signature(narration) })
    const afterNarration = flush()
    event({ type: 'toolcall_start', contentIndex: 2, id: narrationTurn.content[2].id, toolName: 'bash' })
    event({ type: 'toolcall_end', contentIndex: 2, toolCall: narrationTurn.content[2] })
    const beforeEnd = flush()
    const final = items.liveMessageEnd({ thinkingMs: stream.streaming.thinkingMs, thinkingLive: false }, [], clean(narrationTurn))
    stream.finishMessage()
    return { afterThinking, midNarration, afterNarration, beforeEnd, final }
  }

  {
    const live = streamTurn(true)
    ok(live.midNarration.thinking === plainThinking.thinking + narration.thinking, '流式：签名到达前旁白先按思考显示', live.midNarration.thinking)
    ok(live.midNarration.text === '' && live.midNarration.thinkingLive === true, '流式：签名到达前没有正文')
    ok(live.afterNarration.text === narration.thinking, '流式：旁白块结束、签名到达后改判为正文', live.afterNarration.text)
    ok(live.afterNarration.thinking === plainThinking.thinking, '流式：改判时思考收回到普通思考，旁白不残留', live.afterNarration.thinking)
    ok(live.afterNarration.textResets === 0 && live.afterNarration.shrinks === 1, '流式：正文只追加不整段替换，思考只收回一次')
    ok(live.afterNarration.thinkingLive === false && live.afterNarration.thinkingMs === 400 && live.afterNarration.thinkingStartedAt === 1000, '流式：思考计时恢复为普通思考自己的起点与时长', [live.afterNarration.thinkingMs, live.afterNarration.thinkingStartedAt])
    ok(live.beforeEnd.text === narration.thinking && live.beforeEnd.thinking === plainThinking.thinking, '流式：工具调用开始后仍保持改判结果')
    ok(live.final.text === narration.thinking && live.final.thinking === plainThinking.thinking && live.final.toolCalls?.length === 1, '流式：消息结束后与回放一致')
  }

  {
    const late = streamTurn(false)
    ok(late.beforeEnd.text === '' && late.beforeEnd.thinking.includes(narration.thinking), '事件没带签名时，消息结束前仍按思考显示')
    ok(late.final.text === narration.thinking && late.final.thinking === plainThinking.thinking, '消息结束拿到完整签名后改判，与回放一致')
    ok('thinking' in late.final && 'text' in late.final, '改判后的整条消息带上 text 与 thinking，渲染端不残留旧思考')
  }

  {
    const event = { type: 'message_update', message: { api: 'anthropic-messages', content: [clean(narrationTurn).content[0], clean(narrationTurn).content[1]] }, assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: narration.thinking } }
    exposeThinkingSignature(event)
    ok(event.assistantMessageEvent.thinkingSignature === narration.thinkingSignature, '扩展在思考块结束事件上带出签名，供宿主改判')
    const other = { message: { api: 'openai-responses', content: [{ type: 'thinking', thinking: 'x', thinkingSignature: '{"id":"rs"}' }] }, assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 } }
    exposeThinkingSignature(other)
    ok(other.assistantMessageEvent.thinkingSignature === undefined, '其他接口的思考签名不外带')
    const delta = { message: event.message, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'x' } }
    exposeThinkingSignature(delta)
    ok(delta.assistantMessageEvent.thinkingSignature === undefined, '只在块结束时带签名')
    ok(event.message.content[1].thinkingSignature === narration.thinkingSignature && event.message.content[1].type === 'thinking', '扩展不改消息内容')
  }

  {
    const jsonl = fixture.map((message) => JSON.stringify({ type: 'message', message: clean(message) })).join('\n')
    const text = m.extractSearchText(jsonl)
    ok(text.includes(narration.thinking.trim().replace(/\s+/g, ' ').slice(0, 30)), '会话搜索能搜到旁白')
    ok(!text.includes(plainThinking.thinking.slice(0, 30)), '会话搜索仍不收普通思考')
    const described = m.describeEntry({ type: 'message', message: clean(narrationTurn) })
    ok(described.text.startsWith(narration.thinking.trim().slice(0, 20)), '会话树的助手条目显示旁白')
    const markdown = m.sessionMarkdown(projected, { title: 't', exportedAt: 0 })
    ok(markdown.includes(narration.thinking.trim()) && !markdown.includes(plainThinking.thinking.slice(0, 30)), 'Markdown 导出含旁白、不含普通思考')
    ok(textTurn.content.filter((block) => block.type === 'thinking').every((block) => m.visibleTextOfBlock(block) === null), '普通思考块不算可见正文')
  }

  {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-narration-agent-'))
    try {
      process.env.YAN_DATA_DIR = join(dir, 'data')
      process.env.YAN_PI_DIR = join(dir, 'pi')
      process.env.YAN_TEST_APP_DIR = join(dir, 'app')
      const agentFile = join(dir, 'agent.mjs')
      await build({
        entryPoints: ['src/main/agent.ts'], outfile: agentFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
        external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
        plugins: [{ name: 'narration-electron-boundary', setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'narration-electron' }))
          builder.onLoad({ filter: /.*/, namespace: 'narration-electron' }, () => ({ contents: [
            "export class BrowserWindow { constructor() { throw new Error('no electron') } }",
            "export const session = { fromPartition() { throw new Error('no electron') } }",
            'export const app = { getLocale: () => "zh-CN", getPath: (name) => process.env.YAN_TEST_APP_DIR + "/" + name }'
          ].join('\n') }))
        } }]
      })
      const { AgentController } = await import(pathToFileURL(agentFile).href)
      const pushes = []
      const ctl = new AgentController({ push: (msg) => pushes.push(msg), cwd: dir })
      const update = (assistantMessageEvent) => ctl.handleEvent({ type: 'message_update', assistantMessageEvent })
      ctl.handleEvent({ type: 'message_start', message: { role: 'user', content: 'q' } })
      ctl.handleEvent({ type: 'message_start', message: { role: 'assistant', model: 'claude-opus-5-5' } })
      update({ type: 'thinking_start', contentIndex: 0 })
      update({ type: 'thinking_delta', contentIndex: 0, delta: plainThinking.thinking })
      update({ type: 'thinking_end', contentIndex: 0 })
      update({ type: 'thinking_start', contentIndex: 1 })
      update({ type: 'thinking_delta', contentIndex: 1, delta: narration.thinking })
      update({ type: 'thinking_end', contentIndex: 1 })
      update({ type: 'toolcall_start', contentIndex: 2, id: narrationTurn.content[2].id, toolName: 'bash' })
      update({ type: 'toolcall_end', contentIndex: 2, toolCall: narrationTurn.content[2] })
      ctl.handleEvent({ type: 'message_end', message: clean(narrationTurn) })
      const end = pushes.filter((msg) => msg.ch === 'msg-update' && msg.payload.patch.role === 'assistant').at(-1)?.payload.patch
      ok(end?.text === narration.thinking && end?.thinking === plainThinking.thinking, '宿主在 message_end 用最终消息的签名改判并推送整条消息', [end?.text, end?.thinking])
      const replay = m.projectHistory([{ role: 'user', content: 'q' }, clean(narrationTurn)])[1]
      ok(end?.text === replay.text && end?.thinking === replay.thinking, '宿主直播结果与刷新后回放一致')
      await ctl.stop()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }
})
