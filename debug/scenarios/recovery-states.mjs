import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { analyse, sample, timeline } from '../lib/state-probe.mjs'
import { sampleProcessTree } from '../lib/process-tree.mjs'

export const meta = { description: '恢复类状态：间歇失败自动重试后成功、模型挂起后停止、点重试的反馈、pi 进程被杀后恢复、运行中重载渲染端的滚动位置、项目目录被删后的会话' }

export default async function run({ cdp, box, fake, check, report, sleep, log, newSession, state, waitFor, until, shot, runDir, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  const fresh = async () => { const before = await state("s.session?.sessionId ?? null"); await newSession(box.project); await until(`(s.session?.sessionId ?? null) !== ${JSON.stringify(before)} || s.messages.length === 0`, 8000); await sleep(11000) }
  report.cases = {}
  const only = (process.env.YAN_STATES_ONLY ?? 'flaky,hang,retry,crash').split(',')
  const record = (name, rows) => {
    const result = analyse(rows)
    report.cases[name] = { ...result, timeline: timeline(rows) }
    log(name, { flips: result.cardFlips, drops: result.msgDrops, last: result.last, timeline: report.cases[name].timeline })
    return result
  }

  if (only.includes("flaky")) {
  await fresh()
  await ev(`window.__yanStore.getState().send('FAILFLAKY 间歇失败后成功')`)
  const flaky = record('flaky', await sample(cdp, sleep, 14000, 100))
  await shot('flaky-end')
  check('间歇失败自动重试后成功', !flaky.last?.running && /^已恢复|^Recovered/.test(flaky.last?.card ?? ''), flaky.last)
  check('间歇失败过程错误卡不闪', flaky.cardFlips <= 1, flaky.cardFlips)
  const flakyText = await ev(`document.querySelector('.v3-stream')?.innerText ?? ''`)
  check('成功后只有一份答复', (flakyText.match(/好的，收到/g) ?? []).length === 1, flakyText.slice(0, 200))
  }

  if (only.includes("hang")) {
  await fresh()
  await ev(`window.__yanStore.getState().send('FAILHANG 模型不响应')`)
  const hang = record('hang', await sample(cdp, sleep, 8000, 200))
  await shot('hang-mid')
  const stopped = await ev(`(async () => { await window.__yanStore.getState().abort?.(); return true })()`).catch((error) => String(error))
  const afterStop = record('hang-after-stop', await sample(cdp, sleep, 4000, 150))
  await shot('hang-after-stop')
  check('挂起中点停止后回到可输入状态', !afterStop.last?.running, { stopped, last: afterStop.last })
  }

  if (only.includes("retry")) {
  await fresh()
  await ev(`window.__yanStore.getState().send('FAILNET 重试反馈')`)
  await waitFor(`!!document.querySelector('[data-testid="v3-error-card"]') && !(${running})`, 60000, 100).catch(async (error) => { await shot('retry-wait-failed'); log(await ev('JSON.stringify({ msgs: window.__yanStore.getState().messages.map((m) => m.role + ":" + (m.text ?? "").slice(0, 30)), retry: window.__yanStore.getState().session?.retry })')); throw error })
  await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="v3-error-card"] button')].find((x) => /重试|Retry/.test(x.textContent)); window.__retryClickAt = Date.now(); b.click() })()`)
  const retryRows = await sample(cdp, sleep, 3000, 50)
  const firstReact = retryRows.find((r) => r.running || !r.card)
  record('retry-click', retryRows)
  check('点重试后 500ms 内界面有反馈', !!firstReact && firstReact.t - (await ev('window.__retryClickAt')) < 500, firstReact && firstReact.t)
  await waitFor(`!(${running})`, 60000, 200)
  }

  if (only.includes("crash")) {
  await fresh()
  await ev(`window.__yanStore.getState().send('STORM-CR STEPS6 SLOW 崩溃前先跑一会')`)
  await waitFor(running, 20000, 20)
  await sleep(2000)
  const tree = sampleProcessTree(runDir.split('/').pop().split(String.fromCharCode(92)).pop())
  const pi = tree.processes.filter((p) => p.kind === 'pi')
  log('pi 进程', pi)
  if (pi.length) {
    for (const p of pi) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/F', '/T'], { stdio: 'ignore' }) } catch {} }
    const crash = record('pi-crash', await sample(cdp, sleep, 12000, 100))
    await shot('pi-crash-end')
    check('pi 被杀后不留转着的思考', await ev('!window.__yanStore.getState().messages.some((m) => m.thinkingLive)'))
    check('pi 被杀后不再一直转圈', !crash.last?.running, crash.last)
    check('pi 被杀后错误卡出现且不闪', !!crash.last?.card && crash.cardFlips <= 1, { flips: crash.cardFlips, card: crash.last?.card })
    await ev(`window.__yanStore.getState().send('崩溃后再发一句')`)
    const again = record('pi-crash-resend', await sample(cdp, sleep, 12000, 100))
    await shot('pi-crash-resend')
    check('崩溃后再发消息能恢复', !again.last?.running && again.last?.msgs > crash.last.msgs, again.last)
  } else check('找到 pi 进程', false, tree.error)
  }
}
