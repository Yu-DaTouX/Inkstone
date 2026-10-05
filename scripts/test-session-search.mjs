/**
 * 会话正文检索的纯文字逻辑（src/shared/session-search-text.ts）。
 * 只测「取哪些文字进索引」与「怎么匹配」；文件遍历与缓存在主进程，不在这里。
 */
export function runSessionSearchTests(ok, mod) {
  const { extractSearchText, matchText, queryTokens } = mod
  const line = (message) => JSON.stringify({ type: 'message', message })
  const jsonl = [
    JSON.stringify({ type: 'session', id: 's1', cwd: 'C:/proj' }),
    line({ role: 'user', content: '帮我分析 APK 签名校验' }),
    line({ role: 'assistant', content: [{ type: 'thinking', thinking: '内部思考不该进索引' }, { type: 'text', text: '用 jadx 反编译，签名校验在 native 层。' }] }),
    line({ role: 'toolResult', content: [{ type: 'text', text: '工具输出：secret-token-123' }] }),
    line({ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo hidden-cmd' } }] }),
    '这一行不是 JSON "message"',
    line({ role: 'user', content: [{ type: 'text', text: '多行\n内容   压成一行' }, { type: 'image', data: 'xxxx' }] })
  ].join('\n')
  const text = extractSearchText(jsonl)
  ok(text.includes('APK 签名校验') && text.includes('jadx'), '用户与助手的文字进索引')
  ok(!text.includes('内部思考') && !text.includes('secret-token') && !text.includes('hidden-cmd'), '思考、工具结果、工具调用不进索引')
  ok(text.includes('多行 内容 压成一行'), '多行与连续空白压成一行')
  ok(extractSearchText('') === '' && extractSearchText('not json\n{') === '', '空内容与坏行不抛错')

  const big = Array.from({ length: 3000 }, (_, i) => line({ role: 'user', content: `第${i}条 ${'字'.repeat(300)}` })).join('\n')
  const capped = extractSearchText(big)
  ok(capped.length <= 100 * 1024 + 300 * 1024 + 8, '超长会话按配额截断')
  ok(capped.includes('第0条') && capped.includes('第2999条'), '截断后头和尾都还在')

  ok(JSON.stringify(queryTokens('  apk   签名  apk ')) === JSON.stringify(['apk', '签名']), '查询按空白拆词并去重')
  ok(queryTokens('a b c d e f g h').length === 6, '词数封顶')
  ok(queryTokens('   ').length === 0, '空查询没有词')

  const hit = matchText(text, ['apk', '签名'])
  ok(!!hit && hit.matches >= 2, '所有词都出现才命中，且不区分大小写')
  ok(hit?.snippet.includes('APK'), '片段保留原文大小写')
  ok(matchText(text, ['apk', '不存在的词']) === null, '少一个词就不命中')
  ok(matchText(text, []) === null, '没有词不命中')
  ok(matchText('a.b*c(d)', ['.b*c(']) !== null, '查询里的正则符号按字面匹配')
  const long = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`
  const cut = matchText(long, ['关键词'])
  ok(!!cut && cut.snippet.startsWith('…') && cut.snippet.endsWith('…') && cut.snippet.length < 130, '片段取命中处前后一小段并加省略号')
}
