/**
 * 文件树（工具栏「文件」分区）。
 *
 * 覆盖的是「懒加载 + 点文件插 @路径」这条链。为什么值得单独一个场景：
 *   · 它是**主进程读文件系统**的路径，安全边界（不能跳出 cwd）必须有人守
 *   · 「点文件 = 插 @路径」而不是打开文件，这条约定很容易被后人改错
 *   · 长文件名/深路径在 264px 宽的工具栏里很容易横向溢出（本项目的老坑）
 *
 * ⚠️ 需要 cwd 有内容才有意义。test-live 会把 YAN_DATA_DIR 指到临时目录，
 *    所以这里**显式把 cwd 设成项目目录**，否则树是空的（断言会假通过）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore

  try {
    // 关引导层（轮询等它出现再关，不要假设它已经没了）
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) { click(btn); await sleep(300) } else await sleep(150)
    }

    /* ---- 0. 把 cwd 设成项目目录（否则树是空的，断言会假通过）---- */
    const cwd = store.getState().settings?.cwd ?? ''
    out.push('=== 0. 工作目录 ===')
    out.push('  cwd = ' + cwd)
    if (!/pi-desktop/i.test(cwd)) {
      bad('cwd 不是项目目录（' + cwd + '）—— 文件树没有可断言的内容')
      out.push('')
      out.push('[fs] 1 条失败')
      return out.join('\n')
    }
    ok('cwd 指向项目目录')

    /* ---- 1. 分区存在 + 根层加载 ---- */
    out.push('\n=== 1. 工具栏「文件」分区 ===')
    const sec = document.querySelector('[data-testid="rp-files"]')
    if (!sec) { bad('没有文件分区'); }
    else ok('有「文件」分区')

    const root = await until(() => document.querySelector('[data-testid="fs-row-root"]'), 6000)
    if (!root) bad('根行没出现')
    const rootRow = document.querySelector('[data-testid="fs-row-root"]')
    out.push('  根标签 = ' + (rootRow?.textContent.trim() ?? '?'))
    if (/pi-desktop/i.test(rootRow?.textContent ?? '')) ok('根显示项目名')

    const loaded = await until(() => qa('[data-testid="rp-files"] .rp-fs-row').length > 2, 6000)
    const rows = qa('[data-testid="rp-files"] .rp-fs-row')
    out.push('  根层条目 ' + (rows.length - 1) + ' 项')
    if (loaded) ok('根层懒加载回来了')
    else bad('根层是空的')

    /* ---- 2. 排序：目录在前 ---- */
    out.push('\n=== 2. 排序：目录优先 ===')
    const flags = rows.slice(1).map((r) => r.dataset.dir)
    const firstFile = flags.indexOf('0')
    const lastDir = flags.lastIndexOf('1')
    out.push('  前 12 项 = ' + rows.slice(1, 13).map((r) => r.dataset.path + (r.dataset.dir === '1' ? '/' : '')).join(' '))
    if (firstFile === -1 || lastDir === -1 || lastDir < firstFile) ok('所有目录都排在文件前面')
    else bad('目录/文件混排（目录应在最前）')

    /* ---- 3. 展开：缩进递增 + 子项加载 ---- */
    out.push('\n=== 3. 展开 src → src/main ===')
    for (const p of ['src', 'src/main']) {
      const row = qa('.rp-fs-row').find((r) => r.dataset.path === p)
      if (!row) { bad('找不到目录 ' + p); continue }
      click(row)
      const got = await until(() => {
        const depth = p.split('/').length
        return qa('.rp-fs-row').filter((r) => {
          const parts = r.dataset.path.split('/')
          return r.dataset.path.startsWith(p + '/') && parts.length === depth + 1
        }).length > 0
      }, 6000)
      const kids = qa('.rp-fs-row').filter((r) => {
        const parts = r.dataset.path.split('/')
        return r.dataset.path.startsWith(p + '/') && parts.length === p.split('/').length + 1
      })
      if (got) ok('展开 ' + p + ' → ' + kids.length + ' 个子项')
      else bad('展开 ' + p + ' 没加载出子项')
    }

    const pad = (p) => {
      const r = qa('.rp-fs-row').find((x) => x.dataset.path === p)
      return r ? parseFloat(getComputedStyle(r).paddingLeft) : -1
    }
    const a = pad('src'), b = pad('src/main'), c = pad('src/main/agent.ts')
    out.push('  padding-left: src=' + a + ' src/main=' + b + ' src/main/agent.ts=' + c)
    if (a > 0 && b > a && c > b) ok('层级缩进递增')
    else bad('缩进没递增')

    /* ---- 4. 点文件 → 插 @路径（而不是打开文件）---- */
    out.push('\n=== 4. 点文件 → 往输入框插 @路径 ===')
    const fileRow = qa('.rp-fs-row').find((r) => r.dataset.path === 'src/main/agent.ts')
    if (!fileRow) bad('找不到 src/main/agent.ts')
    else {
      const before = document.querySelector('textarea')?.value ?? ''
      click(fileRow)
      await sleep(400)
      const after = document.querySelector('textarea')?.value ?? ''
      out.push('  输入框 ' + JSON.stringify(before) + ' → ' + JSON.stringify(after))
      if (after.includes('@src/main/agent.ts')) ok('插入了 @src/main/agent.ts')
      else bad('没插入 @路径')
      if (fileRow.classList.contains('hot')) ok('被点的行有高亮反馈')
      else bad('没有高亮反馈')
      // 清空，别影响后面的场景
      const ta = document.querySelector('textarea')
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
      }
    }

    /* ---- 5. 隐藏项：文案是「已隐藏」+ 有开关能显示出来 ---- */
    out.push('\n=== 5. 隐藏项与开关 ===')
    const skipped = document.querySelector('[data-testid="fs-skipped"]')
    out.push('  提示文案 = ' + (skipped?.textContent.replace(/\s+/g, ' ').trim() ?? '（无）'))
    /*
     * 用户要求：把「已跳过」改成「已隐藏」。
     * 理由：「跳过」听起来像程序漏掉了内容，「隐藏」才是事实 ——
     * 上面的开关一开它们就出来（下面就地验证）。
     */
    if (skipped && /已隐藏/.test(skipped.textContent)) ok('文案是「已隐藏」（不是「已跳过」）')
    else bad('文案不对：应含「已隐藏」，实际 ' + JSON.stringify(skipped?.textContent))
    if (skipped && /\.git|node_modules/.test(skipped.textContent)) ok('列出了被隐藏的名字（不假装列全了）')
    else bad('没列出隐藏的名字')

    /* 开关：打开后隐藏项真的会出现，关回去又恢复 */
    const toggle = document.querySelector('[data-testid="fs-hidden-toggle"]')
    if (!toggle) bad('没有「显示隐藏项」开关')
    else {
      const rowsBefore = qa('[data-testid="rp-files"] .rp-fs-row').length
      click(toggle)
      /*
       * ⚠️ 不能断言「行数变了」—— 切开关会清缓存重拉，
       *    行数变化可能只是「展开的子目录被收起来了」。
       *    要断言的真正性质是：**被隐藏的那些条目现在在列表里**。
       */
      const appeared = await until(
        () =>
          qa('[data-testid="rp-files"] .rp-fs-row').some((r) => {
            const n = r.dataset.path ?? ''
            return n === '.gitignore' || n === 'node_modules' || n === '.git'
          }),
        6000
      )
      const names = qa('[data-testid="rp-files"] .rp-fs-row').map((r) => r.dataset.path)
      out.push('  开关后根层: ' + JSON.stringify(names.slice(0, 14)))
      if (appeared) ok('打开开关后 .gitignore / node_modules 真的出现在列表里')
      else bad('开关没起作用：列表里没有隐藏项（' + JSON.stringify(names.slice(0, 10)) + '）')
      if (!document.querySelector('[data-testid="fs-skipped"]')) ok('全部显示后不再有「已隐藏」提示')
      else out.push('  仍有提示: ' + document.querySelector('[data-testid="fs-skipped"]').textContent.replace(/\s+/g, ' '))
      // 关回去，别影响后面的断言
      click(toggle)
      const gone = await until(
        () => !qa('[data-testid="rp-files"] .rp-fs-row').some((r) => r.dataset.path === '.gitignore'),
        6000
      )
      if (gone) ok('关掉开关后 .gitignore 又消失（恢复隐藏）')
      else bad('关掉开关后隐藏项还在')
      void rowsBefore
    }

    /* ---- 6. 无横向溢出（工具栏只有 264px 宽，长名字很容易撑破）---- */
    out.push('\n=== 6. 溢出体检 ===')
    const over = qa('.rp-fs-row').filter((r) => r.scrollWidth > r.clientWidth + 1)
    out.push('  横向溢出的行：' + (over.length ? over.map((r) => r.dataset.path).join(', ') : '无'))
    if (!over.length) ok('没有行横向溢出')
    else bad(over.length + ' 行溢出')
    const box = document.querySelector('.rp-fs')
    out.push('  文件树 视口 ' + box.getBoundingClientRect().height.toFixed(0) + 'px / 内容 ' + box.scrollHeight + 'px（可滚=' + (box.scrollHeight > box.clientHeight) + '）')
    const body = document.querySelector('.rp-body').getBoundingClientRect().width
    const sec2 = sec.getBoundingClientRect().width
    out.push('  工具栏 body ' + body.toFixed(1) + '，文件分区 ' + sec2.toFixed(1))
    if (sec2 <= body + 1) ok('文件分区没有超出工具栏')
    else bad('文件分区溢出工具栏 ' + (sec2 - body).toFixed(1) + 'px')
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[fs] 全部通过' : '[fs] ' + failed + ' 条失败')
  return out.join('\n')
})()
