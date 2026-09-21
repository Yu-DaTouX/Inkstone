/**
 * Git 审查与环境菜单（方案 G1）—— 真实窗口验收，cost 0。
 *
 * 场景 cwd 是 fixture 里那个**故意做脏**的仓库（`fixture-project/review`），
 * 它带着：未暂存修改（含多 hunk）、已暂存新增、未暂存删除、已暂存重命名、
 * 未跟踪文件、中文+空格路径、被改动的 PNG、含 NUL 的二进制文件。
 * 这些形态各自对应界面上一句可能说谎的话，所以逐条钉。
 *
 * **只读保证**不由本探针负责：它跑在渲染进程里，拿不到 git 的二进制作答。
 * 真正的逐字节比较在应用退出后（`afterExit: gitReviewReadonly`）——
 * 那才是「打开审查不会动用户暂存区」的完整证据。
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

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => [...document.querySelectorAll(sel)]
  const testid = (id) => document.querySelector(`[data-testid="${id}"]`)
  const textOf = (el) => (el ? el.textContent.trim() : '')

  /** 条件轮询（固定 sleep 会让断言时快时慢地闪） */
  const waitFor = async (fn, ms = 8000, step = 80) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = fn()
        if (v) return v
      } catch {
        /* 元素还没出现 */
      }
      await sleep(step)
    }
    return null
  }

  const click = async (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(60)
    return true
  }

  const closeOnboarding = async () => {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 20; i++) {
      const card = $('.ob-card')
      if (!card) return
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) await click(btn)
      else await sleep(120)
    }
  }

  try {
    await closeOnboarding()

    /* ── 1. 环境菜单 ─────────────────────────────────────── */

    const cwd = store.getState().session?.cwd || store.getState().settings?.cwd || ''
    out.push('  会话工作目录 = ' + cwd)
    ok(/review[\\/]?$/.test(cwd) || cwd.includes('review'), '会话 cwd 指向 fixture 里的仓库', cwd)

    const projBtn = testid('session-project')
    ok(!!projBtn, '会话头部有环境入口（项目胶囊）')
    await click(projBtn)
    const menu = await waitFor(() => testid('env-menu'), 3000)
    ok(!!menu, '点开后有环境菜单')

    /*
     * 每一项都要等：菜单一打开就会渲染，但 repo 状态是**异步**从主进程
     * 拉回来的（IPC + 一个 git 进程）。不等的话会看到「未使用 Git」那个分支。
     */
    const changeBtn = await waitFor(() => testid('env-changes'), 8000)
    ok(!!changeBtn, '菜单里有「变更」一项（等 repo 状态回来）', textOf(testid('env-notgit')))
    const changeText = textOf(testid('env-changes-count'))
    ok(changeText.length > 0, '「变更」右侧给了真实数字', JSON.stringify(changeText))
    ok(!/没有改动|No changes/.test(changeText), 'fixture 仓库是脏的 → 不是「没有改动」', changeText)
    ok(!!testid('env-local'), '菜单里有「本地」（工作目录）')
    ok(!!testid('env-branch'), '菜单里有当前分支')
    ok(!!testid('env-pr'), '菜单里有 Pull Request 项')
    /*
     * ⚠️ 这条断言在 G3 之后**换过语义**：以前是「没有 gh 就说无法获取」，
     * 现在是「真的去查了，查不到时**说清是哪一种查不到**」。
     *
     * review fixture 的 remote 是本地路径（不是托管站），所以正确的答案是
     * 「这个远端不支持」—— 而且**一次外发请求都不发**。
     * 要**等**：查询是异步的（第一版直接读，拿到的是"查询中…"）。
     */
    const prText = await waitFor(() => {
      const el = testid('env-pr-state')
      const txt = el ? textOf(el) : ''
      return txt && !/查询中|Checking/.test(txt) ? txt : null
    }, 10000)
    ok(!!prText, 'PR 状态查完了（不是一直卡在「查询中」）', String(prText))
    ok(
      /不支持|not supported/.test(String(prText)),
      '本地路径的远端 → 如实说「这个远端不支持」（不猜托管站、不编状态）',
      String(prText)
    )
    ok(!!testid('env-compare'), '菜单里有「比较分支」')

    /* ── 2. 打开审查 ─────────────────────────────────────── */

    await click(changeBtn)
    const panel = await waitFor(() => testid('review-panel'), 5000)
    ok(!!panel, '点「变更」打开了审查面板')
    ok(!!(await waitFor(() => $('.app.review-on'), 2000)), '审查打开时 app 挂上 review-on（右栏走宽档位）')
    ok(!testid('env-menu'), '打开审查后菜单收起来了')

    const stats = await waitFor(() => testid('review-stats'), 8000)
    ok(!!stats, '面板头部给出统计')
    const statsText = textOf(stats)
    ok(/\+[1-9]\d*/.test(statsText), '统计里有真实的新增行数', statsText)
    ok(/-[1-9]\d*/.test(statsText), '统计里有真实的删除行数', statsText)

    /* ── 3. 文本 diff 真的渲染出来了 ─────────────────────── */

    const diff = await waitFor(() => testid('review-diff'), 8000)
    ok(!!diff, '有文件被自动展开并渲染出 diff')

    const adds = await waitFor(() => $$('.rdiff-line.add').length, 8000)
    ok(adds > 0, 'diff 里有新增行（带 + 号与行号）', String(adds))
    /* 每个文件的 patch 是懒加载的；新增文件先返回时，删除文件可能还在 IPC 中。 */
    const dels = await waitFor(() => $$('.rdiff-line.del').length, 8000)
    ok(dels > 0, 'diff 里有删除行', String(dels))

    const firstAdd = $('.rdiff-line.add')
    const noCells = firstAdd ? firstAdd.querySelectorAll('.rdiff-no').length : 0
    ok(noCells === 2, '每行有**两列**行号（旧/新），而不是只有一列', String(noCells))
    const addNo = firstAdd ? textOf(firstAdd.querySelectorAll('.rdiff-no')[1]) : ''
    ok(/^\d+$/.test(addNo), '新增行的新行号是数字', addNo)

    /*
     * 多 hunk 文件里的「未修改的 N 行」：**真的能展开**。
     * 一个点了没反应的控件比没有这个控件更糟，所以这条断言盯的
     * 不是「折叠条存在」，而是「点了之后出现了真实内容行」。
     */
    const gap = await waitFor(() => testid('review-gap'), 8000)
    ok(!!gap, '改动之间有「N 行未修改」的折叠条（长文件不会把无关行全铺出来）', textOf(gap))
    if (gap) {
      const ctxBefore = $$('.rdiff-line.ctx').length
      const gapLabel = textOf(gap)
      await click(gap)
      /* 展开要去要该文件的原文（一次 IPC），所以等的是出现真实内容行 */
      const opened = await waitFor(() => testid('review-gap-open'), 8000)
      ok(!!opened, '点折叠条真的展开了内容（而不是点了没反应）', gapLabel)
      const ctxAfter = $$('.rdiff-line.ctx').length
      ok(ctxAfter > ctxBefore, '展开后上下文行数增加', `${ctxBefore} → ${ctxAfter}`)
      /* 展开出来的行必须带**两侧**行号，且是数字 */
      const firstLine = opened ? opened.querySelector('.rdiff-line.ctx') : null
      const nos = firstLine ? [...firstLine.querySelectorAll('.rdiff-no')].map((el) => textOf(el)) : []
      ok(nos.length === 2 && nos.every((n) => /^\d+$/.test(n)), '展开的上下文行有两列真实行号', nos.join('/'))
    }

    /* ── 4. 变更文件树 ───────────────────────────────────── */

    const treeFiles = await waitFor(() => $$('[data-testid="review-tree-file"]').length, 6000)
    ok(treeFiles > 0, '变更树里有文件', String(treeFiles))
    const progress = textOf(testid('review-progress'))
    ok(/0\/|0 of/.test(progress), '初始「已查看」进度是 0', progress)

    /* 树的筛选：输入 staged 应当只剩名字里带它的文件 */
    const filter = testid('review-filter')
    ok(!!filter, '树有文件名筛选框')
    if (filter) {
      /*
       * React 的受控 input 有 value tracker：直接写 `.value` 再派发 input 事件，
       * React 会认为值没变因而不触发 onChange（实测筛选完全没生效）。
       * 用原型上的原生 setter 写值才能绕过 tracker —— 项目里其它探针同做法。
       */
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      const before = $$('[data-testid="review-tree-file"]').length
      setValue.call(filter, 'staged')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      const reduced = await waitFor(() => {
        const n = $$('[data-testid="review-tree-file"]').length
        return n < before && n > 0 ? n : null
      }, 3000)
      ok(!!reduced, '筛选后文件变少（筛选真的生效）', `${before} → ${$$('[data-testid="review-tree-file"]').length}`)
      setValue.call(filter, '')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(() => $$('[data-testid="review-tree-file"]').length === before, 3000)
      ok($$('[data-testid="review-tree-file"]').length === before, '清空筛选后文件数回来了')
    }

    /* 目录折叠 */
    const dir = await waitFor(() => $('.rtree-dir'), 3000)
    if (dir) {
      const before = $$('[data-testid="review-tree-file"]').length
      await click(dir)
      const after = $$('[data-testid="review-tree-file"]').length
      ok(after < before, '点目录能折叠它下面的文件', `${before} → ${after}`)
      await click(dir)
      ok($$('[data-testid="review-tree-file"]').length === before, '再点一次展开回来')
    } else {
      ok(false, '树里应当有目录节点（fixture 里有 docs/ 与 src/）')
    }

    /* 点树里的文件 → 滚动并展开它 */
    const untrackedNode = $$('[data-testid="review-tree-file"]').find((el) => (el.dataset.path || '').includes('untracked'))
    if (untrackedNode) {
      await click(untrackedNode)
      await sleep(200)
      const card = $(`[data-file="${untrackedNode.dataset.path}"]`)
      const toggle = card && card.querySelector('[data-testid="review-file-toggle"]')
      ok(toggle && toggle.getAttribute('aria-expanded') === 'true', '点树里的文件会展开它对应的卡片')
    } else {
      ok(false, '树里应当有未跟踪文件')
    }

    /* ── 5. 已查看标记（持久化 + 内容指纹参与身份） ──────── */

    const viewedBtn = await waitFor(() => testid('review-viewed'), 3000)
    ok(!!viewedBtn, '文件头部有「标记为已查看」按钮')
    if (viewedBtn) {
      await click(viewedBtn)
      await sleep(150)
      ok(viewedBtn.classList.contains('on'), '点了之后变成已查看（accent 底）')
      const progress2 = textOf(testid('review-progress'))
      ok(/1\/|1 of/.test(progress2), '进度从 0 变成 1', progress2)

      /* 关掉再打开：标记必须还在（localStorage 持久化） */
      await click(testid('review-close'))
      await sleep(200)
      ok(!testid('review-panel'), '点关闭后审查面板消失')
      ok(!$('.app.review-on'), '关闭后 review-on 被摘掉（右栏宽度回到用户档）')
      const reopened = await waitFor(async () => {
        await click(testid('session-project'))
        return testid('env-changes')
      }, 3000)
      await click(reopened)
      await waitFor(() => testid('review-panel'), 4000)
      const again = await waitFor(() => testid('review-viewed'), 6000)
      ok(again && again.classList.contains('on'), '重新打开后「已查看」还在（持久化了，不是内存态）')
      const progress3 = textOf(testid('review-progress'))
      ok(/1\/|1 of/.test(progress3), '重新打开后进度仍是 1', progress3)

      /* 取消标记 */
      await click(again)
      await sleep(150)
      ok(!again.classList.contains('on'), '再点一次能取消已查看')
      ok(/0\/|0 of/.test(textOf(testid('review-progress'))), '取消后进度回到 0', textOf(testid('review-progress')))
      await click(again)
      await sleep(150)
    }

    /* ── 6. 图片前后对照 ─────────────────────────────────── */

    const picCard = await waitFor(
      () => $$('[data-testid="review-file"]').find((c) => (c.dataset.file || '').includes('pic.png')),
      6000
    )
    ok(!!picCard, '被改动的 PNG 出现在清单里')
    if (picCard) {
      const toggle = picCard.querySelector('[data-testid="review-file-toggle"]')
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') await click(toggle)
      /* 两侧图片各自读一次 git 对象 / 工作区文件 */
      const img = await waitFor(() => picCard.querySelector('[data-testid="review-image"]'), 8000)
      ok(!!img, '图片文件用对照视图（不是「二进制无法显示」）')
      /*
       * 两侧的内容是**各一次** IPC（旧侧读 git 对象、新侧读工作区），
       * 所以不能在第一张图出现时就断言 —— 那时第二张还在 loading。
       */
      const imgs = img
        ? await waitFor(() => {
            const list = [...img.querySelectorAll('img')]
            return list.length === 2 ? list : null
          }, 8000)
        : null
      ok(imgs && imgs.length === 2, '两张图（改动前 / 改动后）', String(imgs ? imgs.length : 0))
      const srcs = (imgs ?? []).map((i) => i.getAttribute('src') || '')
      ok(srcs.length === 2 && srcs.every((s) => s.startsWith('data:image/png;base64,')), '两张图都是真实 PNG 的 data URL')
      ok(srcs.length === 2 && srcs[0] !== srcs[1], '**两侧是不同的版本**（旧图确实来自 Git 对象，不是复制了新图）')
    }

    /* ── 7. 二进制文件不能伪造行数 ───────────────────────── */

    const binCard = await waitFor(
      () => $$('[data-testid="review-file"]').find((c) => (c.dataset.file || '').includes('blob.bin')),
      6000
    )
    ok(!!binCard, '二进制文件出现在清单里')
    if (binCard) {
      const toggle = binCard.querySelector('[data-testid="review-file-toggle"]')
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') await click(toggle)
      const note = await waitFor(() => {
        const el = binCard.querySelector('.rdiff-note')
        /* 先等到的是「正在读取…」，要等它换成真正的说明 */
        return el && /二进制|Binary/.test(el.textContent || '') ? el : null
      }, 8000)
      const noteText = textOf(note)
      ok(/二进制|Binary/.test(noteText), '二进制文件明说无法逐行显示差异（不是给一个空的 diff）', noteText)
      ok(!binCard.querySelector('.rdiff-line'), '二进制文件不渲染假的 diff 行')
    }

    /* ── 8. 切换范围 ─────────────────────────────────────── */

    const scopeSel = await waitFor(() => testid('review-scope'), 6000)
    ok(!!scopeSel, '头部有范围选择器')
    const pathsIn = () => $$('[data-testid="review-file"]').map((c) => c.dataset.file || '')
    const workingPaths = pathsIn()
    ok(workingPaths.some((p) => p.includes('untracked')), '工作区范围里有未跟踪文件')

    scopeSel.value = 'staged'
    scopeSel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(600)
    const stagedPaths = await waitFor(() => {
      const p = pathsIn()
      return p.length && !p.some((x) => x.includes('untracked')) ? p : null
    }, 6000)
    ok(!!stagedPaths, '切到「已暂存」后未跟踪文件不再出现（范围真的传下去了）', (stagedPaths || pathsIn()).join(', '))
    ok((stagedPaths || []).some((p) => p.includes('staged-new')), '「已暂存」里有那个 git add 过的新文件')

    scopeSel.value = 'working'
    scopeSel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(600)
    await waitFor(() => pathsIn().some((p) => p.includes('untracked')), 6000)
    ok(pathsIn().some((p) => p.includes('untracked')), '切回工作区范围后未跟踪文件回来了')

    /* ── 9. 刷新与关闭 ───────────────────────────────────── */

    await click(testid('review-refresh'))
    await sleep(500)
    ok(!!testid('review-panel'), '刷新后面板还在')
    ok(!testid('review-error'), '刷新没有报错', textOf(testid('review-error')))

    await click(testid('review-close'))
    await sleep(200)
    ok(!testid('review-panel'), '关闭审查（第二次）')
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[gitreview] 全部通过' : '[gitreview] ' + failed + ' 条失败')
  return out.join('\n')
})()
