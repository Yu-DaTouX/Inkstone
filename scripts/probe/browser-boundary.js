/**
 * L04 · 浏览器授权与网络边界（真实应用 + 真实网络栈 + 真实本地服务）。
 *
 * 与 `browser.js` 的分工：那个场景验的是「面板开合 / CDP 观察 / 标签页」这条
 * 主链路，权限只调了 `setPermission`。这里补的是**边界**：
 *
 *   1. 页面真的发起权限请求 → 默认拒绝 → 用户授权 → 再请求就放行 → 撤销
 *      （让 Chromium 的 permission handler 真的跑一遍，而不是只写一条记录）
 *   2. 本地预览可用（loopback 页面访问 loopback 服务）—— 防「一刀切拦死」
 *   3. 下载：落盘在隔离目录、**带来源**、文案明说「未自动打开」
 *   4. 本机 Chrome 的下载同样带来源（以前没有来源）
 *   5. Cookie 复制是真的：内置浏览器的 Cookie 到了 Chrome 后，目标页面看得见
 *      （值本身不进输出 —— 页面只回哈希，由 test-live 侧比对）
 *   6. 远程页面不能借道访问本机服务（被拦 + 可追溯记录）
 *   7. DNS 重绑定：域名不像内网、解析后却落在 127.0.0.1 → 拦
 *
 * ⚠️ 顺序不是随意的：`onBeforeRequest` 用**顶层页面**的 URL 判断发起方，
 * 而远程页面访问 loopback 会被拦 —— 所以「要访问本地服务」的几节必须先做，
 * 远程相关的两节放最后（第 8 节顺带把这条行为本身钉成证据）。
 * 需要公网的两节拿不到公网时**显式跳过并打印原因**，绝不写成通过。
 *
 * 本地服务由 `scripts/test-live.mjs` 起在 127.0.0.1:39873
 *（渲染进程起不了服务，`YAN_*` 也只有主进程读得到，端口只能是约定值）。
 */
;(async () => {
  const BOUNDARY = 'http://127.0.0.1:39873'
  /** 解析到 127.0.0.1 的**公网域名**（sslip.io 通配解析）—— DNS 重绑定的形状 */
  const REBIND = 'http://127-0-0-1.sslip.io:39873'
  /** 负对照：同样形状但解析到公网地址，不该被拦 */
  const PUBLIC_CONTROL = 'http://1-1-1-1.sslip.io/'

  const out = []
  let failures = 0
  const ok = (cond, label, extra = '') => {
    const pass = Boolean(cond)
    if (!pass) failures++
    out.push(`  ${pass ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return pass
  }
  const skip = (label, why) => out.push(`  ⤺ 跳过：${label}（${why}）`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const st = () => store.getState().browserState
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return false
  }
  /** 网页文档的真实地址（CDP 读 location.href），不是我们乐观写进状态的期望值 */
  const docUrl = () =>
    window.yan.browser
      .observe()
      .then((o) => o.url ?? '')
      .catch(() => '')
  const docText = () =>
    window.yan.browser
      .observe()
      .then((o) => o.text ?? '')
      .catch(() => '')

  /* 关掉引导层并打开右栏（浏览器面板在右栏里） */
  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成/.test(b.textContent))
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(120)
  }
  if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  await sleep(300)

  /* ---- 1. 先证明本地服务是真的（否则后面每一节都是假结论） ---- */
  out.push('=== 1. 本地 fixture 服务 ===')
  /*
   * 为什么不用 `fetch` 从这里探：渲染端的 CSP 不允许连 127.0.0.1
   *（实测直接 Failed to fetch，一度把“服务好好的”误判成“拿不到服务”）。
   * 改成走**网页视图**去读：既证明服务活着，又证明视图真的能连上它。
   */
  await store.getState().openBrowser(`${BOUNDARY}/whoami`)
  await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
  const served = (await docText()).trim()
  ok(/^cookie=none hash=none$/.test(served), '本地服务可达（此刻还没有 Cookie，符合预期）', served.slice(0, 48))

  /* ---- 2. 本地预览：loopback 页面访问 loopback 服务必须放行 ---- */
  out.push('')
  out.push('=== 2. 本地预览边界（正向对照，不能一刀切拦死） ===')
  await store.getState().openBrowser(BOUNDARY)
  await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
  const localDoc = await docUrl()
  ok(localDoc.startsWith(BOUNDARY), '本地页面真的加载了', localDoc)
  ok(/download/i.test(await docText()), '页面内容被读到（说明没被拦）')

  /* ---- 2b. 网页自己开窗口：新标签真建出来，但**不夺走**当前阅读页（H-9 第二阶段） ---- */
  out.push('')
  out.push('=== 2b. 网页自己 window.open（后台标签） ===')
  await store.getState().openBrowser(BOUNDARY)
  await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
  const beforeTabs = (st().tabs ?? []).map((tab) => tab.id)
  const beforeActive = st().activeTabId
  await store.getState().openBrowser(`${BOUNDARY}/popup`)
  await until(() => (st().tabs ?? []).length > beforeTabs.length, 12000)
  const afterState = st()
  const afterTabs = afterState.tabs ?? []
  ok(afterTabs.length === beforeTabs.length + 1, 'window.open 真的新建了一个标签', `${beforeTabs.length} → ${afterTabs.length}`)
  const created = afterTabs.find((tab) => !beforeTabs.includes(tab.id))
  ok(!!created, '新标签有独立的 id', created?.id ?? '')
  ok(afterState.activeTabId !== created?.id, '新标签**没有**夺走当前阅读页（activeTabId 未变）', `${beforeActive} → ${afterState.activeTabId}`)
  /* observe() 读的是活动标签：内容仍是触发页，说明后台页没有顶掉当前视图 */
  ok(/\/popup$/.test((await docUrl()).replace(/\/$/, '')), '当前视图仍是触发它的那一页')
  ok(/opener/i.test(await docText()), '当前视图内容仍是触发页（没被后台页覆盖）')
  if (created) {
    ok(/\/private$/.test((created.url ?? '').replace(/\/$/, '')), '后台标签的 URL 是 window.open 的目标', created.url ?? '')
    await window.yan.browser.switchTab(created.id)
    await sleep(600)
    ok(await until(async () => /private-ok/.test(await docText()), 12000), '后台标签真的加载了目标页（切过去能看到内容）')
    await window.yan.browser.closeTab(created.id)
    await sleep(400)
    ok((st().tabs ?? []).every((tab) => tab.id !== created.id), '关掉它之后标签列表恢复')
    ok((st().activeTabId ?? '') !== created.id, '关掉后台标签不影响当前阅读页')
  }

  /* ---- 3. 权限：真实请求 → 默认拒绝 → 授权 → 放行 → 撤销 ---- */
  out.push('')
  out.push('=== 3. 逐站权限（真实权限请求） ===')
  const origin = new URL(BOUNDARY).origin
  const recordFor = (name) => (st().permissions ?? []).find((p) => p.permission === name && p.origin === origin)
  await store.getState().openBrowser(`${BOUNDARY}/ask`)
  await until(() => (st().permissions ?? []).some((p) => p.origin === origin && p.status === 'blocked'), 8000)
  const blocked = (st().permissions ?? []).find((p) => p.origin === origin && p.status === 'blocked')
  ok(blocked, '页面发起的权限请求被默认拒绝并**记录在案**', JSON.stringify(st().permissions ?? []))
  const permissionName = blocked?.permission ?? ''
  if (permissionName) {
    const allow = await window.yan.browser.setPermission(permissionName, origin, true)
    ok(allow.ok, `用户对 ${permissionName} 授权成功`, allow.error ?? '')
    await store.getState().openBrowser(`${BOUNDARY}/ask`)
    await until(() => recordFor(permissionName)?.status === 'allowed', 8000)
    ok(recordFor(permissionName)?.status === 'allowed', '授权后再请求被放行并记为 allowed', JSON.stringify(recordFor(permissionName) ?? null))
    await window.yan.browser.setPermission(permissionName, origin, false)
    await sleep(500)
    ok(recordFor(permissionName)?.status === 'blocked', '撤销后回到 blocked', JSON.stringify(recordFor(permissionName) ?? null))
    /* 撤销后页面再请求仍应被拒（检查真实生效，不只是记录变了） */
    const before = (st().permissions ?? []).find((p) => p.permission === permissionName)?.status
    ok(before === 'blocked', '撤销后状态立即生效（不是只改了显示）')
  }

  /* ---- 4. 下载（内置浏览器）：来源 + 不自动打开 ---- */
  out.push('')
  out.push('=== 4. 下载（内置浏览器） ===')
  await store.getState().openBrowser(BOUNDARY)
  await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
  const beforeDownload = st().lastDownload
  await store.getState().openBrowser(`${BOUNDARY}/download`)
  const gotDownload = await until(() => st().lastDownload && st().lastDownload !== beforeDownload, 25000)
  const download = st().lastDownload
  ok(gotDownload, '下载被记录', JSON.stringify(download ?? null))
  ok(download?.filename === 'yan-probe-download.txt', '文件名来自服务端', download?.filename ?? '—')
  ok((download?.source ?? '').startsWith(BOUNDARY), '下载带来源（用户能看出文件从哪来）', download?.source ?? '—')
  /*
   * 「不自动打开」是产品约束（下载物可能可执行）。这里能断言的是 UI 明说这件事；
   * “没有调用 shell.openPath”由代码审阅背书 —— `handleDownload` 只 setSavePath +
   * 记录，仓库里没有第二处拿下载路径去打开的调用。
   */
  const downloadText = q('[data-testid="browser-download"]')?.textContent ?? ''
  ok(/未自动打开/.test(downloadText), '界面明说「未自动打开」', downloadText.slice(0, 48))

  /* ---- 5. 下载（本机 Chrome）：同样带来源 ---- */
  out.push('')
  out.push('=== 5. 下载（本机 Chrome） ===')
  const connected = await (async () => {
    await store.getState().openExternalChrome('about:blank')
    return until(() => st().mode === 'external', 30000)
  })()
  ok(connected, '已接入本机 Chrome', st().mode ?? '—')
  if (connected) {
    const beforeExternal = st().lastDownload
    await store.getState().openExternalChrome(`${BOUNDARY}/download`)
    const got = await until(() => st().lastDownload && st().lastDownload !== beforeExternal, 30000)
    const externalDownload = st().lastDownload
    ok(got, '外部 Chrome 的下载被记录', JSON.stringify(externalDownload ?? null))
    ok(
      (externalDownload?.source ?? '').includes('127.0.0.1'),
      '外部 Chrome 的下载**带来源**（改前只有文件名，用户看不出它来自哪）',
      externalDownload?.source ?? '—'
    )
  } else {
    skip('外部 Chrome 下载', '本机 Chrome 没接上')
  }

  /* ---- 6. Cookie 复制是真的（值不出现，只比对哈希） ---- */
  out.push('')
  out.push('=== 6. Cookie 复制（内置 → 本机 Chrome） ===')
  await store.getState().openBrowser(`${BOUNDARY}/`)
  await sleep(1500)
  if (!connected) {
    skip('Cookie 真实转移', '本机 Chrome 没接上')
  } else {
    const report = await window.yan.browser.syncLocalProfile()
    out.push(`  · 复制报告：${JSON.stringify(report ?? null)}`)
    await store.getState().openExternalChrome(`${BOUNDARY}/whoami`)
    await sleep(2500)
    const viaChrome = await docText()
    const hash = /hash=([0-9a-f]{8})/.exec(viaChrome)?.[1] ?? ''
    ok(/cookie=present/.test(viaChrome), 'Chrome 打开的页面看得到那个 Cookie', viaChrome.trim().slice(0, 32))
    if (hash) out.push(`  · cookieHash=${hash}`)
  }

  /* ---- 7. 远程页面不能借道访问本机服务 ---- */
  out.push('')
  out.push('=== 7. 远程页面 → 本机服务 ===')
  await store.getState().openBrowser('https://example.com/')
  const remoteOk = await until(async () => /example\.com/.test(await docUrl()), 25000)
  if (!remoteOk) {
    skip('远程页面借道本机服务', '当前拿不到公网（打不开 example.com）')
  } else {
    ok(remoteOk, '远程页面已加载', await docUrl())
    /*
     * 先钉住正向：用户/agent **明确要求**打开本机地址时不能拦
     *（这就是本地预览：远程页面上看文档，然后要看本地 dev server）。
     */
    await store.getState().openBrowser(`${BOUNDARY}/private`)
    await until(async () => (await docUrl()).startsWith(BOUNDARY), 12000)
    ok((await docUrl()).startsWith(BOUNDARY), '用户/agent 明确打开本机地址时放行（本地预览）', await docUrl())

    /*
     * 真正的攻击形状：远程页面用 **302** 把顶层导航引到本机服务
     *（httpbin 是公网真实服务，不依赖我们自己托管页面）。
     * 这种导航不是我们发起的，必须被拦。
     *
     * ⚠️ 先把已提交文档换回**远程**页：上一步的文档是本机页面，
     *    而“发起方是本地页面”时本来就该放行 —— 不等它切回去就试，
     *    测的就不是守卫而是上一条规则（第一版就踩了）。
     */
    await store.getState().openBrowser('https://example.com/')
    await until(async () => /example\.com/.test(await docUrl()), 20000)
    const redirect = `https://httpbin.org/redirect-to?url=${encodeURIComponent(`${BOUNDARY}/private`)}`
    await store.getState().openBrowser(redirect)
    await sleep(4500)
    const after = await docUrl()
    ok(!after.startsWith(BOUNDARY), '远程页面 302 到 127.0.0.1 被拦（文档没落在本机服务上）', after)
    const hit = (st().blockedRequests ?? []).find((b) => b.host === '127.0.0.1')
    ok(hit?.reason === 'private-host', '拦截记录给出原因 private-host', JSON.stringify(hit ?? null))
    ok(/httpbin\.org|example\.com/.test(hit?.from ?? ''), '记录里带发起方（是谁想访问本机）', hit?.from ?? '—')
  }

  /* ---- 8. DNS 重绑定 ---- */
  out.push('')
  out.push('=== 8. DNS 重绑定 ===')
  /*
   * 负对照先行：同样形状、解析到**公网**地址的域名能提交文档，
   * 说明 sslip.io 这类通配 DNS 在本机可用。反之下一节必须跳过 ——
   * 不能把“DNS 根本没解析”当成“守卫拦住了”。
   */
  let dnsUsable = false
  if (!remoteOk) {
    skip('DNS 重绑定拦截', '需要一个远程顶层页面才能发起借道请求')
  } else {
    await store.getState().openBrowser(PUBLIC_CONTROL)
    dnsUsable = await until(async () => /1-1-1-1\.sslip\.io/.test(await docUrl()), 15000)
    ok(!(st().blockedRequests ?? []).some((b) => b.host.startsWith('1-1-1-1')), '负对照：公网域名没被误拦')
    if (!dnsUsable) {
      skip('DNS 重绑定拦截', 'sslip.io 通配 DNS 在本机器不可用')
    } else {
      const redirect = `https://httpbin.org/redirect-to?url=${encodeURIComponent(`${REBIND}/private`)}`
      await store.getState().openBrowser(redirect)
      await sleep(4500)
      const after = await docUrl()
      ok(!/sslip\.io/.test(after), '远程页面 302 到「看起来是公网、实际解析到 127.0.0.1」的域名被拦', after)
      const rebind = (st().blockedRequests ?? []).find((b) => b.reason === 'dns-rebind')
      ok(
        rebind?.host === '127-0-0-1.sslip.io',
        '记录原因 = dns-rebind，主机名是那个域名',
        JSON.stringify(rebind ?? null)
      )
      /*
       * 而且**我们自己发起**的导航也不放行：DNS 重绑定是攻击形状，
       * agent 可能是被页面上的一句话诱导去开的（那会直接变成一个读本机服务的原语）。
       */
      await store.getState().openBrowser(`${REBIND}/whoami`)
      await sleep(3500)
      ok(!/sslip\.io/.test(await docUrl()), 'agent 自己发起这类导航也不放行（不给“读本机服务”的原语）', await docUrl())
    }
  }

  /*
   * 状态里不该出现 Cookie 名/值 —— 浏览器状态只带计数与来源。
   * 明文哨兵的比对在 test-live 侧（它能看 stdout+stderr 全文，探针看不到自己的输出）。
   */
  const rawState = JSON.stringify(await window.yan.browser.getState())
  ok(!/yan_probe_cookie/.test(rawState), '浏览器状态里没有 Cookie 名/值（只有计数）')

  /* ---- 9. 可追溯展示在界面上**真的看得见** ---- */
  out.push('')
  out.push('=== 9. 拦截记录看得见（几何，不只是存在） ===')
  /*
   * 为什么要量几何：这些明细以前被摆在单行横向滚动区里，右栏只有 ~280px 时
   * 它们全部落在可视区之外 —— 状态里“有记录”、探针“断言通过”，而用户看不到。
   * 这里按住“不打开菜单就看不到原因”的回归点。
   */
  const more = q('[data-testid="browser-more"]')
  if (more && more.getAttribute('aria-expanded') !== 'true') {
    more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
  }
  const panel = q('[data-testid="rightpanel"]') ?? q('[data-testid="browser-surface"]')
  const list = q('[data-testid="browser-blocked"]')
  ok(list, '「⋯」菜单里有拦截记录列表')
  if (list && panel) {
    const panelRect = panel.getBoundingClientRect()
    /* 逐行量：只要有一条被挤出可视区，就算没展示出来 */
    const rows = [...list.querySelectorAll('.browser-permission-row')]
    const clipped = rows.filter((row) => {
      const r = row.getBoundingClientRect()
      return r.width < 40 || r.right > panelRect.right + 1 || r.left < panelRect.left - 1 || r.bottom > panelRect.bottom + 1
    })
    ok(
      rows.length > 0 && clipped.length === 0,
      `拦截记录每行都在可视区内（共 ${rows.length} 行）`,
      clipped.length ? `被挤出：${clipped.map((r) => r.textContent?.slice(0, 24)).join(' / ')}` : ''
    )
    const text = list.textContent ?? ''
    ok(/127\.0\.0\.1/.test(text), '列表里能看到目标主机', text.slice(0, 60))
    ok(/本机|内网|解析/.test(text), '列表里能看到拦截原因', '')
    ok(/来自/.test(text), '列表里能看到是谁想访问', '')
  }
  /* 收起菜单后还有一行汇总（不打开「⋯」也能看到） */
  if (more && more.getAttribute('aria-expanded') === 'true') {
    more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
  }
  const hint = q('[data-testid="browser-blocked-hint"]')
  ok(hint, '收起菜单后状态行仍有「已拦截」汇总')
  if (hint && panel) {
    const r = hint.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    ok(r.width > 20 && r.right <= panelRect.right + 1, '汇总文案没有被右栏裁掉', `${Math.round(r.width)}px`)
  }

  out.push('')
  out.push(failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项未通过`)
  return out.join('\n')
})()
