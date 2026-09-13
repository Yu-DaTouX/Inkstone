/**
 * 所有报错都要进日志模块（用户要求）。
 *
 * 做法（见 store.ts 的 set 包装）：只要 set 里新增了 type='error' 的通知，
 * 就同时往 logs 里追加一行 `[错误] ...`。
 * 这里用一个**必然失败**的操作触发错误通知，然后断言日志抽屉里有它。
 *
 * 不花 token。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(600)
  store.getState().closeSettings?.()
  await sleep(200)

  const before = store.getState().logs.length

  out.push('=== 触发一个必然失败的操作 ===')
  await store.getState().switchSession('Z:/yan-definitely-missing-session.jsonl')
  await sleep(400)

  const after = store.getState().logs
  out.push('  新增日志行: ' + JSON.stringify(after.slice(before).slice(-3)))
  const added = after.slice(before)
  ok(added.some((l) => l.startsWith('[错误]')), '失败操作被写进日志（[错误] ...）')

  out.push('')
  out.push('=== 日志模块可见 ===')
  const logSec = q('[data-testid="rp-log"]')
  const logCount = q('[data-testid="log-count"]')
  ok(!!logSec || !!logCount, '存在日志分区（rp-log）')
  // 展开日志分区后应能在正文里看到那条错误
  if (logSec) {
    const head = logSec.querySelector('.rp-sec-head')
    if (head && head.getAttribute('aria-expanded') === 'false') {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(300)
    }
    const body = q('[data-testid="log-body"]')?.textContent ?? ''
    ok(body.includes('[错误]'), '日志正文里能看到 [错误] 行')
  }

  return out.join('\n')
})()
