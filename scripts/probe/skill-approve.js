/**
 * 技能自接入：GitHub 发现 → 限时批准面板 → 本次会话 / 我的技能（cost 0，不调用模型）。
 *
 * 真实 renderer 经 `window.yan.runBash` 调真实 CLI，宿主从 anthropics/skills 取固定提交的
 * 技能，批准请求进入真实问题面板。依次验证：选「仅本次会话使用」→ 落进会话目录；
 * 点「跳过」→ 不安装；不答复 → 到时自动跳过；设置页分类与「保留到我的技能」。
 * 需要能访问 GitHub；离线时整条跳过，不记成通过。
 */
;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(cond)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const click = (element) => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const deadline = Date.now() + 280000

  const waitFor = async (fn, step = 150, until = deadline) => {
    while (Date.now() < until) {
      const value = await fn()
      if (value) return value
      await sleep(step)
    }
    return null
  }
  const bashMessages = () => store.getState().messages.filter((message) => message.role === 'bash')
  const startBash = (command) => {
    const before = new Set(bashMessages().map((message) => message.id))
    const promise = window.yan.runBash(command)
    const done = waitFor(() => bashMessages().find((candidate) => {
      if (before.has(candidate.id)) return false
      const call = candidate.toolCalls?.[0]
      return call && call.status !== 'running' && call.status !== 'pending'
    }), 150)
    return { promise, done }
  }
  const finish = async (started) => {
    await started.promise
    const message = await started.done
    return String(message?.toolCalls?.[0]?.output ?? '')
  }
  const runBash = async (command) => finish(startBash(command))
  const lastJson = (text) => {
    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'))
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]) } catch { /* 往前找 */ }
    }
    return null
  }
  const approvalRequest = () => store.getState().uiRequests.find((item) => item.purpose === 'approval')
  const early = (message) => {
    out.push(message)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore')

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let index = 0; index < 25; index += 1) {
      const card = q('.ob-card')
      if (!card) break
      const button = [...card.querySelectorAll('button')].find((candidate) => /开始使用|完成/.test(candidate.textContent))
      if (button) click(button)
      await sleep(200)
    }
    await store.getState().setWorkMode('standard')
    await sleep(300)
    ok(store.getState().conn === 'ready', 'pi 已连接')

    out.push('=== 1. 发现：点名仓库列出固定提交的技能 ===')
    const discovered = lastJson(await runBash('yan capabilities discover --repo anthropics/skills'))
    const ids = discovered?.summary?.candidateIds ?? discovered?.candidateIds ?? []
    const idOf = (name) => ids.find((id) => new RegExp(`^github:anthropics/skills/skills/${name}@[0-9a-f]{12}$`).test(id))
    if (ids.length === 0) return early(`  ⤺ 跳过：GitHub 不可用（${JSON.stringify(discovered)?.slice(0, 300)}）`)
    ok(!!idOf('pdf') && !!idOf('xlsx'), 'GitHub 候选带仓库、目录与固定提交', ids.slice(0, 4).join(', '))

    out.push('=== 2. 批准面板 → 仅本次会话使用 ===')
    const first = startBash(`yan capabilities acquire --candidate "${idOf('pdf')}"`)
    const request = await waitFor(() => (approvalRequest() && q('[data-testid="question-panel"]') ? approvalRequest() : null))
    ok(!!request, '接入请求进入问题面板')
    if (request) {
      ok(q('[data-testid="question-panel-badge"]')?.getAttribute('data-purpose') === 'approval', '徽标标为授权')
      ok(/授权接入技能「pdf」/.test(request.title ?? ''), '标题写明技能名', request.title)
      ok(/来源：github\.com\/anthropics\/skills\/skills\/pdf（提交 [0-9a-f]{12}）/.test(request.message ?? ''), '正文写明来源与提交')
      ok(/个脚本（\.py）/.test(request.message ?? ''), '正文如实列出脚本')
      ok(request.options?.length === 2, '两个范围选项', JSON.stringify(request.options))
      const timer = await waitFor(() => q('[data-testid="question-panel-timer"]'), 100, Date.now() + 5000)
      const remaining = Number(timer?.getAttribute('data-remaining') ?? 0)
      ok(remaining > 100 && remaining <= 120, '倒计时约 2 分钟', String(remaining))
      out.push(`  面板正文：${String(request.message).replace(/\n/g, ' ⏎ ')}`)
      click(qa('.qpanel-option').find((button) => /仅本次会话使用/.test(button.textContent)))
    }
    const installed = lastJson(await finish(first))
    ok(installed?.summary?.state === 'installed' && installed?.summary?.scope === 'session', 'acquire 返回已接入本次会话', JSON.stringify(installed?.summary))

    out.push('=== 3. 跳过 → 不安装 ===')
    const second = startBash(`yan capabilities acquire --candidate "${idOf('xlsx')}"`)
    await waitFor(() => (approvalRequest() && q('[data-testid="question-panel-skip"]') ? true : null))
    click(q('[data-testid="question-panel-skip"]'))
    const skipped = lastJson(await finish(second))
    ok(skipped?.summary?.state === 'skipped' && skipped?.summary?.reason === 'declined', '点跳过：不安装', JSON.stringify(skipped?.summary))

    out.push('=== 4. 设置页分类与保留到我的技能 ===')
    const snapshot = await window.yan.capabilities.snapshot()
    const sessionSkill = snapshot.skills.find((skill) => skill.origin === 'session' && skill.title === 'pdf')
    ok(!!sessionSkill, '设置页把 pdf 列为本次会话技能')
    ok(!snapshot.skills.some((skill) => skill.title === 'xlsx' && skill.origin === 'session'), '跳过的技能没有出现')
    ok(snapshot.skills.some((skill) => skill.origin === 'bundled'), '随包技能单独成组')
    const promoted = await window.yan.capabilities.sessionSkill('promote', 'pdf')
    ok(promoted.ok, '保留到我的技能', JSON.stringify(promoted))
    const after = await window.yan.capabilities.snapshot()
    ok(!after.skills.some((skill) => skill.origin === 'session' && skill.title === 'pdf'), '保留后不再列在本次会话')

    out.push('=== 5. 不答复 → 到时自动跳过（约 2 分钟）===')
    const third = startBash(`yan capabilities acquire --candidate "${idOf('xlsx')}"`)
    ok(!!(await waitFor(() => approvalRequest())), '再次出现批准面板')
    const timedOut = lastJson(await finish(third))
    ok(timedOut?.summary?.state === 'skipped' && timedOut?.summary?.reason === 'timeout', '超时：自动跳过，不安装', JSON.stringify(timedOut?.summary))
    ok(!approvalRequest(), '超时后面板收起')
    const log = store.getState().questionLog ?? []
    out.push(`  问答记录条数：${Array.isArray(log) ? log.length : 'n/a'}`)
  } catch (error) {
    ok(false, '探针异常', String(error?.stack ?? error).slice(0, 400))
  }
  return out.join('\n')
})()
