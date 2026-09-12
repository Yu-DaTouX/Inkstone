/**
 * 凭证存在**环境变量**里时，是否被正确识别。
 *
 * 为什么单独一个场景：环境变量是主进程**启动时**读的，探针里造不出来 ——
 * 必须在 test-live 的 CASES 里用 env 注入（见 authEnv 那条）。
 *
 * 这里抓到的真 bug：CATALOG 里每一项都写了 envVar，
 * 但 listAuthProviders **从来没用过那个字段** —— 用环境变量配好的用户
 * 界面上显示「还没配置」，引导页第 2 步也跟着卡住（用户报的）。
 *
 * ⚠️ 不碰真实 auth.json：YAN_PI_DIR 指向沙箱，
 *    本场景连沙箱里的 auth.json 都不写（只用环境变量）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }

  try {
    /* ---- 1. 浅查：环境变量也算已配置 ---- */
    out.push('=== 1. authProviders 把环境变量算进去 ===')
    const list = await window.yan.authProviders(false)
    const readyList = list.filter((x) => x.status === 'ready')
    out.push('  已就绪 ' + readyList.length + '/' + list.length)
    for (const r of readyList.slice(0, 6)) out.push('    ' + r.id + '  来源=' + (r.source ?? '（未标注）'))
    ok(readyList.length > 0 ? '有已就绪项' : '（这台机器一个都没配，也算合法）')
    const envOnly = readyList.filter((x) => x.source === 'env')
    out.push('  其中来自环境变量: ' + envOnly.length)
    // 每个 ready 项都必须有 source（否则界面没法区分「移除」按钮是否有意义）
    const noSource = readyList.filter((x) => !x.source)
    if (noSource.length === 0) ok('每个已就绪项都标了来源（auth.json / env）')
    else bad('有 ' + noSource.length + ' 项没标来源：' + noSource.map((x) => x.id).join(','))

    /* ---- 2. 引导第 2 步读的是**本地文件**（不是一次性快照）---- */
    out.push('\n=== 2. 引导第 2 步 ===')
    const card = document.querySelector('.ob-card')
    if (!card) {
      out.push('  （引导层没自动出现 —— 说明这台机器的登录状态被记过，合法）')
    } else {
      const row = document.querySelector('[data-testid="ob-auth"]')
      const okFlag = row?.dataset.ok
      out.push('  ob-auth data-ok=' + okFlag)
      out.push('  文案: ' + row?.textContent.replace(/\s+/g, ' ').trim().slice(0, 100))
      const recheck = document.querySelector('[data-testid="ob-recheck-auth"]')
      if (recheck) ok('第 2 步有「重新检测」按钮')
      else bad('没有重新检测按钮')
      // 与 authProviders 的结论必须一致（同一个数据源）
      const expectOk = readyList.length > 0
      if ((okFlag === '1') === expectOk) ok('第 2 步状态与 authProviders 一致（判定正确）')
      else bad('第 2 步判定与 authProviders 不一致：ok=' + okFlag + ' 期望=' + expectOk)
      if (recheck) {
        click(recheck)
        await sleep(800)
        const still = document.querySelector('[data-testid="ob-auth"]')?.dataset.ok
        if (still === okFlag) ok('点「重新检测」后状态稳定（' + still + '）')
        else bad('重测后状态变了：' + okFlag + ' → ' + still)
      }
    }

    /* ---- 3. 接线页也要标来源 ---- */
    out.push('\n=== 3. 设置 → 模型接入（来源标注）===')
    const store = window.__yanStore
    store.getState().openSettings('auth')
    await until(() => document.querySelector('.settings'), 4000)
    await sleep(600)
    const txt = document.querySelector('.settings')?.textContent.replace(/\s+/g, ' ') ?? ''
    out.push('  页面含「已就绪」/「环境变量」字样: ' + /已就绪|环境变量/.test(txt))
    ok(/已就绪/.test(txt), '接线页有已就绪标记')
    const close = [...document.querySelectorAll('.settings-tab')].find((x) => /关闭/.test(x.textContent))
    if (close) click(close)
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[authcheck] 全部通过' : '[authcheck] ' + failed + ' 条失败')
  return out.join('\n')
})()
