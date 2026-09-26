import { build } from 'esbuild'

export async function runHandoffContextTests(ok) {
  await build({ entryPoints: ['src/shared/handoff-context.ts'], outfile: 'out/test/handoff-context.mjs', bundle: true, format: 'esm', platform: 'node' })
  const { handoffHistoryExcerpt, handoffContinuationProblem } = await import('../out/test/handoff-context.mjs')
  const msg = (id, parentId, role, content) => ({ id, parentId, type: 'message', message: { role, content } })
  const entries = [msg('u', null, 'user', '最初目标'), msg('sibling', 'u', 'assistant', '错误分支'),
    { id: 'c', parentId: 'u', type: 'compaction', summary: '已完成 build；还需核对' },
    msg('a', 'c', 'assistant', [{ type: 'thinking', text: '隐藏推理' }, { type: 'toolCall', name: 'read', arguments: { path: 'src/a.ts' } }]),
    msg('t', 'a', 'toolResult', [{ type: 'text', text: '工具结果' }, { type: 'image', data: 'BASE64' }])]
  const excerpt = handoffHistoryExcerpt(entries.map(e => JSON.stringify(e)).join('\n'))
  ok(excerpt.includes('最初目标') && excerpt.includes('已完成 build') && excerpt.includes('src/a.ts') && excerpt.includes('工具结果'), '交接保留初始目标、压缩摘要、工具参数与结果')
  ok(!excerpt.includes('错误分支') && !excerpt.includes('隐藏推理') && !excerpt.includes('BASE64'), '交接排除旁支、推理和图片数据')
  const large = entries.slice(0, 1)
  for (let i = 0; i < 100; i++) large.push(msg(String(i), i ? String(i - 1) : 'u', 'assistant', 'x'.repeat(9000)))
  const bounded = handoffHistoryExcerpt(large.map(e => JSON.stringify(e)).join('\n'))
  ok(bounded.length < 49000 && bounded.includes('最初目标') && bounded.includes('"truncated":true'), '长历史有明确上限和截断标记，初始目标仍保留')
  ok(handoffHistoryExcerpt('broken\n' + JSON.stringify(entries[0])).includes('坏行 1'), '坏行明确标注')
  ok(handoffContinuationProblem({ goal: '目标', deliverable: '交付' }) === 'missing-content-fields', '仅两个非空字段不再作为可续行交接')
  const pkg = { constraints: [], acceptance: [], done: [], remaining: [], nextActions: [], blockers: [], files: [], notes: [] }
  ok(handoffContinuationProblem(pkg) === 'missing-continuation', '空的剩余工作与下一步被拒绝')
  ok(handoffContinuationProblem({ ...pkg, remaining: ['核对'], nextActions: ['读 src/a.ts'] }) === null, '明确续行内容可通过')
  const shared = await import('../out/test/handoff.mjs')
  const prompt = shared.renderHandoffPrompt({ cwd: '.', goal: { brief: { goal: '原始目标', outcome: '验收条件', constraints: '禁止提交' }, links: [{ target: 'src/a.ts' }] }, recentUser: [], history: excerpt })
  ok(prompt.includes('原始目标') && prompt.includes('验收条件') && prompt.includes('禁止提交') && prompt.includes('工具结果'), '实际提示包含登记目标、约束、产物与历史证据')
  ok(prompt.includes('看不到不等于丢失'), '提示明确防止把节选缺失归因于压缩')
}
