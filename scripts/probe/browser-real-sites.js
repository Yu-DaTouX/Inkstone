/*
 * S0 read-only browser capability exercise against public demo pages. The only
 * page mutations are transient demo form state; no account or saved data is used.
 */
;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const runCli = async (command, waitMs = 30_000) => {
    const before = store.getState().messages.filter((message) => message.role === 'bash').length
    await window.yan.runBash(command)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const messages = store.getState().messages.filter((message) => message.role === 'bash')
      const last = messages.length > before ? messages[messages.length - 1] : null
      const call = last?.toolCalls?.[0]
      if (last?.bash && call && call.status !== 'running' && call.status !== 'pending') {
        const output = call.output ?? ''
        const receipts = [...output.matchAll(/^\s*(\{.*\})\s*$/gm)].map((match) => {
          try { return JSON.parse(match[1]) } catch { return null }
        }).filter(Boolean)
        return { exitCode: last.bash.exitCode, output, receipt: receipts.at(-1) ?? null }
      }
      await sleep(120)
    }
    return { exitCode: null, output: '', receipt: null, error: `timeout: ${command}` }
  }
  const readResult = async (receipt) => {
    if (!receipt?.resultFile) return null
    const result = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${receipt.resultFile}"`)
    try { return JSON.parse(result.output) } catch { return null }
  }
  const action = async (command) => {
    const run = await runCli(command)
    return { run, data: await readResult(run.receipt) }
  }
  const observe = async () => window.yan.browser.observe()
  const navigate = async (url) => {
    const result = await runCli(`yan browser navigate --url "${url}"`)
    const receipt = result.receipt
    return { run: result, data: await readResult(receipt) }
  }
  const waitFor = async (fn, timeout = 12_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(150)
    }
    return null
  }
  const safeRef = (element) => typeof element?.ref === 'string' && /^\d+:e\d+$/.test(element.ref)

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 30 && store.getState().conn !== 'ready'; i++) await sleep(300)
  if (store.getState().conn !== 'ready') return '  ⤺ 跳过：pi 未就绪，真实站点场景需要宿主 CLI'
  if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)

  try {
    out.push('=== 1. 真实下拉框 select ===')
    const dropdown = await navigate('https://the-internet.herokuapp.com/dropdown')
    ok(dropdown.run.exitCode === 0 && dropdown.run.receipt?.ok === true, '下拉表单页面打开', JSON.stringify(dropdown.run.receipt).slice(0, 180))
    let page = await waitFor(async () => {
      const current = await observe()
      return current.url.includes('/dropdown') && current.elements.length ? current : null
    })
    const select = page?.elements.find((element) => element.role === 'combobox')
    ok(!!page && (page.frameCount ?? 1) >= 1, 'observe 读取真实页面和交互元素', `elements=${page?.elements.length ?? 0}`)
    ok(safeRef(select), 'observe 给下拉框生成可用 ref', JSON.stringify(select ?? null))
    const selected = select && safeRef(select) ? await action(`yan browser select --ref ${select.ref} --value 2`) : { run: {}, data: null }
    ok(selected.run.receipt?.ok === true, 'select 选中 Option 2', JSON.stringify(selected.run.receipt ?? null).slice(0, 200))
    page = selected.data?.elements ? selected.data : await observe()
    ok(page?.elements.some((element) => element.role === 'combobox' && element.value === '2'), 'observe 回报下拉框的新值', page?.elements.find((element) => element.role === 'combobox')?.value ?? '')

    out.push('\n=== 2. 真实 iframe 观察 ===')
    const iframe = await navigate('https://the-internet.herokuapp.com/iframe')
    ok(iframe.run.exitCode === 0 && iframe.run.receipt?.ok === true, 'iframe demo 页面打开')
    const framePage = await waitFor(async () => {
      const current = await observe()
      return current.url.includes('/iframe') && (current.frameCount ?? 0) >= 2 ? current : null
    })
    ok(!!framePage, 'Page.getFrameTree 观察到主文档与 iframe', `frameCount=${framePage?.frameCount ?? 0}`)
    ok(!!framePage?.elements.some((element) => element.frameId && element.frameUrl), 'observe 为 iframe 控件标记 frame 身份', JSON.stringify(framePage?.elements.filter((element) => element.frameId).slice(0, 2) ?? []))

    out.push('\n=== 3. 动态页面 click → wait → screenshot ===')
    const dynamic = await navigate('https://the-internet.herokuapp.com/dynamic_loading/1')
    ok(dynamic.run.exitCode === 0 && dynamic.run.receipt?.ok === true, '动态加载 demo 页面打开')
    page = await waitFor(async () => {
      const current = await observe()
      return current.url.includes('/dynamic_loading/1') && current.elements.length ? current : null
    })
    const start = page?.elements.find((element) => /start/i.test(element.name))
    const clicked = start && safeRef(start) ? await action(`yan browser click --ref ${start.ref}`) : { run: {}, data: null }
    ok(clicked.run.receipt?.ok === true, 'click 启动延迟内容', JSON.stringify(clicked.run.receipt ?? null).slice(0, 180))
    const waited = await action('yan browser wait --text "Hello World!" --timeout 15000')
    ok(waited.run.exitCode === 0 && waited.run.receipt?.ok === true, 'wait 在超时内命中动态文本', JSON.stringify(waited.run.receipt ?? null).slice(0, 180))
    const waitedPage = waited.data?.text ? waited.data : await observe()
    ok(waitedPage?.text.includes('Hello World!'), 'wait 返回的新观察包含 Hello World!')
    const screenshot = await action('yan browser screenshot')
    ok(screenshot.run.exitCode === 0 && screenshot.run.receipt?.ok === true, '真实页面截图动作成功', JSON.stringify(screenshot.run.receipt ?? null).slice(0, 180))

    out.push('\n=== 4. 真实文本表单 type + press ===')
    const inputs = await navigate('https://the-internet.herokuapp.com/inputs')
    ok(inputs.run.exitCode === 0 && inputs.run.receipt?.ok === true, '数字输入 demo 页面打开')
    page = await waitFor(async () => {
      const current = await observe()
      return current.url.includes('/inputs') && current.elements.length ? current : null
    })
    const input = page?.elements.find((element) => element.role === 'textbox')
    const typed = input && safeRef(input) ? await action(`yan browser type --ref ${input.ref} --text 42`) : { run: {}, data: null }
    ok(typed.run.receipt?.ok === true, 'type 写入 demo 输入框', JSON.stringify(typed.run.receipt ?? null).slice(0, 180))
    const enter = await action('yan browser press --key Tab')
    ok(enter.run.receipt?.ok === true, 'press 将焦点移出字段并返回新观察', JSON.stringify(enter.run.receipt ?? null).slice(0, 180))
    const final = enter.data?.elements ? enter.data : await observe()
    ok(final?.elements.some((element) => element.role === 'textbox' && element.value === '42'), '观察确认文本表单值', final?.elements.find((element) => element.role === 'textbox')?.value ?? '')
  } catch (error) {
    ok(false, '真实站点场景抛出异常', error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await window.yan.browser.close().catch(() => undefined)
  }
  return out.join('\n')
})()
