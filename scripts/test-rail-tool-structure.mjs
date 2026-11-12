import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const rail = await compile('src/renderer/src/features/workbench/rail-data.ts', { external: ['react'] })
  const calls = [{ id: 'c1', name: 'write', status: 'ok', args: { path: 'a.txt' } }]
  const base = [
    { id: 'u1', role: 'user', text: 'go' },
    { id: 'a1', role: 'assistant', text: 'hi', toolCalls: calls }
  ]
  const textOnly = [base[0], { ...base[1], text: 'hi there' }]
  ok(rail.sameToolStructure(base, textOnly), '只追加文字时视为工具结构不变')
  ok(!rail.sameToolStructure(base, [base[0], { ...base[1], toolCalls: [...calls] }]), '工具数组换了引用就重算')
  ok(!rail.sameToolStructure(base, [base[0], { ...base[1], text: '' }]), '文字有无变化会影响分段，要重算')
  ok(!rail.sameToolStructure(base, [base[0], { ...base[1], sourceCwd: 'E:/x' }]), '其他字段变化要重算')
  ok(!rail.sameToolStructure(base, [...base, { id: 'u2', role: 'user', text: 'more' }]), '消息条数变化要重算')

  const tool = await compile('src/renderer/src/features/session/tool-output.ts')
  ok(tool.lastOutputLine('a\nb\nlast line\n\n') === 'last line', '取最后一行忽略结尾空白')
  ok(tool.lastOutputLine('single') === 'single', '单行输出原样返回')
  ok(tool.lastOutputLine(`x\n${'y'.repeat(300)}`).length === 180, '最后一行截到 180 字')
  const big = `${'line\n'.repeat(200_000)}tail`
  ok(tool.lastOutputLine(big) === 'tail', '大输出也只取最后一行')

  const turns = await compile('src/shared/turns.ts')
  const msg = { id: 'a', role: 'assistant', text: 'p1\n\np2' }
  const first = turns.groupIntoTurns([{ id: 'u', role: 'user', text: 'q' }, msg])
  const again = turns.groupIntoTurns([{ id: 'u', role: 'user', text: 'q' }, msg])
  const texts = (list) => list.find((turn) => turn.kind === 'assistant')?.segments.flatMap((segment) => segment.texts.map((item) => item.text))
  ok(JSON.stringify(texts(first)) === '["p1","p2"]' && JSON.stringify(texts(again)) === '["p1","p2"]', '段落拆分缓存不改变结果')
  msg.text = 'p1\n\np2\n\np3'
  const changed = turns.groupIntoTurns([{ id: 'u', role: 'user', text: 'q' }, msg])
  ok(JSON.stringify(texts(changed)) === '["p1","p2","p3"]', '同一对象文字变化后重新拆分')
})
