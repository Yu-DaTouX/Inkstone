/**
 * shell / 第三方工具的**变更归属**（L05）——真实窗口、真实 shell、不调模型。
 *
 * 为什么能 cost 0：砚有一条**不经模型**的直执行 shell 通道
 * （`window.yan.runBash` → pi 的 `bash` RPC），它改的就是会话工作目录。
 * 走它就能在真实进程、真实文件系统上验证“这条命令改了哪些文件”，
 * 而不需要让模型生成任何东西。
 *
 * 覆盖的边界（每一条都能让界面说谎，所以逐条钉）：
 *   · 新建 / 追加 / 删除 → created / modified / deleted，行数与 patch 对得上；
 *   · 什么都不改 → 不挂改动卡片（不是“0 个改动”的噪音）；
 *   · 改依赖目录（node_modules）→ 不算用户改动；
 *   · 大文件等长改写 → unknown（没读内容就不说“内容变了”）；
 *   · 同目录并发 → 两边都不认领（标 concurrent）。
 */
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

  /** 跑一条直执行命令并等它结束，返回它那条消息里的 toolCall（含 details） */
  const runBash = async (command, waitMs = 20000) => {
    const res = await window.yan.runBash(command)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(150)
      const msgs = store.getState().messages.filter((m) => m.role === 'bash')
      const last = msgs[msgs.length - 1]
      const call = last && last.toolCalls && last.toolCalls[0]
      if (last && call && call.status !== 'running' && call.status !== 'pending') {
        return { res, call, output: last.text }
      }
    }
    return { res, call: null, output: '' }
  }

  /** 一条命令带来的目录改动（没有卡片就是 null） */
  const changesOf = (call) => (call && call.details ? call.details.workspaceChanges : undefined) ?? null
  const findFile = (wc, path) => (wc && wc.files ? wc.files.find((f) => f.path === path) : undefined)

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
    if (!ready) return early(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），本场景要真的跑 shell`)
    await sleep(600)

    const NODE = 'node -e'

    /* ---------------------------------------------------------- 1. 新建 */
    out.push('=== 1. 新建文件 ===')
    const created = await runBash(`${NODE} "require('fs').writeFileSync('ws-probe-a.txt','one\\n')"`)
    ok(created.res.ok === true, '命令执行成功', JSON.stringify(created.res))
    const wc1 = changesOf(created.call)
    out.push('  改动卡片 = ' + JSON.stringify(wc1))
    ok(!!wc1, '给出了改动卡片')
    const f1 = findFile(wc1, 'ws-probe-a.txt')
    ok(!!f1, '列出新建的文件', JSON.stringify(wc1 && wc1.files))
    ok(f1 && f1.status === 'created', '状态是 created', f1 && f1.status)
    ok(f1 && f1.added === 1, '新增 1 行（读了内容才敢给行数）', String(f1 && f1.added))
    ok(!!(f1 && f1.patch), '给了逐行 patch', JSON.stringify((f1 && f1.patch) || '').slice(0, 60))
    ok(!wc1.unknown, '没有标“无法归属”', String(wc1 && wc1.unknown))

    /* ---------------------------------------------------------- 2. 追加 */
    out.push('')
    out.push('=== 2. 修改已有文件 ===')
    const modified = await runBash(`${NODE} "require('fs').appendFileSync('ws-probe-a.txt','two\\n')"`)
    const wc2 = changesOf(modified.call)
    const f2 = findFile(wc2, 'ws-probe-a.txt')
    out.push('  改动卡片 = ' + JSON.stringify(wc2 && wc2.files))
    ok(f2 && f2.status === 'modified', '状态是 modified', f2 && f2.status)
    ok(f2 && f2.added >= 1, '给出新增行数', String(f2 && f2.added))
    ok(f2 && f2.beforeSize > 0 && f2.afterSize > f2.beforeSize, '前后大小都对（不是编的）', `${f2 && f2.beforeSize} → ${f2 && f2.afterSize}`)

    /* --------------------------------------------------- 3. 什么都不改 */
    out.push('')
    out.push('=== 3. 什么都不改的命令 ===')
    const idle = await runBash(`${NODE} "console.log('ok')"`)
    const wc3 = changesOf(idle.call)
    ok(wc3 === null || wc3.total === 0, '不挂“0 个改动”的卡片（没有噪音）', JSON.stringify(wc3))
    if (wc3) {
      ok(wc3.scanned > 0, '确实扫过目录（“没改”是结论，不是没扫）', String(wc3.scanned))
    }

    /* ------------------------------------------------- 4. 依赖目录不算 */
    out.push('')
    out.push('=== 4. 依赖目录里的改动 ===')
    const dep = await runBash(
      `${NODE} "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/ws-dep.js','x\\n')"`
    )
    const wc4 = changesOf(dep.call)
    const depHit = wc4 && wc4.files.some((f) => f.path.startsWith('node_modules/'))
    out.push('  改动卡片 = ' + JSON.stringify(wc4))
    ok(!depHit, 'node_modules 里的改动不会被当成用户改动', JSON.stringify(wc4 && wc4.files))

    /* ------------------------------------------------------ 5. 删除 */
    out.push('')
    out.push('=== 5. 删除文件 ===')
    const removed = await runBash(`${NODE} "require('fs').unlinkSync('ws-probe-a.txt')"`)
    const wc5 = changesOf(removed.call)
    const f5 = findFile(wc5, 'ws-probe-a.txt')
    out.push('  改动卡片 = ' + JSON.stringify(wc5 && wc5.files))
    ok(f5 && f5.status === 'deleted', '状态是 deleted', f5 && f5.status)
    ok(f5 && f5.afterSize === -1, '删除后大小写 -1（没有的东西不编大小）', String(f5 && f5.afterSize))

    /* -------------------------------------------- 6. 大文件等长改写 */
    out.push('')
    out.push('=== 6. 大文件（没读内容） ===')
    await runBash(`${NODE} "require('fs').writeFileSync('ws-big.bin','a'.repeat(300000))"`)
    const big = await runBash(`${NODE} "require('fs').writeFileSync('ws-big.bin','b'.repeat(300000))"`)
    const wc6 = changesOf(big.call)
    const f6 = findFile(wc6, 'ws-big.bin')
    out.push('  改动卡片 = ' + JSON.stringify(f6))
    ok(!!f6, '大文件的改动仍然被记录（不是忽略）', JSON.stringify(wc6 && wc6.files))
    ok(f6 && f6.status === 'unknown', '等长改写只能给 unknown（没读内容就不说内容变了）', f6 && f6.status)
    ok(f6 && f6.added === -1 && f6.patch === '', '行数与 patch 如实留空（-1 / 空串）', JSON.stringify(f6))
    await runBash(`${NODE} "require('fs').unlinkSync('ws-big.bin')"`)

    /* ------------------------------------------ 7. 界面真的渲染出来 */
    out.push('')
    out.push('=== 7. 工具行里的改动卡片 ===')
    const made = await runBash(`${NODE} "require('fs').writeFileSync('ws-probe-ui.txt','ui\\n')"`)
    const callId = made.call && made.call.id
    /* 展开那条工具行：卡片只在展开后渲染 */
    const rows = [...document.querySelectorAll('[data-testid="tool-row"]')]
    let card = null
    for (let i = 0; i < 25 && !card; i++) {
      const row = rows.find((r) => r.closest('.trow') && r.getAttribute('aria-expanded') !== 'true' && /ws-probe-ui\.txt/.test(r.textContent || ''))
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
      card = document.querySelector('[data-testid="workspace-changes"]')
    }
    ok(!!card, '展开后能看到改动卡片', callId ? 'callId=' + callId : '')
    if (card) {
      const title = card.querySelector('[data-testid="ws-title"]')
      out.push('  卡片标题 = ' + JSON.stringify(title && title.textContent))
      ok(/(1|一)\s*个文件|1 file/.test(title ? title.textContent || '' : ''), '标题写出改动文件数')
      ok(/ws-probe-ui\.txt/.test(card.textContent || ''), '卡片里列出了文件名')
      ok(!card.querySelector('[data-testid="ws-unknown"]'), '正常归属时不显示“无法归属”提示')
    }
    await runBash(`${NODE} "require('fs').unlinkSync('ws-probe-ui.txt')"`)
    await runBash(`${NODE} "require('fs').rmSync('node_modules',{recursive:true,force:true})"`)

    /*
     * -------------------------- 8. 同 cwd 第二个实例（并发共用目录的防线）
     *
     * L05 反复强调“不重复认领同一差异”。砚的做法是**不让两个忙碌实例共用
     * 一个工作目录**（L03 既定策略）—— 所以这里验的就是那道防线：
     * 一个实例正在跑 shell 时，切到**同 cwd** 的另一个会话必须被明确拒绝，
     * 而不是默默开第二个实例、两边各自把同一批改动算到自己头上。
     *
     * 副作用（已修）：直执行 shell 原本不算“忙”，于是切换会复用到同一个
     * 实例，新会话里直接报“已有一条命令在跑”—— 用户看着像卡死。
     */
    out.push('')
    out.push('=== 8. 同 cwd 第二个实例 ===')
    const cwdNow = (store.getState().session && store.getState().session.cwd) || ''
    const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    const here = (store.getState().sessions || []).find((s) => s.path === (store.getState().session && store.getState().session.path))
    const sameCwdPeers = (store.getState().sessions || []).filter((s) => s !== here && norm(s.cwd) === norm(cwdNow))
    const elsewhere = (store.getState().sessions || []).find((s) => s !== here && norm(s.cwd) !== norm(cwdNow))
    out.push(
      '  当前 cwd = ' + JSON.stringify(cwdNow) + ' · 同 cwd 其它会话 = ' + JSON.stringify(sameCwdPeers.map((s) => s.title))
    )
    if (!sameCwdPeers.length) {
      out.push('  ⤺ 跳过：没有同 cwd 的第二个会话（需要 projectSessions fixture）')
    } else {
      const slow = window.yan.runBash(`${NODE} "setTimeout(()=>{},6000)"`).catch(() => ({ ok: false }))
      await sleep(900)
      const denied = await window.yan.switchSession(sameCwdPeers[0].path)
      out.push('  切到同 cwd 会话的返回 = ' + JSON.stringify(denied))
      ok(denied && denied.ok === false, '同 cwd 已有实例在跑 shell 时，切换被拒绝', JSON.stringify(denied))
      ok(
        !denied || /同一工作目录|工作目录已有/.test(String(denied.error || '')),
        '拒绝理由写清是“同一工作目录已有运行中的会话”',
        String(denied && denied.error)
      )
      /* 被拒绝不能把第一条命令弄坏：它仍应正常跑完 */
      const slowRes = await slow
      ok(slowRes && slowRes.ok === true, '被拒后原会话的命令不受影响（继续跑完）', JSON.stringify(slowRes))

      if (elsewhere) {
        const moved = await window.yan.switchSession(elsewhere.path)
        out.push('  切到**别的目录**的会话 = ' + JSON.stringify(moved))
        ok(moved && moved.ok === true, '换一个工作目录仍然能切（拒绝只针对同 cwd）', JSON.stringify(moved))
        /* 切回原会话，后面的清理命令才不会落到别处 */
        if (here) await window.yan.switchSession(here.path)
      }
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[workspacechanges] 全部通过' : '[workspacechanges] ' + failed + ' 条失败')
  return out.join('\n')
})()
