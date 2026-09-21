/**
 * 文件树边界（L02）——在**合成 fixture 项目**上跑（`cwd` 由 test-live 指向它）。
 *
 * 为什么单独一个场景：`fs` 场景在源码树上跑，只能证明“能用的路径能用”；
 * 这里要把「容易出错、源码树里造不出来」的那几类一次性钉死：
 *   · 空目录     —— 必须给出「空」的明确状态，而不是空白行或错误
 *   · 失效/错型  —— 目录不存在、把文件当目录，主进程要报 missing 而不是空列表
 *   · 越界       —— `../..` 必须 invalid
 *   · 目录联接   —— 不跟随（不成为可展开路径），但要出现在「已隐藏」名单里
 *   · 多级 / 中文空格 / 同名文件 —— 真实文件系统上的身份与渲染
 *   · 大目录     —— 界面 50 一批分页（`fs-more`），不是一次性铺满
 *   · 无权限目录 —— 真 ACL 拒绝读取：主进程给 `permission`、界面给「无权限」而不是「空」
 *   · 窄右栏     —— `PANEL_MIN=220` 下行不横溢、超长名省略但 `title` 给全文、分页仍可用
 *   · 浏览器共存 —— 右栏上半原生浏览器视图时，下半文件树不重叠、不被挤掉
 *
 * 探针**不做**的事：不写文件、不删文件（fixture 由 test-live 造好，
 * 临时目录，跑完整批删除）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
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
  const rowsOf = () => qa('[data-testid="rp-files"] .rp-fs-row')
  const rowOf = (path) => rowsOf().find((r) => r.dataset.path === path)
  const rowsUnder = (prefix) => rowsOf().filter((r) => (r.dataset.path ?? '').startsWith(prefix))

  try {
    /* 关引导层（与 fs 场景同一套做法） */
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) {
        click(btn)
        await sleep(300)
      } else await sleep(150)
    }

    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
    out.push('=== 0. fixture 工作目录 ===')
    out.push('  cwd = ' + cwd)
    if (!/fixture-project$/i.test(cwd.replace(/[\\/]+$/, ''))) {
      ok(false, 'cwd 不是合成 fixture 项目（test-live 的 fixture: true 没生效）')
      out.push('')
      out.push('[fsedge] 1 条失败')
      return out.join('\n')
    }
    ok(true, 'cwd 指向合成 fixture 项目')

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 1. 主进程 listDir 的边界（真实文件系统） ===')
    const L = (rel, hidden) => window.yan.listDir(rel, hidden === true)

    const empty = await L('empty')
    ok(empty.status === 'empty', '空目录返回 empty（不是 error / 不是假条目）', `status=${empty.status}`)
    ok(Array.isArray(empty.entries) && empty.entries.length === 0, '空目录的条目数组是空的')

    const missing = await L('gone')
    ok(missing.status === 'missing', '不存在的目录返回 missing', `status=${missing.status}`)

    const notdir = await L('notadir.txt')
    ok(notdir.status === 'missing', '把文件当目录打开返回 missing（ENOTDIR）', `status=${notdir.status}`)

    const escaped = await L('../..')
    ok(escaped.status === 'invalid', '越界路径（../..）被拒绝', `status=${escaped.status}`)

    const deep = await L('deep/a/b/c/d/e')
    ok(
      deep.status === 'ok' && deep.entries.some((e) => e.name === 'f.txt'),
      '多级路径能列出末端内容',
      JSON.stringify(deep.entries.map((e) => e.name))
    )

    const uni = await L('uni/中文 目录')
    ok(
      uni.status === 'ok' && uni.entries.some((e) => e.name === '文件 名.ts'),
      '中文 + 空格的目录能列出',
      JSON.stringify(uni.entries.map((e) => e.name))
    )

    const big = await L('big')
    ok(big.entries.length === 60, '大目录一次列全 60 项', `entries=${big.entries.length}`)
    ok(big.truncated === false, '60 项没有触发 400 条硬截断')

    const rootList = await L('')
    const rootNames = rootList.entries.map((e) => e.name)
    out.push('  根层 = ' + JSON.stringify(rootNames))
    ok(
      !rootNames.includes('junction-dir') && !rootNames.includes('junction-file'),
      '目录联接 / 文件链接不出现在可展开条目里'
    )
    const linkName = 'junction-dir'
    const linkSkipped = rootList.skipped.includes(linkName)
    if (rootList.skipped.length === 0) {
      out.push('  ⤺ 跳过：这台机器没建出链接（Windows 需要开发者模式/junction 权限）')
    } else {
      ok(linkSkipped, '被跳过的链接出现在「已隐藏」名单里（不假装它不存在）', JSON.stringify(rootList.skipped))
    }

    /* 排序：目录全部在文件之前（这是列表的既定语义，不是巧合） */
    const firstFileIdx = rootList.entries.findIndex((e) => !e.dir)
    const lastDirIdx = rootList.entries.map((e) => e.dir).lastIndexOf(true)
    ok(
      firstFileIdx === -1 || lastDirIdx < firstFileIdx,
      '目录全部排在文件之前（排序规则）',
      `lastDir=${lastDirIdx} firstFile=${firstFileIdx}`
    )

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 2. 界面：大目录分页（50 一批） ===')
    const rootReady = await until(() => rowsOf().length > 2, 8000)
    ok(rootReady, '根层懒加载回来了')
    const rootRow = q('[data-testid="fs-row-root"]')
    ok(/fixture-project/i.test(rootRow?.textContent ?? ''), '根行显示 fixture 项目名', rootRow?.textContent?.trim())

    const rootCount = rowsOf().length - 1 /* 根行自己 */
    const bigRow = rowOf('big')
    if (!bigRow) {
      ok(false, '找不到 big 目录行')
    } else {
      click(bigRow)
      const gotBatch = await until(() => rowsUnder('big/').length > 0, 8000)
      const firstBatch = rowsUnder('big/').length
      /*
       * 预算怎么算（2026-09-19 修）：
       *
       * 产品的语义是「**当前渲染的总行数**不超过一批（50）」—— 展开 big 时树会收起
       * 兄弟目录，所以“已用额度”不等于“根层项数”。原来的期望写成 `50 - 1 - 根层项数`，
       * 于是在根层 18 项时算出 31，而产品实际渲染 48 行（48 + 根行 + big 行 = 50，正好一批）。
       * 改成：先数**展开后**的非 big 行，期望 = 50 − 它们；并直接钉住总行数 = 50。
       * 这两条一起才能守住“一次性铺满 60 行”这类真缺陷（那时总行数会 > 50）。
       */
      const nonBigRows = rowsOf().filter((r) => !(r.dataset.path ?? '').startsWith('big/')).length
      const expectedFirstBatch = Math.max(0, 50 - nonBigRows)
      const more = q('[data-testid="fs-more"]')
      out.push(
        `  根层 ${rootCount} 项 → 展开 big 后首次渲染 ${firstBatch} 行（非 big 已占 ${nonBigRows} 行，预算 ${expectedFirstBatch}）`
      )
      ok(gotBatch && firstBatch === expectedFirstBatch, '大目录首屏只渲染剩余额度内的行（50 一批）', `${firstBatch}/${expectedFirstBatch}`)
      ok(rowsOf().length === 50, '展开后总渲染行数正好是一批（50）', String(rowsOf().length))
      ok(firstBatch < 60, '没有一次性铺满 60 行')
      ok(!!more, '超出一批时出现「显示更多」按钮')
      if (more) {
        const beforePaths = rowsOf().map((r) => r.dataset.path)
        const renderedBefore = beforePaths.length
        /*
         * 用键盘激活（Enter）而不是 click：按钮在这批之后会**卸载** ——
         * 焦点必须交给新露出的第一行，否则会掉到 body（N22-4 的焦点恢复断言）。
         */
        more.focus()
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        click(more) // 探针里的 click 只是兜底（真实按钮对 Enter 也会触发 click）
        const expanded = await until(() => rowsUnder('big/').length === 60, 4000)
        ok(expanded, '点「显示更多」后补上剩余行', `${rowsUnder('big/').length}/60`)
        await until(() => !q('[data-testid="fs-more"]'), 3000)
        ok(!q('[data-testid="fs-more"]'), '全部渲染完之后「显示更多」消失')
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const afterPaths = rowsOf().map((r) => r.dataset.path)
        /*
         * 焦点断言只钉两条性质，不钉"具体哪一行"：
         *   ① 焦点还在树里的行上（按钮卸载后不许掉到 body）；
         *   ② 它是这一批**新露出**的行（不是又跳回旧行）。
         * 具体落点（实现里是 `allVisiblePaths[visibleLimit]`，即额度边界那一行）
         * 会随"已缓存但未渲染"的行数变化 —— 钉死行号会让断言在别的 fixture 上假失败。
         */
        const focused = document.activeElement
        const focusedPath = focused?.dataset?.treePath ?? ''
        const stillRow = focused?.classList?.contains('rp-fs-row') === true
        ok(stillRow, '「显示更多」消失后焦点仍在文件树的行上（不是 body）', focusedPath || focused?.tagName || 'null')
        ok(
          !!focusedPath && !beforePaths.includes(focusedPath),
          '焦点落在这一批新露出的行上',
          `${focusedPath || '?'}（此前渲染 ${renderedBefore} 行）`
        )
      }
    }
    /* 收起 big，避免占用后面的渲染额度 */
    const bigRowAgain = rowOf('big')
    if (bigRowAgain) click(bigRowAgain)
    await until(() => rowsUnder('big/').length === 0, 3000)

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 3. 界面：空目录 / 多级 / 中文空格 ===')
    const emptyRow = rowOf('empty')
    if (emptyRow) {
      click(emptyRow)
      const shown = await until(() => !!q('[data-testid="fs-empty"]'), 5000)
      out.push('  空目录提示 = ' + JSON.stringify(q('[data-testid="fs-empty"]')?.textContent?.trim() ?? ''))
      ok(shown, '空目录展开后给出明确的「空」状态')
    } else {
      ok(false, '找不到 empty 目录行')
    }

    const chain = ['deep', 'deep/a', 'deep/a/b', 'deep/a/b/c', 'deep/a/b/c/d']
    let chainOk = true
    for (const dir of chain) {
      const row = rowOf(dir)
      if (!row) {
        chainOk = false
        ok(false, `逐层展开时找不到 ${dir}`)
        break
      }
      click(row)
      const child = await until(() => rowsUnder(dir + '/').length > 0, 5000)
      if (!child) {
        chainOk = false
        ok(false, `${dir} 展开后没有子项`)
        break
      }
    }
    if (chainOk) {
      const leaf = rowOf('deep/a/b/c/d/e')
      if (leaf) {
        click(leaf)
        const got = await until(() => !!rowOf('deep/a/b/c/d/e/f.txt'), 5000)
        ok(got, '五级目录可以逐层展开到文件')
      } else {
        ok(false, '找不到第五级目录 deep/a/b/c/d/e')
      }
      const pads = ['deep', 'deep/a', 'deep/a/b', 'deep/a/b/c']
        .map((p) => (rowOf(p) ? parseFloat(getComputedStyle(rowOf(p)).paddingLeft) : -1))
      ok(
        pads.every((v, i) => v > 0 && (i === 0 || v > pads[i - 1])),
        '深层的缩进逐级递增',
        JSON.stringify(pads)
      )
    }

    const uniDir = rowOf('uni')
    if (uniDir) {
      click(uniDir)
      await until(() => !!rowOf('uni/中文 目录'), 5000)
      const cnDir = rowOf('uni/中文 目录')
      if (cnDir) {
        click(cnDir)
        const gotFile = await until(() => !!rowOf('uni/中文 目录/文件 名.ts'), 5000)
        ok(gotFile, '中文 + 空格的目录能展开到文件')
        const cnFile = rowOf('uni/中文 目录/文件 名.ts')
        if (cnFile) {
          click(cnFile)
          const preview = await until(() => !!q('[data-testid="file-preview"]'), 6000)
          ok(preview, '中文空格路径的文件能打开只读预览')
          const body = q('[data-testid="file-preview-body"]')
          ok(/中文/.test(body?.textContent ?? ''), '预览读到的是这个文件的内容')
          store.getState().closePreview()
        }
      } else {
        ok(false, '找不到中文目录行')
      }
    } else {
      ok(false, '找不到 uni 目录行')
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 4. 同名文件：身份按完整路径区分 ===')
    store.getState().clearAttachments()
    for (const dir of ['dup', 'dup/one', 'dup/two']) {
      const row = rowOf(dir)
      if (row) {
        click(row)
        await sleep(250)
      }
    }
    const sameRows = rowsOf().filter((r) => (r.dataset.path ?? '').endsWith('/same.ts'))
    out.push('  同名行 = ' + JSON.stringify(sameRows.map((r) => r.dataset.path)))
    ok(sameRows.length === 2, '两个同名文件都在树里')
    ok(new Set(sameRows.map((r) => r.dataset.path)).size === 2, '它们按完整路径区分（不是同一项）')

    for (const p of ['dup/one/same.ts', 'dup/two/same.ts']) {
      const add = qa('[data-testid^="fs-add-"]').find((b) => b.dataset.testid === 'fs-add-' + p)
      if (add) click(add)
      await sleep(200)
    }
    const attached = store.getState().attachments.filter((a) => a.name === 'same.ts')
    out.push('  附件路径 = ' + JSON.stringify(attached.map((a) => a.path)))
    ok(attached.length === 2, '两个同名文件可以各自加入上下文（互不覆盖）')
    ok(new Set(attached.map((a) => a.path)).size === 2, '附件里也按完整路径区分')
    store.getState().clearAttachments()
    store.getState().closePreview()

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 5. 溢出体检（中文长名字） ===')
    const over = rowsOf().filter((r) => r.scrollWidth > r.clientWidth + 1)
    out.push('  横向溢出的行：' + (over.length ? over.map((r) => r.dataset.path).join(', ') : '无'))
    ok(over.length === 0, '没有行横向溢出')
    const skippedNow = q('[data-testid="fs-skipped"]')
    if (skippedNow) {
      ok(/junction-dir/.test(skippedNow.textContent), '界面「已隐藏」提示里列出了被跳过的链接')
    } else {
      out.push('  ⤺ 跳过：界面上没有「已隐藏」提示（这台机器没建出链接）')
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 6. 无权限目录（真实 ACL：deny 当前用户读取） ===')
    /*
     * 这一条不能用 mock：要的正是 Node/Windows 在**真的**读不到目录时
     * 主进程返回什么、界面又显示什么。fixture 用 `icacls /deny ...(RD)`
     * 造出来；造不出来的机器（非 NTFS / 改不了 DACL）降级为「跳过」。
     */
    const noperm = await L('noperm')
    out.push(`  listDir('noperm') → status=${noperm.status} entries=${noperm.entries.length}`)
    if (noperm.status === 'ok') {
      out.push('  ⤺ 跳过：这台机器没能建出无权限目录（icacls deny RD 未生效）')
    } else {
      ok(
        noperm.status === 'permission',
        '无权限目录返回 permission（不是 empty / missing / error）',
        `status=${noperm.status}`
      )
      ok(noperm.entries.length === 0, '读不到时不假装拿到了内容')
      const npRow = rowOf('noperm')
      if (!npRow) {
        ok(false, '根层没有 noperm 行')
      } else {
        const emptyBefore = qa('[data-testid="fs-empty"]').length
        click(npRow)
        const gotPerm = await until(() => !!q('[data-testid="fs-permission"]'), 6000)
        ok(gotPerm, '展开后给出「无权限」提示（不是空白）')
        const permEl = q('[data-testid="fs-permission"]')
        if (permEl) {
          const text = permEl.textContent.trim()
          out.push('  提示文案 = ' + JSON.stringify(text))
          ok(text.length > 0, '提示文案非空')
          ok(permEl.scrollWidth <= permEl.clientWidth + 1, '提示行不横向溢出')
        }
        ok(
          qa('[data-testid="fs-empty"]').length === emptyBefore,
          '没有把无权限目录错报成「空目录」'
        )
      }
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 7. 窄右栏（PANEL_MIN = 220px） ===')
    /*
     * 右栏最小宽度是 `PANEL_MIN=220`（`src/shared/ipc.ts`），不是随手取的数：
     * 用户反馈的“窄栏下文件名看不清 / 布局破”就发生在这一档。
     * 这里直接把宽度设到下限，再量：行不横溢 / 超长名省略但 title 给全文 /
     * 大目录分页与「显示更多」仍然可用。
     */
    const rpEl = () => q('[data-testid="rightpanel"]')
    const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0)
    const wBefore = widthOf(rpEl())
    await store.getState().setPanelWidth({ panelWidth: 220 })
    await sleep(1000)
    const wNarrow = widthOf(rpEl())
    out.push(`  右栏宽度 ${wBefore} → ${wNarrow}`)
    ok(Math.abs(wNarrow - 220) <= 1, '右栏收窄到最小允许宽度 220px', `${wNarrow}px`)

    const overNarrow = rowsOf().filter((r) => r.scrollWidth > r.clientWidth + 1)
    out.push('  窄栏下横向溢出的行：' + (overNarrow.length ? overNarrow.map((r) => r.dataset.path).join(', ') : '无'))
    for (const r of overNarrow.slice(0, 4)) {
      const n = r.querySelector('.rp-fs-name')
      const kids = [...r.children].map((c) => Math.round(c.getBoundingClientRect().width))
      out.push(
        `    ${r.dataset.path}  client=${r.clientWidth} scroll=${r.scrollWidth} padL=${getComputedStyle(r).paddingLeft} 子元素=${JSON.stringify(kids)} name=${n ? Math.round(n.getBoundingClientRect().width) + '/' + n.scrollWidth : '无'}`
      )
    }    ok(overNarrow.length === 0, '窄栏下文件树行不横向溢出')

    /* 超长名字：必须省略显示，但 `title` 里能拿到完整路径（悬停可见） */
    const clipped = rowsOf().filter((r) => {
      const n = r.querySelector('.rp-fs-name')
      return !!n && n.scrollWidth > n.clientWidth + 1
    })
    out.push('  窄栏下被省略的行 = ' + JSON.stringify(clipped.map((r) => r.dataset.path)))
    ok(clipped.length > 0, '窄栏下确实有名字被省略（否则“省略 + 全文”这两条断言没有意义）')
    ok(
      clipped.every((r) => {
        const last = (r.dataset.path ?? '').split('/').pop() ?? ''
        return (r.getAttribute('title') ?? '').includes(last)
      }),
      '被省略的行都在 title 里给出完整路径'
    )

    /* 窄栏下交互仍可用：展开大目录（分页按钮不能撑破） */
    const bigNarrow = rowOf('big')
    if (bigNarrow) {
      click(bigNarrow)
      const gotBig = await until(() => rowsUnder('big/').length > 0, 8000)
      ok(gotBig, '窄栏下展开大目录仍然可用')
      const moreNarrow = q('[data-testid="fs-more"]')
      if (moreNarrow) {
        out.push('  「显示更多」= ' + JSON.stringify(moreNarrow.textContent.trim()))
        ok(moreNarrow.scrollWidth <= moreNarrow.clientWidth + 1, '窄栏下「显示更多」按钮不横向溢出')
      }
      const bigAgain = rowOf('big')
      if (bigAgain) click(bigAgain)
      await until(() => rowsUnder('big/').length === 0, 3000)
    } else {
      ok(false, '窄栏下找不到 big 目录行')
    }

    /* 恢复默认宽度，给下一节的浏览器共存用（0 = 用默认值） */
    await store.getState().setPanelWidth({ panelWidth: 0 })
    await sleep(700)

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 8. 与内置浏览器共存（右栏上半浏览器 / 下半文件树） ===')
    /*
     * 内置浏览器是原生 `WebContentsView`，永远盖在渲染层之上，位置由主进程
     * 按 `zoomFactor` 换算。探针量不到原生视图本身，但能钉死渲染层这一侧：
     * 占位区与右栏同宽、与下方文件树**不重叠**、打开浏览器不把文件树挤掉。
     */
    const browserToggle = q('[data-testid="browser-view-toggle"]')
    if (!browserToggle) {
      ok(false, '找不到内置浏览器开关')
    } else {
      if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
      await sleep(600)
      const wBeforeBrowser = widthOf(rpEl())
      browserToggle.click()
      const opened = await until(() => !!q('[data-testid="browser-surface"]'), 12000)
      ok(opened, '内置浏览器在右栏打开')
      await sleep(2500)

      const surface = q('[data-testid="browser-surface"]')
      const viewport = surface?.querySelector('.browser-viewport')
      const body = q('[data-testid="rp-body"]')
      const wAfterBrowser = widthOf(rpEl())
      const sRect = surface?.getBoundingClientRect()
      const vRect = viewport?.getBoundingClientRect()
      const bRect = body?.getBoundingClientRect()
      out.push(
        `  右栏 ${wBeforeBrowser} → ${wAfterBrowser}；浏览器占位 ${vRect ? Math.round(vRect.width) + '×' + Math.round(vRect.height) : '无'}；文件树区 ${bRect ? Math.round(bRect.width) + '×' + Math.round(bRect.height) : '无'}`
      )
      ok(Math.abs(wAfterBrowser - wBeforeBrowser) <= 1, '打开浏览器不改变右栏宽度')
      ok(!!sRect && sRect.width > 0 && sRect.width <= wAfterBrowser + 1, '浏览器面板在右栏内，未撑破')
      ok(!!vRect && vRect.width > 0 && vRect.height > 0, '渲染层给原生视图留出了占位区')
      ok(!!bRect && bRect.width > 0 && bRect.height > 0, '下方文件树分区还在（没被浏览器挤掉）')
      if (sRect && bRect) {
        ok(sRect.bottom <= bRect.top + 1, '浏览器与文件树不重叠', `${Math.round(sRect.bottom)} ≤ ${Math.round(bRect.top)}`)
      } else {
        ok(false, '量不到浏览器/文件树的几何，共存无法判定')
      }
      const rowsInBrowserMode = rowsOf().length
      out.push('  共存时文件树行数 = ' + rowsInBrowserMode)
      ok(rowsInBrowserMode > 1, '浏览器打开时文件树仍有内容')
      const overBrowserMode = rowsOf().filter((r) => r.scrollWidth > r.clientWidth + 1)
      ok(overBrowserMode.length === 0, '共存时文件树行仍不横向溢出')

      /* 关掉浏览器：文件树恢复，且右栏宽度仍然正常（不留空列） */
      browserToggle.click()
      const closed = await until(() => !q('[data-testid="browser-surface"]'), 8000)
      ok(closed, '再次点击开关能关掉内置浏览器')
      await sleep(800)
      const bodyAfter = q('[data-testid="rp-body"]')
      ok(!!bodyAfter && widthOf(bodyAfter) > 0, '关掉浏览器后文件树分区恢复')
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[fsedge] 全部通过' : '[fsedge] ' + failed + ' 条失败')
  return out.join('\n')
})()
