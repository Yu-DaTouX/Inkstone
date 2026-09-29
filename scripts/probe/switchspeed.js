/*
 * 切换会话耗时：逐个切到列表里的会话，量「点击 → 第一批消息画出来」与「peek IPC」两段。
 * 只测量不断言，按文件大小从大到小，用于改动前后对比。
 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  for (let i = 0; i < 80 && store.getState().conn !== 'ready'; i++) await sleep(250)
  await sleep(1500)
  const all = store.getState().sessions
  out.push('  列表共 ' + all.length + ' 条；含大会话副本：' + all.filter((x) => /01a0e24a|01a0e353|01a0d65b/.test(x.path)).length)
  const big = all.filter((x) => /01a0e24a|01a0e353|01a0d65b/.test(x.path))
  const list = [...big, ...all.filter((x) => !big.includes(x))].slice(0, 6)
  out.push('=== 切换会话耗时（按文件大小降序）===')
  for (const s of list) {
    const mb = ((s.size ?? 0) / 1048576).toFixed(1)
    const p0 = performance.now()
    const peek = await window.yan.peekSession(s.path).catch(() => null)
    const peekMs = Math.round(performance.now() - p0)
    const t0 = performance.now()
    await store.getState().switchSession(s.path)
    const switchMs = Math.round(performance.now() - t0)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const paintMs = Math.round(performance.now() - t0)
    const mk = (n) => performance.getEntriesByName(n).slice(-1)[0]?.startTime ?? 0
    const seg = 'peek=' + Math.round(mk('yan:switch-peeked') - mk('yan:switch-start')) + ' 内容上屏=' + Math.round(mk('yan:switch-painted') - mk('yan:switch-start')) + ' select=' + Math.round(mk('yan:switch-selected') - mk('yan:switch-peeked'))
    const rows = document.querySelectorAll('.stream .msg').length
    out.push(`  ${mb.padStart(5)}MB  peekIPC=${String(peekMs).padStart(5)}ms  switch=${String(switchMs).padStart(5)}ms  首帧=${String(paintMs).padStart(5)}ms  消息=${peek?.messages?.length ?? '?'} 渲染节点=${rows}  [${seg}]  ${(s.title || '').slice(0, 20)}`)
    await sleep(600)
  }
  return out.join('\n')
})()
