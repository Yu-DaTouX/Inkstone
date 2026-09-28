/*
 * Real search → open → observe acceptance (实施-27 S4).
 * Uses one read-only Wikipedia query. Search results are treated as untrusted input:
 * only a plain HTTPS Wikipedia article URL without shell metacharacters is passed
 * to the CLI, and no page action other than navigation/observation is performed.
 */
;(async () => {
  const out = []
  const ok = (condition, label, detail = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
    return Boolean(condition)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const runCli = async (command, waitMs = 60_000) => {
    await window.yan.runBash(command)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const messages = store.getState().messages.filter((message) => message.role === 'bash')
      const last = messages[messages.length - 1]
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
    return { exitCode: null, output: '', receipt: null, error: 'Timed out waiting for shell output' }
  }
  const readResult = async (file) => {
    const read = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${file}"`)
    try { return JSON.parse(read.output) } catch { return null }
  }
  const until = async (fn, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(150)
    }
    return null
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 30; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(300)
  }
  if (store.getState().conn !== 'ready') return '  ⤺ 跳过：pi 未就绪，真实搜索需要宿主 bash 能力'
  if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)

  try {
    out.push('=== 1. 查询真实搜索后端 ===')
    const search = await runCli('yan search query --query-text "Sydney" --sources wikipedia --limit-per-source 3 --limit-total 3')
    const searchReceipt = search.receipt
    ok(search.exitCode === 0 && searchReceipt?.ok === true, 'yan search query 成功', JSON.stringify(searchReceipt).slice(0, 280))
    const outcome = searchReceipt?.resultFile ? await readResult(searchReceipt.resultFile) : null
    const item = outcome?.items?.find((candidate) => typeof candidate?.url === 'string' && candidate.url.startsWith('https://'))
    ok(!!item, '搜索结果文件含真实 HTTPS 结果', JSON.stringify(item && { source: item.source, title: item.title, url: item.url }))
    if (!item) return out.join('\n')

    const safeUrl = /^https:\/\/(?:[a-z0-9-]+\.)*wikipedia\.org\/wiki\/[a-z0-9_%./()'-]+$/i.test(item.url) &&
      !/["`$;&|<>\s\\]/.test(item.url)
    ok(safeUrl, '结果 URL 符合只读 Wikipedia 页面白名单', item.url)
    if (!safeUrl) return out.join('\n')

    out.push('\n=== 2. 打开搜索结果并观察 ===')
    const navigation = await runCli(`yan browser navigate --url "${item.url}"`)
    ok(navigation.exitCode === 0 && navigation.receipt?.ok === true, 'yan browser navigate 成功', JSON.stringify(navigation.receipt).slice(0, 260))
    const observed = await until(async () => {
      const state = await window.yan.browser.observe()
      return state?.url && state.url !== 'about:blank' ? state : null
    })
    const expected = new URL(item.url)
    const actual = observed?.url ? new URL(observed.url) : null
    ok(!!observed && actual?.hostname === expected.hostname && actual.pathname.startsWith('/wiki/'), 'observe 确认浏览器仍在搜索结果域与文章路径', observed?.url ?? '')
    ok(typeof observed?.title === 'string' && observed.title.trim().length > 0, '真实页面标题已观察到', observed?.title ?? '')
    out.push(`  搜索结果：${item.title} · ${item.url}`)
    out.push(`  浏览器观察：${observed?.title ?? '(无标题)'} · ${observed?.url ?? '(无 URL)'}`)
  } catch (error) {
    ok(false, 'search → open → observe 抛出异常', error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await window.yan.browser.close().catch(() => undefined)
  }
  return out.join('\n')
})()
