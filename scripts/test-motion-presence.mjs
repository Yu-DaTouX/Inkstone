import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transform } from 'esbuild'

async function load(path, name) {
  const source = readFileSync(path, 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'node18' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: () => { throw new Error(`${name} 不应有 import`) } })
  return module.exports
}

const arrivalMod = await load('src/renderer/src/lib/stream-arrival.ts', 'stream-arrival')
const listMod = await load('src/renderer/src/lib/list-presence.ts', 'list-presence')

const { createArrivalTracker, markArrivalBlocks, arrivalStaggerIndex, ARRIVAL_STAGGER_MS, ARRIVAL_MAX_STAGGER } = arrivalMod
const { createListPresence, listStaggerIndex, LIST_EXIT_MS, LIST_MAX_STAGGER } = listMod

let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

ok(typeof createArrivalTracker === 'function', '必须导出 createArrivalTracker')
ok(typeof createListPresence === 'function', '必须导出 createListPresence')
eq(ARRIVAL_STAGGER_MS, 60, '到达错峰 60ms')
eq(ARRIVAL_MAX_STAGGER, 8, '到达错峰上限 8')
eq(LIST_EXIT_MS, 240, '列表退场 240ms（与 --mo-slow 同源）')
eq(LIST_MAX_STAGGER, 8, '列表错峰上限 8')

{
  const t = createArrivalTracker()
  for (const key of ['0', '31', '99']) {
    const d = t.decide(key, { live: false })
    eq([d.animate, d.stagger], [false, 0], `历史块 ${key} 不动画`)
  }
  t.commit()
  eq(t.seenCount(), 0, '非 live 不登记身份（历史之后也不补播）')
  eq(t.decide('0', { live: true }).animate, true, '同一 key 从未 live 见过，第一次 live 才入场')
}

{
  const t = createArrivalTracker()
  const first = t.decide('100', { live: true })
  eq(first.animate, true, 'live 新块入场')
  eq(first.stagger, 0, '第一个新块错峰 0')
  eq(t.decide('100', { live: true }), first, '同一批次内同 key 幂等（StrictMode 双渲染不误判）')
  t.commit()
  eq(t.decide('100', { live: true }).animate, false, '后续 token / 重渲染不重播')
  const next = t.decide('140', { live: true })
  eq(next.animate, true, '更靠后的新块仍入场')
  eq(next.stagger, 0, 'commit 后错峰计数归零')
  t.commit()
  eq(t.decide('140', { live: true }).animate, false, '第二批 token 不重播')
}

{
  const t = createArrivalTracker()
  const keys = Array.from({ length: 10 }, (_, i) => String(i * 20))
  const staggers = keys.map((k) => t.decide(k, { live: true }).stagger)
  eq(staggers, [0, 1, 2, 3, 4, 5, 6, 7, 7, 7], '错峰按顺序、上限 8（第 8 个起并入最后一档）')
  eq(arrivalStaggerIndex(-3), 0, '负序号压到 0')
  eq(arrivalStaggerIndex(100), 7, '超大序号压到上限')
}

{
  const t = createArrivalTracker()
  t.decide('a', { live: true })
  t.commit()
  eq(t.seenCount(), 1, '已有身份')
  eq(t.decide('a', { live: true }).animate, false, 'scope 内不重播')
  t.reset()
  eq(t.seenCount(), 0, 'reset 清空身份')
  eq(t.decide('a', { live: true }).animate, true, '换 scope 后同一 key 视为新块（新段落从空开始）')
}

{
  const t = createArrivalTracker()
  const d = t.decide('x', { live: true, motion: false })
  eq([d.animate, d.stagger], [false, 0], '减少动效不入场')
  t.commit()
  eq(t.decide('x', { live: true, motion: true }).animate, false, '开启动效后不补播已有块')
  eq(t.decide('y', { live: true, motion: true }).animate, true, '动效开启后新块照常入场')
}

const row = (id, label = id) => ({ id, item: { id, label } })

{
  const p = createListPresence()
  const rows = p.reconcile([row('a'), row('b')])
  eq(rows.map((r) => [r.id, r.phase, r.interactive]), [['a', 'stable', true], ['b', 'stable', true]], '首次全 stable')
  eq(p.exitingIds().join(','), '', '首次无退场')
}

{
  const p = createListPresence()
  p.reconcile([row('a')])
  const rows = p.reconcile([row('a'), row('b'), row('c')])
  eq(rows.find((r) => r.id === 'a').phase, 'stable', '已有行不动画')
  eq(rows.filter((r) => r.phase === 'entering').map((r) => r.id), ['b', 'c'], '新增行 entering')
  eq(rows.find((r) => r.id === 'b').stagger, 0, '第一个新增 0')
  eq(rows.find((r) => r.id === 'c').stagger, 1, '第二个新增 1')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b'), row('c')])
  const rows = p.reconcile([row('c'), row('a'), row('b')])
  eq(rows.map((r) => r.id), ['c', 'a', 'b'], '顺序跟随新顺序')
  ok(rows.every((r) => r.phase === 'stable'), '排序变化不动画')
  eq(p.exitingIds().join(','), '', '排序不产生退场')
}

{
  const p = createListPresence()
  p.reconcile([row('a', '原文'), row('b', '原 B')])
  const rows = p.reconcile([row('a', '新文（已改）'), row('b', '原 B')])
  ok(rows.every((r) => r.phase === 'stable'), '文字更新不动画')
  eq(rows.find((r) => r.id === 'a').item.label, '新文（已改）', '行内容取最新引用')
  eq(p.exitingIds().join(','), '', '文字更新不产生退场')
  const removed = p.reconcile([row('b', '原 B')]).find(r => r.id === 'a')
  eq(removed.item.label, '新文（已改）', '退场快照保留最新内容，不倒退为初始文字')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b')])
  const rows = p.reconcile([row('a')])
  const gone = rows.find((r) => r.id === 'b')
  ok(gone, '退场行保留 DOM 投影')
  eq(gone.phase, 'exiting', '标 exiting（调用方据此渲染 inert）')
  eq(gone.interactive, false, '退场行不可交互（不可点、不进 Tab）')
  eq(rows.find((r) => r.id === 'a').interactive, true, '存活行仍可交互')
  eq(p.exitingIds().join(','), 'b', '退场投影在册')
  ok(p.settle('b'), '退场动画结束 settle')
  eq(p.settle('b'), false, '重复 settle 无副作用')
  eq(p.exitingIds().join(','), '', 'settle 后清投影')
  eq(p.reconcile([row('a')]).map((r) => r.id), ['a'], 'settle 后不再渲染退场行')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b')])
  p.reconcile([row('a')])
  const rows = p.reconcile([row('a'), row('b')])
  eq(rows.find((r) => r.id === 'b').phase, 'entering', '回归行重新入场')
  eq(rows.find((r) => r.id === 'b').interactive, true, '回归行恢复交互')
  eq(p.exitingIds().join(','), '', '回归后不再是退场投影')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b')])
  const rows = p.reconcile([row('a')], { motion: false })
  eq(rows.map((r) => r.id), ['a'], '减少动效时删除立即移除')
  eq(p.exitingIds().join(','), '', '减少动效不保留退场快照')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b')])
  p.reconcile([row('a')], { motion: true })
  ok(p.exitingIds().length > 0, '先有退场投影')
  const rows = p.reconcile([row('a')], { motion: false })
  eq(p.exitingIds().join(','), '', '关闭动效后清掉已保留的退场投影')
  eq(rows.map((r) => r.id), ['a'], '只留存活行')
}

{
  const p = createListPresence()
  p.reconcile([row('a'), row('b')])
  p.reconcile([row('a')])
  ok(p.exitingIds().length > 0, '有退场投影')
  p.reset()
  eq(p.exitingIds().join(','), '', 'reset 清退场快照')
  const rows = p.reconcile([row('x'), row('y')])
  ok(rows.every((r) => r.phase === 'stable'), 'reset 后新 scope 全 stable（不误播）')
}

{
  const p = createListPresence()
  p.reconcile([])
  const rows = p.reconcile(Array.from({ length: 10 }, (_, i) => row(`k${i}`)))
  eq(rows.map((r) => r.stagger), [0, 1, 2, 3, 4, 5, 6, 7, 7, 7], '新增行错峰上限 8')
  eq(listStaggerIndex(50), 7, '列表超大序号压到上限')
}

const { unified } = await import('unified')
const { default: remarkParse } = await import('remark-parse')
const { default: remarkRehype } = await import('remark-rehype')
const parser = unified().use(remarkParse).use(remarkRehype)
const tree = await parser.run(parser.parse('首段\n\n> 引用一\n>\n> 引用二\n\n- 条目一\n- 条目二\n\n```js\nconst n = 1\n```'))
const rootKeys = markArrivalBlocks(tree)
eq(rootKeys.length, 4, '真实Markdown解析得到四个顶层块')
const nested = []
const walk = (node, depth) => {
  if (depth > 1 && node.properties?.['data-arrival-block']) nested.push(node)
  for (const child of node.children ?? []) walk(child, depth + 1)
}
walk(tree, 0)
eq(nested.length, 0, '引用、列表、代码内部节点不重复入场')
const restored = createArrivalTracker()
restored.observe(rootKeys, { live: true })
ok(rootKeys.every(key => !restored.decide(key).animate), '切回live会话的初次已存在块建立基线不补播')
restored.commit()
restored.observe([...rootKeys, '999'], { live: true })
ok(restored.decide('999').animate, '基线之后的真实新块可入场')
restored.commit()
ok(!restored.decide('999').animate, '后续token与相同offset不重播')
restored.observe(['1000'], { live: true, motion: false })
ok(!restored.decide('1000').animate, '减少动效时新块直接建立基线')
restored.reset()
restored.observe(['999'], { live: true })
ok(!restored.decide('999').animate, '重挂载后先建立基线，不补播旧块')
const fresh = createArrivalTracker()
fresh.observe([], { live: true })
fresh.observe(['0'], { live: true })
ok(fresh.decide('0').animate, '空消息挂载后的首个新块可以入场')
console.log(`✓ 动效呈现辅助：${checks} 项通过`)
