import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { checkV3StyleIsolation } from './design/check-v3-style-isolation.mjs'

const report = { pass: 0, fail: 0 }
const failures = []

function ok(cond, label) {
  if (cond) {
    report.pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    report.fail += 1
    failures.push(label)
    process.stdout.write(`  ✗ ${label}\n`)
  }
}

async function load(relative) {
  const source = fileURLToPath(new URL(relative, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const item = (id, text, images) => ({ id, text, ...(images ? { images } : {}) })
const image = (data) => ({ data, mimeType: 'image/png' })

{
  const plan = await load('../src/renderer/src/features/composer/queue-plan.ts')
  const { locateQueueItem, planQueueMove, planQueueEdit, planQueueRemove, planQueueClear } = plan

  const base = {
    steering: [item('s1', '插话一')],
    followUp: [item('f1', '排队一', [image('a')]), item('f2', '排队二'), item('f3', '排队三')]
  }

  process.stdout.write('\n▌ queue-plan：定位与重排\n')
  ok(locateQueueItem(base, 's1')?.kind === 'steering', '按 id 定位 steering')
  ok(locateQueueItem(base, 'f2')?.index === 1, '按 id 定位 followUp 的下标')
  ok(locateQueueItem(base, 'nope') === undefined, '未知 id 返回 undefined')

  const moved = planQueueMove(base, 'f1', 'down')
  ok(moved?.followUp.map((i) => i.id).join(',') === 'f2,f1,f3', '下移一格的顺序正确')
  ok(moved?.steering === base.steering, '只换目标类，另一类引用不变')
  ok(base.followUp.map((i) => i.id).join(',') === 'f1,f2,f3', '原状态未被就地修改')
  ok(moved?.followUp[1].images?.[0].data === 'a', '重排保留图片')
  ok(planQueueMove(base, 'f1', 'up') === null, '已在队首时上移返回 null')
  ok(planQueueMove(base, 'f3', 'down') === null, '已在队尾时下移返回 null')
  ok(planQueueMove(base, 'f2', 'up')?.followUp.map((i) => i.id).join(',') === 'f2,f1,f3', '中间项上移一格')
  ok(planQueueMove(base, 'f1', 'down')?.steering.length === 1, '重排不跨类（steering 仍在原处）')
  ok(planQueueMove(base, 'ghost', 'up') === null, '被接收的 id 重排返回 null')

  process.stdout.write('\n▌ queue-plan：编辑与删除\n')
  const edited = planQueueEdit(base, 'f2', '  改过的文字  ')
  ok(edited?.followUp[1].text === '改过的文字', '编辑会去掉首尾空白')
  ok(edited?.followUp[1].id === 'f2', '编辑保留 id')
  ok(base.followUp[1].text === '排队二', '编辑不就地修改原状态')
  ok(planQueueEdit(base, 'f2', '排队二') === null, '文本没变返回 null（不做空重建）')
  ok(planQueueEdit(base, 'f2', '   ') === null, '空文本返回 null')
  ok(planQueueEdit(base, 'ghost', 'x') === null, '被接收的 id 编辑返回 null')

  const removed = planQueueRemove(base, 'f2')
  ok(removed?.followUp.map((i) => i.id).join(',') === 'f1,f3', '删除只移除目标')
  ok(removed?.steering === base.steering, '删除不动另一类')
  ok(planQueueRemove(base, 'ghost') === null, '被接收的 id 删除返回 null')

  process.stdout.write('\n▌ queue-plan：全部清除\n')
  const cleared = planQueueClear(base)
  ok(cleared?.steering.length === 0 && cleared?.followUp.length === 0, '全部清除清空两类队列')
  ok(base.followUp.length === 3, '全部清除不就地修改原状态')
  ok(planQueueClear({ steering: [], followUp: [] }) === null, '空队列全部清除返回 null')
  ok(planQueueClear({ steering: [], followUp: [item('f1', '甲')] })?.steering.length === 0, '只有一类时也清空')

  process.stdout.write('\n▌ queue-plan：按 id 的单条操作（A11-01 / T5-01 渲染端）\n')
  const { planQueueOp } = plan
  ok(planQueueOp(base, { op: 'move', id: 'f1', direction: 'down' })?.followUp.map((i) => i.id).join(',') === 'f2,f1,f3', 'move 操作等价于按 id 重排')
  ok(planQueueOp(base, { op: 'edit', id: 'f2', text: ' 改过 ' })?.followUp[1].text === '改过', 'edit 操作等价于按 id 编辑')
  ok(planQueueOp(base, { op: 'remove', id: 'f2' })?.followUp.map((i) => i.id).join(',') === 'f1,f3', 'remove 操作等价于按 id 删除')
  ok(planQueueOp(base, { op: 'clear' })?.followUp.length === 0, 'clear 操作等价于清空')
  ok(planQueueOp(base, { op: 'remove', id: 'ghost' }) === null, '单条操作命中未知 id 时不做整体重建')

  const live = { steering: [], followUp: [item('f1', '排队一'), item('f2', '排队二'), item('f9', '快照之后新追加')] }
  const afterRemove = planQueueOp(live, { op: 'remove', id: 'f2' })
  ok(afterRemove?.followUp.map((i) => i.id).join(',') === 'f1,f9', '按当前队列执行删除，渲染快照之后追加的条目不被顺手删掉')
  const afterMove = planQueueOp(live, { op: 'move', id: 'f1', direction: 'down' })
  ok(afterMove?.followUp.map((i) => i.id).join(',') === 'f2,f1,f9', '按当前队列执行重排，快照之后追加的条目留在原位')
}

function makePort({ clearResults, refillFailsAt = -1 }) {
  const calls = { clear: 0, adopt: [], publish: [], refill: [] }
  let refillIndex = 0
  const clearQueue = async () => {
    const result = clearResults[Math.min(calls.clear, clearResults.length - 1)]
    calls.clear += 1
    return result
  }
  return {
    calls,
    port: {
      clearQueue,
      adoptCleared: (steering, followUp) => calls.adopt.push({ steering, followUp }),
      publish: (next) => calls.publish.push(JSON.parse(JSON.stringify(next))),
      refill: async (steering, followUp) => {
        calls.refill.push(JSON.parse(JSON.stringify({ steering, followUp })))
        if (refillIndex === refillFailsAt) {
          refillIndex += 1
          throw new Error('rpc down')
        }
        refillIndex += 1
      }
    }
  }
}

{
  const mod = await load('../src/main/queue-edit.ts')
  const { applyQueueRewrite, cloneQueue, planQueueRewrite } = mod

  const original = {
    steering: [item('s1', '插话', [image('img')])],
    followUp: [item('f1', '一'), item('f2', '二')]
  }
  const next = {
    steering: [item('s1', '插话改')],
    followUp: [item('f2', '二'), item('f1', '一')]
  }

  process.stdout.write('\n▌ queue-edit：成功路径\n')
  {
    const { port, calls } = makePort({
      clearResults: [{ success: true, steering: ['插话'], followUp: ['一', '二'] }]
    })
    const result = await applyQueueRewrite(port, original, next)
    ok(result.ok === true && !result.error, '成功返回 ok 且无 error')
    ok(calls.clear === 1, '只清空一次')
    ok(calls.adopt.length === 1 && calls.adopt[0].steering.join() === '插话', '采用 clear_queue 实况')
    ok(calls.publish[0].followUp.map((i) => i.id).join(',') === 'f2,f1', '先发布目标顺序')
    ok(calls.refill[0].steering[0].text === '插话改', 'steering 按新文本重建')
    ok(calls.refill[0].followUp.map((i) => i.id).join(',') === 'f2,f1', 'followUp 按新顺序重建')
  }

  process.stdout.write('\n▌ queue-edit：clear_queue 失败\n')
  {
    const { port, calls } = makePort({ clearResults: [{ success: false, error: 'busy' }] })
    const result = await applyQueueRewrite(port, original, next)
    ok(result.ok === false && /busy/.test(result.error ?? ''), '带上原生错误')
    ok(calls.refill.length === 0, '没重建')
    ok(result.dropped?.length === 3, '目标内容全部交给渲染端回填')
  }

  process.stdout.write('\n▌ queue-edit：重建失败但原队列恢复\n')
  {
    const { port, calls } = makePort({
      clearResults: [
        { success: true, steering: ['插话'], followUp: ['一', '二'] },
        { success: true, steering: [], followUp: [] }
      ],
      refillFailsAt: 0
    })
    const result = await applyQueueRewrite(port, original, next)
    ok(result.ok === false, '整体失败')
    ok(/恢复/.test(result.error ?? '') && !/恢复失败/.test(result.error ?? ''), '错误说明原队列已恢复')
    ok(result.dropped === undefined || result.dropped.length === 0, '恢复成功不返回 dropped')
    ok(calls.clear === 2, '为恢复再清空一次')
    ok(calls.refill.length === 2, '重建 + 恢复各一次 refill')
    ok(calls.refill[1].followUp.map((i) => i.text).join(',') === '一,二', '恢复的是原顺序原文')
    ok(calls.publish[1].followUp.map((i) => i.text).join(',') === '一,二', '恢复时先发布原队列')
  }

  process.stdout.write('\n▌ queue-edit：恢复也失败\n')
  {
    const { port } = makePort({
      clearResults: [
        { success: true, steering: ['插话'], followUp: ['一', '二'] },
        { success: false, error: 'gone' }
      ],
      refillFailsAt: 0
    })
    const result = await applyQueueRewrite(port, original, next)
    ok(result.ok === false, '整体失败')
    ok(/恢复失败/.test(result.error ?? '') && /gone/.test(result.error ?? ''), '错误同时带上原生原因')
    ok(result.dropped?.length === 3, '恢复失败时目标内容交给渲染端回填，不丢')
    ok(result.dropped?.[0].text === '插话改', 'dropped 用目标文本（用户最后看到的）')
  }

  process.stdout.write('\n▌ queue-edit：过期快照（T5-01 重复执行）\n')
  {
    const live = { steering: [], followUp: [item('f2', '二')] }
    const stale = { steering: [], followUp: [item('f1', '一'), item('f2', '二')] }
    const { port, calls } = makePort({ clearResults: [{ success: true, steering: [], followUp: ['二'] }] })
    const result = await applyQueueRewrite(port, live, stale)
    ok(result.ok === true, '过期快照提交仍返回 ok（已没有可改的内容）')
    ok(calls.clear === 0, '目标与当前队列一致时不清空 pi 队列')
    ok(calls.refill.length === 0, '已执行的条目不再回灌（不会执行第二次）')
    ok(calls.publish.length === 1 && calls.publish[0].followUp.map((i) => i.id).join(',') === 'f2', '只把当前队列重新发一遍，让界面追上实况')
  }
  {
    const live = { steering: [], followUp: [item('f2', '二')] }
    const stale = { steering: [], followUp: [item('f1', '一', [image('img')])] }
    const { port, calls } = makePort({ clearResults: [{ success: true, steering: [], followUp: ['二'] }] })
    const result = await applyQueueRewrite(port, live, stale)
    ok(result.ok === true, '只含过期条目的删除意图照常完成')
    ok(calls.clear === 1 && calls.refill.length === 1, '确实清空并按增量重建一次')
    const json = JSON.stringify({ publish: calls.publish, refill: calls.refill })
    ok(!json.includes('f1') && !json.includes('"一"'), '已执行的条目不出现在发布与重建里')
    ok(calls.refill[0].followUp.length === 0, '当前队列被清空')
  }
  {
    const notice =
      '<subagent-notification id="s-1" status="done">\n子代理 s-1（只读）已完成：查日志\n完整过程：yan subagent get --id s-1\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。\n</subagent-notification>'
    const live = { steering: [], followUp: [item('f1', '一'), item('n1', notice)] }
    const next = { steering: [], followUp: [item('f1', '一改')] }
    const { port, calls } = makePort({ clearResults: [{ success: true, steering: [], followUp: ['一'] }] })
    const result = await applyQueueRewrite(port, live, next)
    ok(result.ok === true, '编辑照常完成')
    ok(calls.refill[0].followUp.map((i) => i.id).join(',') === 'f1,n1', '渲染端看不到的子代理通知不会被编辑顺手删掉')
  }

  process.stdout.write('\n▌ queue-edit：按 id 增量规划\n')
  {
    const live = { steering: [item('s1', '插话')], followUp: [item('f1', '一')] }
    const planned = planQueueRewrite(live, { steering: [], followUp: [item('ghost', '旧'), item('f1', '一改')] })
    ok(planned.steering.length === 0 && planned.followUp.map((i) => i.id).join(',') === 'f1', '未知 id 忽略，已知 id 沿用快照内容')
    ok(planned.followUp[0].text === '一改', '文本编辑生效')
    const duplicate = planQueueRewrite(live, { steering: [], followUp: [item('f1', '甲'), item('f1', '乙')] })
    ok(duplicate.followUp.length === 1 && duplicate.followUp[0].text === '甲', '重复 id 只取第一次')
  }

  process.stdout.write('\n▌ queue-edit：克隆隔离\n')
  {
    const clone = cloneQueue(original)
    clone.steering[0].text = '改了'
    clone.steering[0].images[0].data = 'changed'
    ok(original.steering[0].text === '插话', '克隆不共享文本')
    ok(original.steering[0].images[0].data === 'img', '克隆不共享图片对象')
  }
}

{
  process.stdout.write('\n▌ 样式依赖：新组件不引入 v2 全局样式 / 旧控件\n')
  const entry = fileURLToPath(
    new URL('../src/renderer/src/features/composer/QueueEditor.tsx', import.meta.url)
  )
  const result = checkV3StyleIsolation(entry)
  ok(result.violations.length === 0, `无禁止依赖（访问 ${result.visited} 个文件）`)
  ok(result.unresolved.length === 0, `无未解析本地依赖（${result.unresolved.map((u) => u.specifier).join(', ') || '0'}）`)
}

process.stdout.write(`\n${report.fail === 0 ? '✓' : '✗'} 通过 ${report.pass}，失败 ${report.fail}\n`)
if (report.fail > 0) {
  for (const label of failures) process.stdout.write(`  - ${label}\n`)
  process.exitCode = 1
}
