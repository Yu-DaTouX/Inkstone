;(async () => {
  const BOUNDARY = 'http://127.0.0.1:39873'
  const REBIND = 'http://127-0-0-1.sslip.io:39873'
  const PUBLIC_CONTROL = 'http://1-1-1-1.sslip.io/'

  const frameNetworkOnly = window.__yanBrowserFrameNetworkOnly === true
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
  const browserAction = async (command) => {
    const before = store.getState().messages.filter(message => message.role === 'bash').length
    await window.yan.runBash(command)
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const messages = store.getState().messages.filter(message => message.role === 'bash')
      const last = messages.length > before ? messages.at(-1) : null
      const call = last?.toolCalls?.[0]
      if (last?.bash && call && call.status !== 'running' && call.status !== 'pending') {
        const receipts = (call.output ?? '').split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
        const receipt = receipts.at(-1)
        if (command.startsWith('yan browser')) out.push(`  操作回执：exit=${last.bash.exitCode} ok=${receipt?.ok} code=${receipt?.code ?? ''}`)
        return { ok: last.bash.exitCode === 0 && receipt?.ok === true, receipt, output: call.output ?? '' }
      }
      await sleep(120)
    }
    out.push(`  操作未完成：${command}`)
    return { ok: false }
  }
  const actionObservation = async () => {
    const run = await browserAction('yan browser observe')
    if (!run.ok || !run.receipt?.resultFile) throw new Error('CLI observation failed')
    const read = await browserAction(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${run.receipt.resultFile}"`)
    return JSON.parse(read.output)
  }
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await fn()) return true
      await sleep(150)
    }
    return false
  }
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

  if (!frameNetworkOnly) {
    out.push('=== 1. 本地 fixture 服务 ===')
    await store.getState().openBrowser(`${BOUNDARY}/whoami`)
    await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
    const served = (await docText()).trim()
    ok(/^cookie=none hash=none$/.test(served), '本地服务可达（此刻还没有 Cookie，符合预期）', served.slice(0, 48))

    out.push('')
    out.push('=== 2. 本地预览边界（正向对照，不能一刀切拦死） ===')
    await store.getState().openBrowser(BOUNDARY)
    await until(async () => (await docUrl()).startsWith(BOUNDARY), 15000)
    const localDoc = await docUrl()
    ok(localDoc.startsWith(BOUNDARY), '本地页面真的加载了', localDoc)
    ok(/download/i.test(await docText()), '页面内容被读到（说明没被拦）')
  }

  out.push('')
  out.push('=== 2a. 同源与跨源 frame 表单 + network ===')
  await store.getState().openBrowser(`${BOUNDARY}/browser-fixture`)
  await until(async () => (await docUrl()).startsWith(`${BOUNDARY}/browser-fixture`), 15000)
  let frameObservation
  await until(async () => {
    frameObservation = await window.yan.browser.observe()
    return frameObservation.elements.some((e) => /same[- ]choice/i.test(e.name)) &&
      frameObservation.elements.some((e) => /cross[- ]choice/i.test(e.name)) &&
      frameObservation.elements.some((e) => /Continue frame/i.test(e.name))
  }, 15000)
  frameObservation ??= await window.yan.browser.observe()
  out.push(`  观察到 ${frameObservation.elements.length} 个元素、${frameObservation.frameCount ?? '?'} 个 frame：${JSON.stringify(frameObservation.elements.map((e) => ({ name: e.name, role: e.role, frameId: e.frameId, frameUrl: e.frameUrl })))}`)
  out.push(`  视口诊断：${JSON.stringify([...document.querySelectorAll('.browser-viewport')].map(el => ({ rect: el.getBoundingClientRect().toJSON(), hidden: !!el.closest('[hidden]') })))} observation=${JSON.stringify({ ...frameObservation, elements: undefined }).slice(0, 1200)}`)
  const sameChoice = frameObservation.elements.find((e) => /same[- ]choice/i.test(e.name))
  const crossChoice = frameObservation.elements.find((e) => /cross[- ]choice/i.test(e.name))
  const crossSubmit = frameObservation.elements.find((e) => /Continue frame/i.test(e.name))
  ok(!!sameChoice, 'observe 找到同源 iframe 下拉框', JSON.stringify(sameChoice ?? null))
  ok(!!crossChoice && !!crossChoice.frameId, 'observe 找到跨源 iframe 下拉框并附 frameId', JSON.stringify(crossChoice ?? null))
  ok(/localhost:39873\/browser-fixture-cross/.test(crossChoice?.frameUrl ?? ''), '跨源元素标出所属 frame URL，且剥掉 query 参数', crossChoice?.frameUrl ?? '')
  ok(!!crossSubmit && !!crossSubmit.frameId, 'observe 找到跨源 iframe 按钮并附 frameId', JSON.stringify(crossSubmit ?? null))
  const sameAction = (await actionObservation()).elements.find(e => /same[- ]choice/i.test(e.name))
  const chosen = sameAction ? await browserAction(`yan browser select --ref "${sameAction.ref}" --value b`) : { ok: false }
  ok(chosen.ok, '同源 iframe select 能执行并返回新观察')
  const afterSelect = await actionObservation()
  const crossChoiceNext = afterSelect.elements.find((e) => /cross-choice/.test(e.name))
  const crossChosen = crossChoiceNext ? await browserAction(`yan browser select --ref "${crossChoiceNext.ref}" --value b`) : { ok: false }
  ok(crossChosen.ok, '跨源 iframe select 能执行并返回新观察')
  const afterCrossSelect = await actionObservation()
  const submitNext = afterCrossSelect.elements.find((e) => /Continue frame/.test(e.name))
  const fixtureFetch = (entry) => entry.url === `${BOUNDARY}/` && entry.resourceType === 'Fetch' && entry.method === 'GET'
  const beforeFetchCount = (await window.yan.browser.network()).entries.filter(fixtureFetch).length
  const clicked = submitNext ? await browserAction(`yan browser click --ref "${submitNext.ref}"`) : { ok: false }
  ok(clicked.ok, '跨源 iframe 点击能投递到正确屏幕坐标')
  const updated = await until(async () => /frame submitted/.test(await docText()), 8000)
  ok(updated, '跨源 iframe 表单点击通过 postMessage 更新了父页面')
  let network
  await until(async () => {
    network = await window.yan.browser.network()
    return network.entries.filter(fixtureFetch).length > beforeFetchCount &&
      network.entries.filter(fixtureFetch).at(-1)?.state === 'finished'
  }, 8000)
  out.push(`  network entries=${network.entries.length}: ${JSON.stringify(network.entries)}`)
  const frameRequest = network.entries.filter(fixtureFetch).at(-1)
  ok(network.entries.filter(fixtureFetch).length > beforeFetchCount && frameRequest?.status === 200 && frameRequest?.state === 'finished', 'network 收到页面请求及响应状态', JSON.stringify(frameRequest ?? null))
  ok(!network.entries.some((entry) => /private=fixture-secret/.test(entry.url)), 'network URL 剥掉 query 中的私有哨兵')

  if (frameNetworkOnly) {
    out.push('')
    out.push(failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项未通过`)
    return out.join('\n')
  }

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
    const before = (st().permissions ?? []).find((p) => p.permission === permissionName)?.status
    ok(before === 'blocked', '撤销后状态立即生效（不是只改了显示）')
  }

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
  const downloadText = q('[data-testid="browser-download"]')?.textContent ?? ''
  ok(/未自动打开/.test(downloadText), '界面明说「未自动打开」', downloadText.slice(0, 48))

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

  out.push('')
  out.push('=== 7. 远程页面 → 本机服务 ===')
  await store.getState().openBrowser('https://example.com/')
  const remoteOk = await until(async () => /example\.com/.test(await docUrl()), 25000)
  if (!remoteOk) {
    skip('远程页面借道本机服务', '当前拿不到公网（打不开 example.com）')
  } else {
    ok(remoteOk, '远程页面已加载', await docUrl())
    await store.getState().openBrowser(`${BOUNDARY}/private`)
    await until(async () => (await docUrl()).startsWith(BOUNDARY), 12000)
    ok((await docUrl()).startsWith(BOUNDARY), '用户/agent 明确打开本机地址时放行（本地预览）', await docUrl())

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

  out.push('')
  out.push('=== 8. DNS 重绑定 ===')
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
      await store.getState().openBrowser(`${REBIND}/whoami`)
      await sleep(3500)
      ok(!/sslip\.io/.test(await docUrl()), 'agent 自己发起这类导航也不放行（不给“读本机服务”的原语）', await docUrl())
    }
  }

  const rawState = JSON.stringify(await window.yan.browser.getState())
  ok(!/yan_probe_cookie/.test(rawState), '浏览器状态里没有 Cookie 名/值（只有计数）')

  out.push('')
  out.push('=== 9. 拦截记录看得见（几何，不只是存在） ===')
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
