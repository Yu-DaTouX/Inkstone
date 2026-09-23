/*
 * 目标的产物 / 参考（实施-12 U-3b，cost 0，不调模型）。
 *
 * 写入通道只有 `yan goal report`（宿主 CLI），渲染进程没有第二个写入口 ——
 * 所以这一条验的是**读回来对不对 + 点下去说什么**：
 *   ① 真 IPC `getGoal()` 拿到的链接是宿主校验过的那几条；
 *   ② 面板把它们画出来，kind 标签正确；
 *   ③ 点一条**不存在**的文件：必须给出就地失败提示，不是静默、不是假装成功；
 *   ④ 全程没有 unhandled rejection。
 *
 * `url` 那条**不点** —— 它会真的拉起外部浏览器（不该在回归里发生）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const skip = (s) => out.push('  ~ ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const visible = (el) => el.getClientRects().length > 0

  let unhandled = 0
  const onUnhandled = () => {
    unhandled += 1
  }
  window.addEventListener('unhandledrejection', onUnhandled)

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40; i++) {
      if (window.__yanStore?.getState().conn === 'ready') break
      await sleep(500)
    }
    await sleep(1200)

    /* ---- ① 真 IPC 读回 ---- */
    /* 目标按会话索引：先确保有一个活动会话（fixture 的 8 份里随便哪一份都种了） */
    if (!window.__yanStore.getState().session?.path) {
      const first = (window.__yanStore.getState().sessions ?? []).find((s) => s.path)
      if (first?.path) {
        await window.__yanStore.getState().switchSession(first.path)
        for (let i = 0; i < 40; i++) {
          if (window.__yanStore.getState().session?.path) break
          await sleep(500)
        }
        await sleep(800)
      }
    }

    const viaIpc = await window.yan.getGoal()
    const links = viaIpc?.goal?.links ?? []
    const sess = window.__yanStore.getState().session
    out.push(`  当前会话 path=${sess?.path ?? '(空)'}`)
    out.push(`  getGoal(): goalId=${JSON.stringify(viaIpc?.goal?.goalId)} phase=${viaIpc?.goal?.phase} links=${links.length}`)
    out.push(`  getGoal() 返回 ${links.length} 条链接：${links.map((l) => `${l.kind}:${l.target}`).join('，')}`)
    ok(links.length === 3, '真 IPC 读回三条宿主校验过的链接')
    ok(
      links.every((l) => ['file', 'url', 'artifact'].includes(l.kind)) && links.every((l) => l.addedAt > 0),
      '每条都有合法 kind 与 addedAt'
    )
    if (links.length < 3) {
      skip('链接数不对，后面的展示与点击断言跳过（不改判为通过）')
      return out.join('\n')
    }

    /* ---- ② 面板展示 ---- */
    /* U-3a：目标改成标题栏入口 + 浮层（不再在工具页常驻）。 */
    q('[data-testid="goal-entry"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(600)
    const panel = q('[data-testid="goal-panel"]')
    ok(!!panel, '目标面板在')
    const rows = qa('[data-testid="goal-link-row"]').filter(visible)
    out.push(`  面板里的链接行 ${rows.length} 条（kind：${rows.map((r) => r.dataset.linkKind).join('，')}）`)
    ok(rows.length === 3, '三条链接都画出来了')
    ok(
      JSON.stringify(rows.map((r) => r.dataset.linkKind)) === JSON.stringify(['file', 'url', 'artifact']),
      'kind 标签与数据一致（顺序也一致）'
    )
    ok(
      rows.every((r) => (r.textContent ?? '').trim().length > 0),
      '每行都有可读标签（不是空按钮）'
    )
    /* A-1：宿主核验结果要画到界面上（哪条还在、哪条不在了） */
    const flags = rows.map((r) => r.dataset.linkOk)
    out.push(`  宿主核验标记：${rows.map((r, i) => `${r.dataset.linkKind}=${flags[i]}`).join('，')}`)
    ok(flags.includes('true'), '有核验通过的链接')
    ok(flags.includes('false'), '有核验失败的链接（不存在的文件）')
    ok(flags.filter((f) => f !== 'true' && f !== 'false').length === 0, '没有未核验的链接（宿主每次报告都会重算）')

    /* A-2：预算与停止原因要能看到（“为什么没继续”） */
    const budgetBox = q('[data-testid="goal-budget"]')
    const stopBox = q('[data-testid="goal-budget-stop"]')
    out.push(
      `  预算区：${JSON.stringify(budgetBox?.textContent?.trim() ?? null)}；停止原因：${JSON.stringify(stopBox?.textContent?.trim() ?? null)}`
    )
    ok(!!budgetBox, '预算行在（用户能看见自己设的上限）')
    ok((budgetBox?.textContent ?? '').includes('已用'), '用量显示的是真实数字，而不是“未知”搪塞')
    ok(!!stopBox && (stopBox.textContent ?? '').includes('预算'), '“为什么没继续”写清楚了')

    /* ---- ③ 点一个不存在的文件 → 就地失败提示 ---- */
    const fileRow = rows.find((r) => r.dataset.linkKind === 'file')
    if (fileRow) {
      ok(!q('[data-testid="goal-link-error"]'), '点击之前没有错误提示')
      fileRow.click()
      await sleep(1500)
      const err = q('[data-testid="goal-link-error"]')
      out.push(`  点击不存在的文件后：error=${JSON.stringify(err?.textContent?.trim() ?? null)} unhandled=${unhandled}`)
      ok(!!err, '打开失败有就地提示（不是静默、不是假装成功）')
    } else {
      skip('面板里没有 file 行，跳过失败反馈这一维')
    }

    ok(unhandled === 0, '全程没有 unhandled rejection')
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  } finally {
    window.removeEventListener('unhandledrejection', onUnhandled)
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[goallinks] 全部通过' : '[goallinks] ' + failed + ' 条失败')
  return out.join('\n')
})()
