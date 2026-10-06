/**
 * 空会话里保存凭证（主进程会重启 pi）之后，界面要跟到重启后的新会话上。
 *
 * 一条还没有任何消息的会话没有落盘的会话文件，重启后的 pi 起在新会话上；
 * 以前界面停在已不存在的旧会话里，发消息、跑命令的输出都进不了视图（新用户第一次填 key 就会碰到）。
 * 用直执行 bash 验证：不经模型，不花额度。凭证写在隔离的数据目录里。
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
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(3000)
    const before = store.getState().session?.sessionId
    ok(store.getState().messages.length === 0, '起点：一条空会话')

    const saved = await window.yan.setApiKey('deepseek', 'sk-dummy-test-key')
    ok(saved.ok === true, '保存凭证成功（主进程随后重启 pi）')
    await sleep(1500)
    ok(await until(() => store.getState().conn === 'ready', 30000), '重启后连接恢复就绪')
    ok(
      await until(() => !!store.getState().session?.sessionId && store.getState().session?.sessionId !== before, 15000),
      '界面跟到了重启后的新会话（没有停在旧会话上）'
    )

    const ta = q('[data-testid="composer"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '!echo AFTER_RESTART_OK')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ok(await until(() => q('.msg.bash'), 15000), '重启后跑命令：对话里出现了命令行消息')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
