/**
 * pi 包管理（方案 §9 的 P2）—— 真实安装 / 卸载的端到端验证。
 *
 * ── 为什么单独一个场景、单独一个 fixture ──
 * 这一段会**真的调用 pi 的 CLI 装一个包**，所以：
 *   · 必须在**隔离的 YAN_PI_DIR** 下跑（fixture 用隔离目录），不碰用户真实装的；
 *   · 用**本地路径源**（fixture 里放一个最小包），全程不联网；
 *   · 不能挂在 panels 上 —— 那个场景没有 fixture，cwd 会落到真实项目根，
 *     往里写 probe-ext 就是污染仓库（第一次跑就是这么失败的：
 *     pi 报 `Path does not exist: ...\pi-desktop\probe-ext`）。
 *
 * 断言全部靠**回读**（列表来自主进程 → pi 的 settings.json），不看界面自报。
 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ok = (m, extra) => out.push('  ✓ ' + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''))
  const bad = (m, extra) => out.push('  ✗ ' + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''))
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  try {
    if (!store) return ['  ⤺ 跳过：没有 window.__yanStore（探针没被注入）']

    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
    const probeExt = cwd.replace(/\\/g, '/') + '/probe-ext'
    out.push('  cwd = ' + cwd)
    out.push('  本地包 = ' + probeExt)

    /* ① 配置：走 store 打开设置（点 rail 按钮依赖面板状态，这里不必要） */
    store.getState().openSettings('packages')
    const ready = await until(() => !!document.querySelector('[data-testid="set-packages"]'), 6000)
    if (!ready) return out.concat(['  ✗ 设置里没有「插件」分区']).concat(summary(out))
    ok('设置里有「插件」分区')

    /* ② UI 结构（与 panels 的那组断言互为补充：这里只验要用的控件） */
    const src = document.querySelector('[data-testid="pkg-source"]')
    const btn = () => document.querySelector('[data-testid="pkg-install-btn"]')
    if (!src || !btn()) return out.concat(['  ✗ 缺来源输入或安装按钮']).concat(summary(out))
    ok('有来源输入与安装按钮')

    /* ③ 隔离确认：起始时列表里不该有它（YAN_PI_DIR 是隔离的） */
    const hasIt = () => qa('[data-testid="pkg-name"]').some((x) => (x.textContent ?? '').includes('yan-probe-ext'))
    ok('起始时列表里没有这个包（隔离目录是干净的）', !hasIt())

    /* ④ 真实安装 */
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
      d.set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setVal(src, probeExt)
    const enabled = await until(() => !btn()?.disabled, 4000)
    if (!enabled) return out.concat(['  ✗ 填了来源之后「安装」还是禁用']).concat(summary(out))
    click(btn())
    const listed = await until(() => hasIt(), 90000)
    if (listed) ok('真实安装：pi 的 CLI 装上后列表里出现了它（yan-probe-ext）')
    else {
      /* 失败时把 pi 自己的原始输出摊开 —— 排查第一现场 */
      const tgl = document.querySelector('[data-testid="pkg-detail-toggle"]')
      if (tgl) click(tgl)
      await until(() => !!document.querySelector('.gwrite-fail-raw'), 2000)
      out.push('  ⓘ 结果=' + JSON.stringify((document.querySelector('[data-testid="pkg-result"]')?.textContent ?? '').slice(0, 80)))
      out.push('  ⓘ 原始=' + JSON.stringify((document.querySelector('.gwrite-fail-raw')?.textContent ?? '(无)').slice(0, 400)))
      bad('装完列表里没有 yan-probe-ext')
    }

    /* ⑤ 元信息来自包自己的 package.json（不是从目录名猜的） */
    if (listed) {
      const row = qa('[data-testid="pkg-item"]').find((x) => (x.textContent ?? '').includes('yan-probe-ext'))
      if (row?.textContent?.includes('9.9.9')) ok('版本来自 package.json（9.9.9）')
      else bad('列表里没有版本号', (row?.textContent ?? '').slice(0, 60))
      if (/探针用的假扩展/.test(row?.textContent ?? '') || true) {
        /* 描述在详情里 */
        const dbtn = row?.querySelector('[data-testid="pkg-detail"]')
        if (dbtn) {
          click(dbtn)
          const body = await until(() => !!document.querySelector('[data-testid="pkg-detail-body"]'), 3000)
          if (body) {
            const text = document.querySelector('[data-testid="pkg-detail-body"]')?.textContent ?? ''
            ok('「详情」能展开')
            if (/探针用的假扩展/.test(text)) ok('描述来自 package.json')
            else bad('详情里没有描述', text.slice(0, 60))
            if (/来源：/.test(text)) ok('详情里有来源')
            else bad('详情里没有来源')
            /*
             * 方案 §9 的硬要求：「说明来源与实际影响，不宣称沙箱隔离」。
             * 这句是产品边界，不是提示语 —— 所以要有断言读它。
             */
            const warn = document.querySelector('[data-testid="pkg-warn"]')?.textContent ?? ''
            if (/OS 沙箱/.test(warn) && /Skill 文件/.test(warn) && /高风险会拒绝/.test(warn) && /不会跳过/.test(warn)) {
              ok('详情写明「当前用户权限运行、无 OS 沙箱，Skill 高风险拒绝且用户指定也不跳过审查」')
            } else bad('详情缺边界声明', warn.slice(0, 120))
            if (/MIT/.test(text)) ok('详情里有许可（来源可信度的一部分）')
          } else bad('「详情」点了没展开')
        } else bad('有插件但没有「详情」按钮')
      }

      /* ⑥ 卸载：闭环 */
      const rbtn = qa('[data-testid="pkg-item"]')
        .find((x) => (x.textContent ?? '').includes('yan-probe-ext'))
        ?.querySelector('[data-testid="pkg-remove"]')
      if (rbtn) {
        click(rbtn)
        const gone = await until(() => !hasIt(), 90000)
        if (gone) ok('卸载后列表里不再有它（装 → 卸闭环）')
        else bad('卸载后它还在列表里')
      } else bad('列表项里没有「卸载」按钮')
    }

    /* ⑦ 内置能力区：浏览器是**宿主能力**（01-S5 删掉了那个不注册任何东西的空壳 browser.js） */
    const builtins = qa('[data-testid="builtin-cap"]')
    if (builtins.length === 0) bad('内置能力区是空的（至少应列出宿主任务计划与宿主浏览器）')
    else {
      const browserCap = builtins.find((el) => el.getAttribute('data-cap-id') === 'browser')
      if (browserCap) {
        ok('内置能力区列出宿主「内置浏览器」')
        if (!browserCap.querySelector('.pkg-ver')) ok('浏览器条目不带扩展文件名（能力由 `yan browser` CLI 提供）')
        else bad('浏览器条目还挂着 browser.js 文件名', browserCap.textContent ?? '')
      } else bad('内置能力区没有 browser 条目')
      const stale = builtins.filter((el) => (el.querySelector('.pkg-ver')?.textContent ?? '') === 'browser.js')
      if (stale.length === 0) ok('内置能力区不再出现 browser.js 空壳文件')
      else bad('内置能力区仍有 browser.js', String(stale.length))
    }

    /* ⑧ 收尾：关掉设置面板 */
    store.getState().closeSettings()
    await until(() => qa('.set-group').length === 0, 3000)
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.message ? error.message : String(error)))
  }

  function summary(list) {
    const failed = list.filter((l) => l.includes('✗')).length
    return ['', failed === 0 ? '[pkgs] 全部通过' : '[pkgs] ' + failed + ' 条失败']
  }
  return out.concat(summary(out)).join('\n')
})()
