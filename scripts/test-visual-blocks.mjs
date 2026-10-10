/** 结构化回答块的解析与校验（shared/visual-blocks.ts）：纯函数，不启动 Electron。 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runVisualBlockTests(ok) {
  await build({ entryPoints: ['src/shared/visual-blocks.ts'], outfile: 'out/test/visual-blocks.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { parseVisualBlock, niceScale, isVisualBlockLang, safeHttpUrl } = await import(pathToFileURL('out/test/visual-blocks.mjs').href)

  const chart = parseVisualBlock('yan-chart', JSON.stringify({
    title: 'TDFlow：人工测试 vs AI 自行生成测试', unit: '%', labels: ['AI 生成测试', '人工提供测试'],
    series: [{ name: '成功率', values: [68, 94.3] }], source: '论文表 2',
    stats: [{ label: 'AI 自行生成测试', value: '68.0%', detail: '平均 $4.12 / 任务' }],
    sources: [{ url: 'https://aclanthology.org/x', label: 'ACL Anthology' }]
  }))
  ok(chart.ok && chart.block.kind === 'chart' && chart.block.type === 'bar' && chart.block.series[0].values[1] === 94.3, '图表：合法数据解析为柱状图')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ title: 't', labels: ['a'], series: [{ name: 's', values: [1] }] })).ok, '图表：缺数据来源拒绝绘制')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ title: 't', labels: ['a', 'b'], series: [{ name: 's', values: [1] }], source: 'x' })).ok, '图表：数值个数与类别不符拒绝')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ title: 't', labels: ['a'], series: [{ name: 's', values: ['9'] }], source: 'x' })).ok, '图表：非数字拒绝')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ title: 't', labels: ['a'], series: [{ name: 's', values: [120] }], source: 'x', max: 100 })).ok, '图表：超过声明上限拒绝')
  ok(!parseVisualBlock('yan-chart', '{"title": "半截').ok, '流式半截 JSON 不解析')
  const unsafe = parseVisualBlock('yan-cards', JSON.stringify({ items: [{ title: 'x', links: [{ label: 'x', url: 'javascript:alert(1)' }] }] }))
  ok(!unsafe.ok, '卡片：危险协议链接拒绝')
  const cards = parseVisualBlock('yan-cards', JSON.stringify({ items: [{ title: 'Typora', badge: '所见即所得', description: '简洁', links: [{ label: '官方网站', url: 'https://typora.io' }] }] }))
  ok(cards.ok && cards.block.items[0].links[0].url === 'https://typora.io/', '卡片：条目与原链接')
  const flow = parseVisualBlock('yan-flow', JSON.stringify({ join: 'plus', steps: [{ icon: 'agent', title: 'Agent 编写测试', detail: 'TestLoadKeyFromEnv' }, { icon: 'checklist', title: '评分器隐藏测试' }], result: { tone: 'err', text: '重复定义 → 编译失败' } }))
  ok(flow.ok && flow.block.join === 'plus' && flow.block.result.tone === 'err', '流程：步骤、连接符与结果')
  ok(!parseVisualBlock('yan-flow', JSON.stringify({ steps: [] })).ok, '流程：没有步骤拒绝')
  ok(!parseVisualBlock('yan-flow', JSON.stringify({ steps: [{ title: 'a' }], result: { tone: 'red', text: 'x' } })).ok, '流程：未知语气拒绝')
  ok(isVisualBlockLang('yan-chart') && isVisualBlockLang('mermaid') && isVisualBlockLang('yan-widget') && !isVisualBlockLang('json') && !isVisualBlockLang(undefined), '只认约定的标签')
  const base = { title: 't', labels: ['a', 'b'], source: 'x' }
  ok(parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'hbar', series: [{ name: 's', values: [1, 2] }] })).ok, '图表：横向柱')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'pie', series: [{ name: 's', values: [1, 2] }] })).ok, '图表：未知形态拒绝')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'dumbbell', series: [{ name: 's', values: [1, 2] }] })).ok, '图表：哑铃图必须恰好两组')
  ok(parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'diverging', series: [{ name: 's', values: [-3, 2] }] })).ok, '图表：偏离基准可为负')
  {
    const single = parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'bar', series: [{ name: 's', values: [-3, 2] }] }))
    ok(single.ok && single.block.type === 'diverging', '图表：单组柱含负数时改用偏离基准画法')
  }
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'bar', series: [{ name: 'a', values: [-3, 2] }, { name: 'b', values: [1, 2] }] })).ok, '图表：多组柱含负数仍拒绝')
  ok(!parseVisualBlock('yan-chart', JSON.stringify({ ...base, type: 'stacked', max: 4, series: [{ name: 'a', values: [3, 1] }, { name: 'b', values: [2, 1] }] })).ok, '图表：堆叠总和超过上限拒绝')
  const stats = parseVisualBlock('yan-stats', JSON.stringify({ items: [{ label: '耗时', value: 28, delta: '-33%', trend: 'down', good: 'down', spark: [42, 28] }, { label: '额度', value: '4.2/5', meter: { value: 9, max: 5 } }] }))
  ok(stats.ok && stats.block.items[0].value === '28' && stats.block.items[1].meter.value === 5, '指标：数字值转文字，进度条封顶')
  ok(!parseVisualBlock('yan-stats', JSON.stringify({ items: [{ label: 'a', value: '1', trend: 'sideways' }] })).ok, '指标：未知趋势拒绝')
  ok(!parseVisualBlock('yan-cards', JSON.stringify({ layout: 'grid', items: [{ title: 'a', recommended: true }, { title: 'b', recommended: true }] })).ok, '卡片：最多一个推荐')
  ok(parseVisualBlock('yan-record', JSON.stringify({ title: 'pkg', fields: [{ label: '版本', value: '1.0' }] })).ok, '记录卡：标题与字段')
  const steps = parseVisualBlock('yan-steps', JSON.stringify({ loop: true, steps: [{ title: 'a', body: 'x' }, { title: 'b', body: 'y' }] }))
  ok(steps.ok && steps.block.loop === true && !parseVisualBlock('yan-steps', JSON.stringify({ steps: [{ title: 'a', body: 'x' }] })).ok, '分步：至少两步，可循环')
  ok(safeHttpUrl('https://u:p@example.com') === null && safeHttpUrl('http://example.com') === 'http://example.com/', '链接：拒绝带账号地址')
  await build({ entryPoints: ['src/shared/question-form.ts'], outfile: 'out/test/question-form.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const form = await import(pathToFileURL('out/test/question-form.mjs').href)
  const fields = form.parseQuestionFields([
    { name: 'side', label: '你是哪一方？', kind: 'choice', options: [{ label: '甲方', description: '委托方' }, '乙方'] },
    { name: 'tags', label: '关注点', kind: 'multi', options: ['价格', '工期', '质量'] },
    { name: 'deadline', label: '截止', kind: 'date' },
    { name: 'budget', label: '预算', kind: 'range', min: 0, max: 5000, step: 100 }
  ])
  ok(fields.length === 4 && fields[0].options[1].label === '乙方', '表单：选项可写文字或对象')
  const bad = (raw) => { try { form.parseQuestionFields(raw); return false } catch (e) { return e instanceof form.QuestionFormError } }
  ok(bad([{ name: 'a', label: 'x', kind: 'choice', options: ['1', '2', '3', '4'] }]), '表单：单选沿用最多 3 个选项')
  ok(bad([{ name: 'a', label: 'x', kind: 'range' }]) && bad([{ name: 'a', label: 'x' }, { name: 'a', label: 'y' }]) && bad([]), '表单：滑块缺范围、重名、空表单都拒绝')
  const answers = form.parseQuestionAnswers(fields, JSON.stringify({ side: '甲方', tags: ['价格', 3], deadline: '2026-10-20', budget: 99999, extra: 'x' }))
  ok(answers.side === '甲方' && answers.tags.length === 1 && answers.budget === 5000 && !('extra' in answers), '表单：答案按字段夹取，丢掉多余键')
  ok(form.parseQuestionAnswers(fields, 'not json') === null, '表单：答案无法解析视为未回答')
  ok(form.summarizeAnswers(fields, answers).startsWith('你是哪一方？：甲方 · 关注点：价格'), '表单：一行可读摘要')
  const pct = niceScale(94.3, '%'), money = niceScale(4.12), tiny = niceScale(0.37)
  ok(pct.max === 100 && pct.ticks.length === 5, '刻度：百分比封顶 100')
  ok(money.max === 5 && money.ticks.join() === '0,1,2,3,4,5', '刻度：4.12 → 0–5')
  ok(tiny.max >= 0.37 && tiny.ticks.length <= 6 && tiny.ticks[0] === 0, '刻度：小数范围')
}

if (process.argv[1]?.endsWith('test-visual-blocks.mjs')) {
  let passed = 0, failed = 0
  await runVisualBlockTests((value, name) => { console.log((value ? 'PASS ' : 'FAIL ') + name); value ? passed++ : failed++ })
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
