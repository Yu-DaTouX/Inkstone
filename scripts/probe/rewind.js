/**
 * 回退代码确认框：能打开、对不存在的检查点明确报错、Esc 关闭。
 * 真实回退逻辑在 test-checkpoints.mjs（真 git、临时目录）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'

  ok(!q('[data-testid="rewind-dialog"]'), '默认没有回退确认框')
  store.getState().openRewind('no-such-checkpoint', '把登录页的按钮改成蓝色')
  await sleep(700)
  const dialog = q('[data-testid="rewind-dialog"]')
  ok(!!dialog, 'openRewind 打开确认框')
  ok(!!dialog && dialog.textContent.includes('把登录页的按钮改成蓝色'), '确认框里写明是哪一句话')
  ok(!!dialog && /找不到这个检查点|没有活动会话/.test(dialog.textContent), '检查点不存在：明确报错而不是空白')
  ok(!q('[data-testid="rewind-confirm"]'), '出错时没有「回退代码」确认按钮')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(300)
  ok(!q('[data-testid="rewind-dialog"]'), 'Esc 关闭')
  return out.join('\n')
})()
