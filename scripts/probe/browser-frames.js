/*
 * Cross-frame browser regression: same-origin and cross-origin iframe controls,
 * ref attribution, frame-local interaction coordinates, and the redacted network ledger.
 */
;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const runCli = async (command, waitMs = 20000) => {
    const started = Date.now()
    await window.yan.runBash(command)
    const end = Date.now() + waitMs
    while (Date.now() < end) {
      const messages = store.getState().messages.filter((message) => message.role === 'bash')
      const last = messages[messages.length - 1]
      const call = last?.toolCalls?.[0]
      if (last?.bash && call && call.status !== 'running' && call.status !== 'pending') {
        const output = call.output ?? ''
        const receipt = [...output.matchAll(/^\s*(\{.*\})\s*$/gm)].map((match) => {
          try { return JSON.parse(match[1]) } catch { return null }
        }).filter(Boolean).at(-1)
        return { exitCode: last.bash.exitCode, output, receipt, elapsed: Date.now() - started }
      }
      await sleep(120)
    }
    return { exitCode: null, output: '', receipt: null, elapsed: Date.now() - started, error: `timeout: ${command}` }
  }
  const resultFile = async (receipt) => {
    if (!receipt?.resultFile) return null
    const read = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${receipt.resultFile}"`)
    try { return JSON.parse(read.output) } catch { return null }
  }
  const action = async (command) => {
    const run = await runCli(command)
    return { run, data: await resultFile(run.receipt) }
  }
  const until = async (fn, timeout = 8000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await sleep(120)
    }
    return null
  }
  const base = 'http://127.0.0.1:39873'
  localStorage.setItem('yan.onboarded', '1')
  if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  await sleep(250)

  try {
    await store.getState().openBrowser(`${base}/browser-fixture`)
    const loaded = await until(async () => (await window.yan.browser.observe()).url.includes('/browser-fixture'))
    ok(!!loaded, '本地跨 frame fixture 已打开')
    await sleep(300)

    let observation = await window.yan.browser.observe()
    out.push(`  page text=${JSON.stringify(observation.text.slice(0, 300))}`)
    out.push(`  observe frameCount=${observation.frameCount ?? '?'} elements=${observation.elements.length} observedFrames=${observation.observedFrameCount ?? '?'}: ${JSON.stringify(observation.elements.map((e) => ({ name: e.name, role: e.role, frameId: e.frameId, frameUrl: e.frameUrl })))}`)
    out.push(`  blockedRequests=${JSON.stringify((await window.yan.browser.getState()).blockedRequests ?? [])}`)
    const sameChoice = observation.elements.find((element) => /same[- ]choice/i.test(element.name))
    const crossChoice = observation.elements.find((element) => /cross[- ]choice/i.test(element.name))
    const crossInput = observation.elements.find((element) => /cross-input/i.test(element.name))
    const crossSubmit = observation.elements.find((element) => /continue frame/i.test(element.name))
    ok((observation.frameCount ?? 0) >= 3, 'Page.getFrameTree reports top, same-origin, and cross-origin frames', String(observation.frameCount))
    ok(!!sameChoice, 'observe returns same-origin iframe select', JSON.stringify(sameChoice ?? null))
    ok(!!crossChoice?.frameId, 'observe returns cross-origin iframe select with frameId', JSON.stringify(crossChoice ?? null))
    ok(/localhost:39873\/browser-fixture-cross/.test(crossChoice?.frameUrl ?? ''), 'cross-origin element reports a query-redacted frame URL', crossChoice?.frameUrl ?? '')
    ok(!!crossInput?.frameId, 'observe returns cross-origin iframe text input', JSON.stringify(crossInput ?? null))
    ok(!!crossSubmit?.frameId, 'observe returns cross-origin iframe submit button', JSON.stringify(crossSubmit ?? null))

    const sameResult = sameChoice ? await action(`yan browser select --ref ${sameChoice.ref} --value b`) : { run: {}, data: null }
    ok(sameResult.run.receipt?.ok === true, 'select works for same-origin iframe controls', JSON.stringify(sameResult.run.receipt ?? null))
    observation = sameResult.data?.elements ? sameResult.data : await window.yan.browser.observe()
    const input = observation.elements.find((element) => /cross-input/i.test(element.name))
    const typed = input ? await action(`yan browser type --ref ${input.ref} --text YAN_CROSS_FRAME_TYPED`) : { run: {}, data: null }
    ok(typed.run.receipt?.ok === true, 'type works through the cross-origin iframe session', JSON.stringify(typed.run.receipt ?? null))
    ok(await until(async () => (await window.yan.browser.observe()).text.includes('YAN_TYPED:YAN_CROSS_FRAME_TYPED')), 'cross-origin input event reaches its parent through postMessage')

    /* Polling observe refreshes generation-scoped refs; reacquire after the wait. */
    observation = await window.yan.browser.observe()
    const choice = observation.elements.find((element) => /cross[- ]choice/i.test(element.name))
    const selected = choice ? await action(`yan browser select --ref ${choice.ref} --value b`) : { run: {}, data: null }
    ok(selected.run.receipt?.ok === true, 'select works through the cross-origin iframe session', JSON.stringify(selected.run.receipt ?? null))
    observation = selected.data?.elements ? selected.data : await window.yan.browser.observe()
    const submit = observation.elements.find((element) => /continue frame/i.test(element.name))
    const clicked = submit ? await action(`yan browser click --ref ${submit.ref}`) : { run: {}, data: null }
    ok(clicked.run.receipt?.ok === true, 'click maps child-frame coordinates into the top-level viewport', JSON.stringify(clicked.run.receipt ?? null))
    ok(await until(async () => (await window.yan.browser.observe()).text.includes('frame submitted')), 'cross-origin frame action reaches the parent page')

    const network = await window.yan.browser.network()
    const request = network.entries.find((entry) => entry.url.includes('/browser-fixture-network'))
    ok(!!request && request.method === 'GET' && request.status === 200, 'network exposes recent request method and response status', JSON.stringify(request ?? null))
    ok(!JSON.stringify(network).includes('fixture-secret'), 'network snapshot strips URL query secrets')
    ok(network.entries.length <= network.limit && network.limit === 80, 'network snapshot remains bounded to 80 entries')
  } catch (error) {
    ok(false, 'probe threw an exception', error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await window.yan.browser.close()
  }
  return out.join('\n')
})()
