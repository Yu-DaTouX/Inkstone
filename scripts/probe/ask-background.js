;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const deadline = Date.now() + 110000
  const waitFor = async (fn, step = 300) => {
    while (Date.now() < deadline) {
      const v = await fn()
      if (v) return v
      await sleep(step)
    }
    return null
  }
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const rowOf = (path) => qa('[data-session-path]').find((e) => norm(e.dataset.sessionPath) === norm(path))

  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(250)
      } else await sleep(120)
    }

    await store.getState().setWorkMode('standard')
    await sleep(400)
    ok(store.getState().conn === 'ready', 'pi 已连接', String(store.getState().conn))
    await store.getState().setRailPinned(true)

    const list = await waitFor(() => {
      const all = store.getState().sessions ?? []
      const a = all.find((s) => String(s.id ?? '').includes('yan-ab-a'))
      const b = all.find((s) => String(s.id ?? '').includes('yan-ab-b'))
      return a && b ? { a, b } : null
    }, 400)
    if (!ok(!!list, '会话列表里有 N12 的 A / B 两条 fixture 会话'))
      return out.join('\n')
    const { a: A, b: B } = list
    out.push(`  A=${A.id}（${A.cwd}）`)
    out.push(`  B=${B.id}（${B.cwd}）`)
    await store.getState().refreshSessions()
    await sleep(300)

    out.push('')
    out.push('=== 1. 在 A 上触发一次提问 ===')
    const rowA = rowOf(A.path)
    const nameA = rowA?.querySelector('button.srow')
    if (nameA) click(nameA)
    else await store.getState().switchSession(A.path)
    const onA = await waitFor(() => (norm(store.getState().session?.sessionFile) === norm(A.path) ? true : null), 400)
    ok(!!onA, 'A 成为当前会话')

    const bashMessages = () => store.getState().messages.filter((m) => m.role === 'bash')
    const runBash = async (command) => {
      const before = new Set(bashMessages().map((m) => m.id))
      const promise = window.yan.runBash(command)
      await promise
      const message = await waitFor(() => {
        const candidate = bashMessages().find((m) => {
          if (before.has(m.id)) return false
          const call = m.toolCalls?.[0]
          return call && call.status !== 'running' && call.status !== 'pending' ? m : null
        })
        return candidate
      }, 150)
      return { message, exitCode: message?.bash?.exitCode ?? null }
    }
    const tempDirResult = await runBash(`node -e "process.stdout.write(require('os').tmpdir())"`)
    const tempDir = String(tempDirResult.message?.toolCalls?.[0]?.output ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop()
    const requestPath = `${tempDir}\\yan-question-background.json`
    const requestB64 = btoa(
      unescape(
        encodeURIComponent(
          JSON.stringify({ question: '后台会话请选择数据库', options: ['SQLite', 'PostgreSQL'], timeout: 60_000 })
        )
      )
    )
    const prepared = await runBash(
      `node -e "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(require('os').tmpdir(),'yan-question-background.json'),Buffer.from('${requestB64}','base64'))"`
    )
    ok(!!tempDir && prepared.exitCode === 0, '已在 A 的隔离临时目录准备 question ask 请求文件')

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const prompt =
      `这是一次功能自测。请只做一件事：使用 bash 执行 yan question ask --request-file "${requestPath}"，` +
      '不要调用名为 question 的模型工具，不要用普通文字提问，不要执行其它命令。'
    let sendable = false
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      const ta = q('[data-testid="composer"]')
      if (ta && ta.isConnected) {
        setter.call(ta, prompt)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(400)
        const btn = q('[data-testid="send"]')
        if (btn && !btn.disabled) {
          sendable = true
          break
        }
      }
      await sleep(500)
    }
    ok(sendable, '输入后发送键可用')
    if (!sendable) return out.join('\n')
    click(q('[data-testid="send"]'))

    out.push('')
    out.push('=== 2. A 出现未回答的提问 ===')
    const pending = await waitFor(async () => {
      await store.getState().syncRunners()
      const reqs = store.getState().uiRequests ?? []
      const r = (store.getState().runners ?? []).find((x) => norm(x.sessionFile) === norm(A.path))
      return reqs.length > 0 && r ? { reqs, r } : null
    }, 500)
    ok(!!pending, '主进程收到了 pi 的 UI 请求（pendingUi 非空）', String(pending?.reqs?.length ?? 0))
    if (!pending) {
      out.push('  最近助手文字：' + JSON.stringify(String(store.getState().messages.at(-1)?.text ?? '').slice(0, 200)))
       out.push('  question 模型工具行：' + qa('.trow').some((r) => r.getAttribute('data-tool') === 'question'))
      return out.join('\n')
    }
    ok(pending.r.waiting === true, 'A 的运行实例被标成 waiting（主进程侧的真源）', JSON.stringify(pending.r.waiting))
    const panel = q('[data-testid="question-panel"]')
    ok(!!panel, '提问面板渲染出来了（非模态，在输入区上方）')
    const waitA = await waitFor(() => qa('[data-testid="rail-waiting"]').some((e) => rowOf(A.path)?.contains(e)), 300)
    ok(!!waitA, '左栏 A 那一行显示「等待输入」状态槽（前台）')
    out.push(`  A 行状态槽 = ${JSON.stringify((rowOf(A.path)?.querySelector('.session-status')?.getAttribute('title')) ?? '')}`)

    out.push('')
    out.push('=== 3. 切走之后：后台会话仍在等输入 ===')
    const rowB = rowOf(B.path)
    const nameB = rowB?.querySelector('button.srow')
    ok(!!nameB, '（前提）左栏能找到 B 那一行并点它')
    if (nameB) click(nameB)
    const onB = await waitFor(() => (norm(store.getState().session?.sessionFile) === norm(B.path) ? true : null), 400)
    ok(!!onB, '视图切到了 B（不同 cwd，允许并行）')
    const stillWaiting = await waitFor(async () => {
      await store.getState().syncRunners()
      const slot = qa('[data-testid="rail-waiting"]').find((e) => rowOf(A.path)?.contains(e))
      return slot ? true : null
    }, 400)
    ok(!!stillWaiting, '**切走之后 A 那一行仍然显示「等待输入」**（这就是缺的那条真实窗口证据）')
    const rA = (store.getState().runners ?? []).find((x) => norm(x.sessionFile) === norm(A.path))
    out.push(`  A 实例 = ${JSON.stringify({ running: rA?.running, waiting: rA?.waiting, conn: rA?.conn })}`)
    ok(rA?.waiting === true, '主进程侧 A 仍然是 waiting（不是前端留下的残影）')
    ok(
      !qa('[data-testid="rail-waiting"]').some((e) => rowOf(B.path)?.contains(e)),
      'B 那一行没有 waiting 槽（状态是按会话分开的，不是全局一个）'
    )
    out.push(`  askbackground.A=${A.id}`)
    out.push(`  askbackground.B=${B.id}`)

  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
