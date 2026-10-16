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

    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    await sleep(400)
    document.querySelector('[data-testid="right-window-tab-start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(500)
    await window.__yanOpenWorkspaceTool('文件', 'files')

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

    const firstFileIdx = rootList.entries.findIndex((e) => !e.dir)
    const lastDirIdx = rootList.entries.map((e) => e.dir).lastIndexOf(true)
    ok(
      firstFileIdx === -1 || lastDirIdx < firstFileIdx,
      '目录全部排在文件之前（排序规则）',
      `lastDir=${lastDirIdx} firstFile=${firstFileIdx}`
    )

    out.push('')
    out.push('=== 2. 界面：大目录分页（50 一批） ===')
    const rootReady = await until(() => rowsOf().length > 2, 8000)
    ok(rootReady, '根层懒加载回来了')
    const rootRow = q('[data-testid="fs-row-root"]')
    ok(/fixture-project/i.test(rootRow?.textContent ?? ''), '根行显示 fixture 项目名', rootRow?.textContent?.trim())

    const rootCount = rowsOf().length - 1
    const bigRow = rowOf('big')
    if (!bigRow) {
      ok(false, '找不到 big 目录行')
    } else {
      click(bigRow)
      const gotBatch = await until(() => rowsUnder('big/').length > 0, 8000)
      const firstBatch = rowsUnder('big/').length
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
        more.focus()
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        click(more)
        const expanded = await until(() => rowsUnder('big/').length === 60, 4000)
        ok(expanded, '点「显示更多」后补上剩余行', `${rowsUnder('big/').length}/60`)
        await until(() => !q('[data-testid="fs-more"]'), 3000)
        ok(!q('[data-testid="fs-more"]'), '全部渲染完之后「显示更多」消失')
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const afterPaths = rowsOf().map((r) => r.dataset.path)
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
    const bigRowAgain = rowOf('big')
    if (bigRowAgain) click(bigRowAgain)
    await until(() => rowsUnder('big/').length === 0, 3000)

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

    out.push('')
    out.push('=== 6. 无权限目录（真实 ACL：deny 当前用户读取） ===')
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

    out.push('')
    out.push('=== 7. 窄右栏（PANEL_MIN = 220px） ===')
    const rpEl = () => q('[data-workspace-pane="files"]:not([hidden])')
    const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0)
    const wBefore = widthOf(rpEl())
    const pane = rpEl(), previousWidth = pane.style.width
    pane.style.width = '220px'
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

    pane.style.width = previousWidth
    await sleep(700)

    out.push('')
    out.push('=== 8. 浏览器与文件磁贴共存 ===')
    await window.__yanOpenWorkspaceTool('浏览器', 'browser')
    await sleep(1500)
    const browserPane = q('[data-workspace-pane="browser"]:not([hidden])')
    const retainedFilePane = pane
    const filePane = rpEl()
    const view = browserPane?.querySelector('.browser-viewport')?.getBoundingClientRect()
    ok(!!browserPane && retainedFilePane.isConnected, '浏览器活动，文件树资源仍挂载')
    ok(!!q('[data-pane-tab="browser"] [role="tab"][aria-selected="true"]'), '浏览器磁贴有活动标签')
    ok(!!view && view.width>0 && view.height>0, '浏览器原生视图有占位区')
    const a=browserPane?.getBoundingClientRect(), b=filePane?.getBoundingClientRect()
    ok(!!a && (b ? (a.right<=b.left+1 || b.right<=a.left+1 || a.bottom<=b.top+1 || b.bottom<=a.top+1) : retainedFilePane.hidden), '浏览器和文件磁贴分区或同组隐藏，不重叠')
    const hide = q('[data-pane-tab="browser"]')?.closest('.tile-heading')?.querySelector('[aria-label="收起面板，保留运行"]')
    hide?.click(); await sleep(500)
    ok(!q('[data-workspace-pane="browser"]:not([hidden])'), '浏览器可隐藏')
    await window.__yanOpenWorkspaceTool('文件', 'files')
    ok(!!rpEl() && rowsOf().length>1, '隐藏浏览器后文件树仍保留内容')
    await window.yan.browser.close()
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[fsedge] 全部通过' : '[fsedge] ' + failed + ' 条失败')
  return out.join('\n')
})()
