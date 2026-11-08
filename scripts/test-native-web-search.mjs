import assert from 'node:assert/strict'
import {
  ANTHROPIC_SEARCH_TOOL,
  CODEX_SEARCH_TOOL,
  joinCitedText,
  withCitationLinks,
  createSearchCollector,
  searchRecordText,
  withSearchRecords,
  nativeSearchEnabled,
  nativeSearchKind,
  withNativeSearch
} from '../resources/pi-extensions/native-web-search.js'

let checks = 0
const ok = (value, label) => {
  assert.ok(value, label)
  checks++
}

const claude = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5' }
const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6.1' }
const oauth = { anthropic: { type: 'oauth' } }

ok(nativeSearchEnabled({ nativeWebSearch: true }) && !nativeSearchEnabled({}) && !nativeSearchEnabled(null), '只有显式打开才启用')
ok(nativeSearchKind(claude, oauth) === 'anthropic', 'Claude 订阅登录走 Anthropic 服务端搜索')
ok(nativeSearchKind(claude, { anthropic: { type: 'api_key' } }) === null, 'Anthropic API key 不启用（会按次收费）')
ok(nativeSearchKind(claude, null) === null, '读不到登录信息时不启用')
ok(nativeSearchKind(codex, null) === 'codex', 'ChatGPT（Codex）登录走 OpenAI 服务端搜索')
ok(nativeSearchKind({ provider: 'openai', api: 'openai-responses' }, null) === null, 'OpenAI API key 不启用')
ok(nativeSearchKind({ provider: 'commandcode', api: 'anthropic-messages' }, oauth) === null, '第三方 Anthropic 兼容通道不启用')

const anthropicPayload = { model: 'x', tools: [{ name: 'read', input_schema: {} }, { name: 'web_search', input_schema: {} }, { name: 'web_fetch', input_schema: {} }] }
const a = withNativeSearch(anthropicPayload, 'anthropic')
ok(a.tools.filter((tool) => tool.name === 'web_search').length === 1, 'Anthropic 请求里只留一个 web_search，避免重名')
ok(a.tools.at(-1) === ANTHROPIC_SEARCH_TOOL, '本地 web_search 换成服务端工具')
ok(a.tools.some((tool) => tool.name === 'web_fetch') && a.tools.some((tool) => tool.name === 'read'), '其他工具保留')
ok(anthropicPayload.tools.length === 3, '不改动原请求对象')
ok(withNativeSearch(a, 'anthropic') === undefined, '已有服务端搜索时不重复添加')

const codexPayload = { tools: [{ type: 'function', name: 'web_search', parameters: {} }, { type: 'function', name: 'bash', parameters: {} }] }
const c = withNativeSearch(codexPayload, 'codex')
ok(c.tools.length === 2 && c.tools.at(-1) === CODEX_SEARCH_TOOL && c.tools[0].name === 'bash', 'Codex 请求把本地 web_search 换成托管搜索')

const codexInput = { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'web_search' }, { type: 'function', name: 'read' }] }, { role: 'user', content: [] }] }
const ci = withNativeSearch(codexInput, 'codex')
ok(ci.tools.length === 1 && ci.tools[0] === CODEX_SEARCH_TOOL, 'Codex 新协议：托管搜索放在顶层 tools（放进 additional_tools 会被忽略，实测）')
ok(ci.input[0].tools.map((tool) => tool.name).join() === 'read' && ci.input[1] === codexInput.input[1], 'additional_tools 里去掉本地 web_search，其余条目不动')
ok(codexInput.input[0].tools.length === 2, 'Codex 新协议同样不改原请求对象')

const cited = { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: '官方博客列出了 ' }, { type: 'text', text: 'Node.js 26.13.0 (LTS)' }, { type: 'text', text: '，日期为 10-28。' }] }
const joined = joinCitedText(cited)
ok(joined.content.length === 2 && joined.content[1].text === '官方博客列出了 Node.js 26.13.0 (LTS)，日期为 10-28。', '引用拆开的相邻文本块直接拼回一句')
ok(joinCitedText({ content: [{ type: 'text', text: 'a' }, { type: 'toolCall' }, { type: 'text', text: 'b' }] }) === undefined, '不相邻的文本块不合并')

const anthropicEvents = createSearchCollector()
for (const data of [
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"Electron ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'latest"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Electron Releases', url: 'https://releases.electronjs.org/', encrypted_content: 'x' }] } },
  { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { url: 'https://www.npmjs.com/package/electron', title: 'electron - npm', cited_text: 'Latest version: 45.2.1' } } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'hi' } }
]) anthropicEvents.observe(data)
const ar = anthropicEvents.record()
ok(ar.queries.join() === 'Electron latest' && ar.results[0].url === 'https://releases.electronjs.org/' && ar.cited[0].text === 'Latest version: 45.2.1', 'Anthropic：从流事件里记下查询词、结果和引用原文')
ok(!JSON.stringify(ar).includes('encrypted'), '不保存加密的结果正文')

const linkEvents = createSearchCollector()
for (const data of [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://www.npmjs.com/package/electron', title: 'electron - npm' } } },
  { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://www.npmjs.com/package/electron', title: 'electron - npm' } } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
]) linkEvents.observe(data)
const linkedMsg = withCitationLinks({ role: 'assistant', content: [{ type: 'text', text: 'v45\n' }, { type: 'text', text: 'plain' }] }, linkEvents.textCitations())
ok(linkedMsg.content[0].text === 'v45 [npmjs.com](https://www.npmjs.com/package/electron)\n' && linkedMsg.content[1].text === 'plain', 'Anthropic：引用写成文本块末尾的来源链接，重复引用只写一次')
ok(withCitationLinks({ content: [{ type: 'text', text: 'a' }] }, linkEvents.textCitations()) === undefined, '文本块数量对不上时不改')

const codexEvents = createSearchCollector()
for (const data of [
  { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'search', queries: ['Electron latest stable'], query: 'Electron latest stable' } } },
  { type: 'response.output_item.done', item: { type: 'web_search_call', action: { type: 'open_page', url: 'https://releases.electronjs.org/' } } },
  { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', title: 'Electron Releases', url: 'https://releases.electronjs.org/' } }
]) codexEvents.observe(data)
const cr = codexEvents.record()
ok(cr.queries.join() === 'Electron latest stable' && cr.opened[0] === 'https://releases.electronjs.org/' && cr.cited.length === 1, 'Codex：记下查询、打开的页面和引用')
ok(createSearchCollector().record() === null, '没搜索时不产生记录')

const withTool = { role: 'assistant', yanWebSearch: ar, content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'a' }, { type: 'toolCall', name: 'read' }] }
const history = [{ role: 'user', content: 'q' }, withTool, { role: 'toolResult', content: [] }]
const injected = withSearchRecords(history)
ok(injected[1].content.length === 4 && injected[1].content[2].type === 'text' && injected[1].content[3].type === 'toolCall', '记录补在工具调用之前，不打乱工具配对')
ok(injected[1].content[2].text === searchRecordText(ar) && injected[1].content[2].text.includes('Latest version: 45.2.1'), '补充文字包含引用原文')
ok(withTool.content.length === 3 && injected[0] === history[0], '不改会话里的原消息')
ok(withSearchRecords([{ role: 'assistant', content: [] }]) === undefined, '没有记录时不改上下文')
ok(searchRecordText(ar) === searchRecordText(JSON.parse(JSON.stringify(ar))), '同一记录每次补的文字一致（不破坏缓存）')

ok(withNativeSearch(codexPayload, null) === undefined, '不符合条件时不改请求')
ok(withNativeSearch({ model: 'x' }, 'anthropic') === undefined, '没有工具列表的请求不改')

console.log(`native-web-search: ${checks} checks passed`)
