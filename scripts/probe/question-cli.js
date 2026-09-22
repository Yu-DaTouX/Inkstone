/**
 * `yan question ask` 宿主提问链路（cost 0）。
 *
 * 这条探针不让模型参与：真实 renderer 通过 `window.yan.runBash` 调真实 CLI，
 * CLI 再走真实 CapabilityServer / AgentController，问题请求进入真实问题面板，
 * 点击后答案回到同一个 CLI 请求并落到 resultFile。它用来证明 question.js
 * 移除模型工具后，唯一宿主入口仍然保留完整的等待 / 回答 / 自主模式语义。
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
  const deadline = Date.now() + 100000

  const waitFor = async (fn, step = 150) => {
    while (Date.now() < deadline) {
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
    const done = waitFor(() => {
      const message = bashMessages().find((candidate) => {
        if (before.has(candidate.id)) return false
        const call = candidate.toolCalls?.[0]
        return call && call.status !== 'running' && call.status !== 'pending' ? candidate : null
      })
      return message
    }, 120)
    return { promise, done }
  }

  const runBash = async (command) => {
    const started = startBash(command)
    await started.promise
    const message = await started.done
    const call = message?.toolCalls?.[0]
    return {
      message,
      output: String(call?.output ?? ''),
      exitCode: message?.bash?.exitCode ?? null
    }
  }

  const lastJson = (text) => {
    const lines = String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index])
      } catch {
        /* 继续向前找 */
      }
    }
    return null
  }

  const writeRequest = async (name, value) => {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    const command =
      `node -e "const fs=require('fs'),p=require('path');` +
      `fs.writeFileSync(p.join(require('os').tmpdir(),'${name}'),Buffer.from('${encoded}','base64'))"`
    return runBash(command)
  }

  const readJsonFile = async (path) => {
    const result = await runBash(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try {
      return JSON.parse(String(result.output).trim())
    } catch {
      return null
    }
  }

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
      if (button) {
        click(button)
        await sleep(250)
      } else {
        await sleep(120)
      }
    }

    await store.getState().setWorkMode('standard')
    await sleep(350)
    ok(store.getState().conn === 'ready', 'pi 已连接')
    const tempDirResult = await runBash(`node -e "process.stdout.write(require('os').tmpdir())"`)
    const tempDir = String(tempDirResult.output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop()
    ok(!!tempDir, '读取到宿主隔离实例的系统临时目录')

    out.push('=== 1. 标准模式：CLI 请求进入真实问题面板 ===')
    const request = {
      question: 'CLI 真实链路请选择数据库',
      options: ['SQLite', 'PostgreSQL'],
      timeout: 30_000
    }
    const written = await writeRequest('yan-question-cli-standard.json', request)
    ok(written.exitCode === 0, '请求文件写入系统临时目录')
    const standardPath = `${tempDir}\\yan-question-cli-standard.json`

    const beforeQuestionTools = store
      .getState()
      .messages.flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.name === 'question')
    const pending = startBash(`yan question ask --request-file "${standardPath}"`)
    const panel = await waitFor(() => {
      const requestState = store.getState().uiRequests.find((item) => String(item.id).startsWith('yan-question-'))
      return requestState && q('[data-testid="question-panel"]') ? requestState : null
    }, 150)
    ok(!!panel, '宿主 CLI 请求进入问题面板（不是 pi extension_ui_request）')
    if (panel) {
      ok(panel.method === 'select', '面板请求类型为 select')
      ok(panel.message === request.question, '面板展示的题目来自请求文件')
      ok(panel.options?.includes('SQLite') && panel.options?.includes('PostgreSQL'), '面板展示两个业务选项')
      click(qa('.qpanel-option').find((button) => /SQLite/i.test(button.textContent)))
    }
    await pending.promise
    const standardMessage = await pending.done
    const standardOutput = String(standardMessage?.toolCalls?.[0]?.output ?? '')
    const standardReceipt = lastJson(standardOutput)
    ok(standardMessage?.bash?.exitCode === 0, '回答后 CLI 正常结束')
    ok(standardReceipt?.ok === true && standardReceipt?.summary?.kind === 'question', 'stdout 回执是 question ask 成功摘要')
    ok(typeof standardReceipt?.resultFile === 'string', '回执提供完整结果 resultFile')
    const standardData = standardReceipt?.resultFile ? await readJsonFile(standardReceipt.resultFile) : null
    ok(standardData?.answer === 'SQLite' && standardData?.cancelled === false, 'resultFile 回填了用户选择且未误判取消')
    const afterQuestionTools = store
      .getState()
      .messages.flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.name === 'question')
    ok(afterQuestionTools.length === beforeQuestionTools.length, '真实消息中没有恢复 question 模型工具调用')
    ok(!q('[data-testid="question-panel"]'), '回答后问题面板关闭')

    out.push('=== 2. 自主模式：CLI 请求不弹面板并如实返回 ===')
    await store.getState().setWorkMode('autonomous')
    await sleep(350)
    const autoRequest = await writeRequest('yan-question-cli-auto.json', { question: '自主模式不应显示此问题', options: ['A', 'B'] })
    ok(autoRequest.exitCode === 0, '自主模式请求文件写入成功')
    const auto = await runBash(`yan question ask --request-file "${tempDir}\\yan-question-cli-auto.json"`)
    const autoReceipt = lastJson(auto.output)
    ok(auto.exitCode === 0, '自主模式 CLI 正常结束')
    ok(autoReceipt?.ok === true, '自主模式仍返回成功回执')
    const autoData = autoReceipt?.resultFile ? await readJsonFile(autoReceipt.resultFile) : null
    ok(autoData?.autonomous === true && autoData?.answer === null && autoData?.cancelled === false, '自主模式返回自行决策标记，不猜用户答案')
    ok(!q('[data-testid="question-panel"]'), '自主模式没有弹出问题面板')

    await store.getState().setWorkMode('standard')
    out.push('  已还原工作模式 → 标准')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
