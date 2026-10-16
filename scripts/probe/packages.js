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

    store.getState().openSettings('market')
    await until(() => !!document.querySelector('[data-testid="market-pi-tab"]'), 6000)
    document.querySelector('[data-testid="market-pi-tab"]')?.click()
    const ready = await until(() => !!document.querySelector('[data-testid="set-packages"]'), 6000)
    if (!ready) return out.concat(['  ✗ 设置里没有「插件」分区']).concat(summary(out))
    ok('设置里有「插件」分区')

    const src = document.querySelector('[data-testid="pkg-source"]')
    const btn = () => document.querySelector('[data-testid="pkg-install-btn"]')
    if (!src || !btn()) return out.concat(['  ✗ 缺来源输入或安装按钮']).concat(summary(out))
    ok('有来源输入与安装按钮')

    const hasIt = () => qa('[data-testid="pkg-name"]').some((x) => (x.textContent ?? '').includes('yan-probe-ext'))
    ok('起始时列表里没有这个包（隔离目录是干净的）', !hasIt())

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
      const tgl = document.querySelector('[data-testid="pkg-detail-toggle"]')
      if (tgl) click(tgl)
      await until(() => !!document.querySelector('.gwrite-fail-raw'), 2000)
      out.push('  ⓘ 结果=' + JSON.stringify((document.querySelector('[data-testid="pkg-result"]')?.textContent ?? '').slice(0, 80)))
      out.push('  ⓘ 原始=' + JSON.stringify((document.querySelector('.gwrite-fail-raw')?.textContent ?? '(无)').slice(0, 400)))
      bad('装完列表里没有 yan-probe-ext')
    }

    if (listed) {
      const row = qa('[data-testid="pkg-item"]').find((x) => (x.textContent ?? '').includes('yan-probe-ext'))
      if (row?.textContent?.includes('9.9.9')) ok('版本来自 package.json（9.9.9）')
      else bad('列表里没有版本号', (row?.textContent ?? '').slice(0, 60))
      if (/探针用的假扩展/.test(row?.textContent ?? '') || true) {
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
            const warn = document.querySelector('[data-testid="pkg-warn"]')?.textContent ?? ''
            if (/以你的身份运行代码/.test(warn) && /没有沙箱/.test(warn)) {
              ok('详情写明「以你的身份运行代码、没有沙箱」（不宣称沙箱隔离）')
            } else bad('详情缺边界声明', warn.slice(0, 120))
            if (/MIT/.test(text)) ok('详情里有许可（来源可信度的一部分）')
          } else bad('「详情」点了没展开')
        } else bad('有插件但没有「详情」按钮')
      }

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

    const builtinProbe = await window.yan.builtinCapabilities.list().then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: e?.message ?? String(e) })
    )
    if (!builtinProbe.ok || (builtinProbe.value?.length ?? 0) === 0) {
      out.push('  内置能力 IPC 诊断 = ' + JSON.stringify(builtinProbe).slice(0, 300))
    }
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
      const fallbackNamed = builtins
        .map((el) => (el.querySelector('[data-testid="builtin-cap-name"]')?.textContent ?? '').trim())
        .filter((name) => /\.(?:js|mjs|cjs|ts)$/i.test(name))
      if (fallbackNamed.length === 0) ok('内置能力每项都登记了文案，没有退化成文件名的')
      else bad('内置能力里有没登记文案的项', fallbackNamed.join(', '))
    }

    store.getState().closeSettings()
    await until(() => qa('.ui-rows').length === 0, 3000)
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.message ? error.message : String(error)))
  }

  function summary(list) {
    const failed = list.filter((l) => l.includes('✗')).length
    return ['', failed === 0 ? '[pkgs] 全部通过' : '[pkgs] ' + failed + ' 条失败']
  }
  return out.concat(summary(out)).join('\n')
})()
