;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }

  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  const queueSnapshot = () => JSON.stringify(store.getState().queue)
  const notices = () => (store.getState().notices || []).slice()
  const textOf = (list) => list.map((n) => `${n.type}:${n.text}`).join(' | ')
  const withTimeout = (p, ms = 8000) =>
    Promise.race([Promise.resolve(p), sleep(ms).then(() => '（超时）')])

  const retract = async (id) => {
    const before = notices().length
    let timedOut = false
    try {
      const r = await withTimeout(store.getState().removeQueued(id))
      timedOut = r === '（超时）'
    } catch (e) {
      return { timedOut: false, fresh: [], threw: e && e.message ? e.message : String(e) }
    }
    return { timedOut, fresh: notices().slice(before) }
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(250)
      } else await sleep(120)
    }

    let ready = false
    for (let i = 0; i < 30; i++) {
      if (store.getState().conn === 'ready') {
        ready = true
        break
      }
      await sleep(500)
    }
    if (!ready) return early(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的问一次主进程`)

    out.push('=== 0. 环境 ===')
    out.push('  队列 = ' + queueSnapshot())
    ok(typeof store.getState().removeQueued === 'function', 'store 暴露了 removeQueued')

    out.push('')
    out.push('=== 1. 撤回一个 pi 里不存在的 id（= 刚被消费那条分支） ===')
    const before1 = queueSnapshot()
    const r1 = await retract('n09-does-not-exist')
    out.push('  新增通知 = ' + JSON.stringify(textOf(r1.fresh)))
    ok(!r1.threw, '调用没有抛错', r1.threw ?? '')
    ok(!r1.timedOut, '调用在超时前返回（没有卡住队列操作）')
    ok(
      r1.fresh.some((n) => n.type === 'error' && /无法撤回|已被接收/.test(n.text)),
      '界面给出明确错误（不是静默失败）'
    )
    ok(
      !r1.fresh.some((n) => n.type === 'info' && /已撤回/.test(n.text)),
      '没有谎报“已撤回”'
    )
    ok(store.getState().queueRestore === null, '没有把任何文本塞回输入草稿（queueRestore 仍为空）')
    ok(queueSnapshot() === before1, '队列快照没被这次失败改掉')

    out.push('')
    out.push('=== 2. 连续撤回两次同一个 id ===')
    const before2 = queueSnapshot()
    const r2a = await retract('n09-twice')
    const r2b = await retract('n09-twice')
    out.push('  第一次通知 = ' + JSON.stringify(textOf(r2a.fresh)))
    out.push('  第二次通知 = ' + JSON.stringify(textOf(r2b.fresh)))
    ok(!r2a.timedOut && !r2b.timedOut, '两次都在超时前返回（幂等，不互相卡死）')
    const fresh2 = [...r2a.fresh, ...r2b.fresh]
    ok(
      fresh2.every((n) => !/已撤回/.test(n.text)),
      '两次都没有谎报“已撤回”'
    )
    out.push('  两次合计新增通知 ' + fresh2.length + ' 条（同文案 8 秒内去重，属预期）')
    ok(store.getState().queueRestore === null, '草稿没被写入')
    ok(queueSnapshot() === before2, '队列快照没变（没有连带清掉别的项）')

    out.push('')
    out.push('=== 3. 同时撤回两条（主进程的 queueRun 串行化） ===')
    const before3 = queueSnapshot()
    const t0 = Date.now()
    const [r3a, r3b] = await Promise.all([retract('n09-par-a'), retract('n09-par-b')])
    const elapsed = Date.now() - t0
    out.push('  耗时 = ' + elapsed + 'ms，通知 = ' + JSON.stringify(textOf([...r3a.fresh, ...r3b.fresh])))
    ok(!r3a.timedOut && !r3b.timedOut, '两个并发调用都在超时前返回（串行化生效，没有互锁）')
    ok(
      [...r3a.fresh, ...r3b.fresh].every((n) => !/已撤回/.test(n.text)),
      '没有谎报“已撤回”'
    )
    ok(store.getState().queueRestore === null, '草稿没被写入')
    ok(queueSnapshot() === before3, '队列快照没变')
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[queueretract] 全部通过' : '[queueretract] ' + failed + ' 条失败')
  return out.join('\n')
})()
