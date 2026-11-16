import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '工作流 model()：假模型直接调用逐段处理 6 段（1 段鉴权失败），readText → model() → writeText；看运行卡上的 model() 完成/失败计数，截深浅色与窄屏' }

const SCRIPT = `export const meta = {
  name: '假模型直接调用演示',
  description: '6 段逐段直接调用模型，写到 out/',
  phases: ['翻译']
}

phase('翻译')
const files = await listFiles('segments', '*.txt')
const done = await pipeline(files, async (file) => {
  const text = await readText(file)
  const answer = await model(text, { system: '只输出译文', label: file, model: 'fake/fake-model', retries: 0 })
  await writeText('out/' + file.slice('segments/'.length), answer)
  return file
})
return { total: files.length, ok: done.filter(Boolean).length, failed: files.filter((f, i) => !done[i]) }
`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, autoApprove, newSession, turn, log }) {
  const ev = (expression) => cdp.evaluate(expression)
  const runs = () => ev(`window.yan.workflows.list()`)
  const until = async (label, test, timeout = 120000, step = 300) => {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
      last = await test()
      if (last) return last
      await sleep(step)
    }
    throw new Error(`等待超时：${label}`)
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor('s.conn === "ready"')
  await ev(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN', theme: 'dark' })`)
  await autoApprove()
  await newSession(box.project)
  mkdirSync(join(box.project, 'segments'), { recursive: true })
  for (let i = 0; i < 6; i++) writeFileSync(join(box.project, 'segments', `${i}.txt`), i === 4 ? `FAILAUTH 第 ${i} 段` : `第 ${i} 段`, 'utf8')
  writeFileSync(join(box.project, 'wf-demo.js'), SCRIPT)

  await turn('WFDEMO 用工作流跑一遍直接调用演示')
  const first = await until('工作流出现', async () => (await runs()).find((item) => item.name === '假模型直接调用演示'), 30000)
  const id = first.id
  report.workflowId = id
  const finished = await until('运行结束', async () => {
    const view = (await runs()).find((item) => item.id === id)
    return view.status === 'done' || view.status === 'failed' ? view : null
  }, 180000, 300)
  log('models', JSON.stringify(finished.models))
  report.models = finished.models
  check('运行完成，没有派子代理', finished.status === 'done' && finished.agents.length === 0, { status: finished.status, error: finished.error })
  check('model() 计数：6 个里完成 5、失败 1', finished.models?.total === 6 && finished.models.done === 5 && finished.models.failed === 1, finished.models)
  check('结果经 writeText 写进项目 out/', existsSync(join(box.project, 'out', '0.txt')) && !existsSync(join(box.project, 'out', '4.txt')), readFileSync(join(box.project, 'out', '0.txt'), 'utf8').slice(0, 80))
  await until('运行卡出现', () => ev(`!!document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')`), 20000)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(600)
  const title = await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-head"]')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
  report.title = title
  check('运行卡标题显示 model() 完成与失败计数，不显示 0/0 个子 Agent', /model\(\) 5\/6/.test(title) && /model\(\) 失败 1/.test(title) && !/0\/0 个子 Agent/.test(title), title)
  const phases = await ev(`[...document.querySelectorAll('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-phase"]')].map((el) => ({ text: el.innerText.replace(/\\s+/g, ' ').trim(), state: el.dataset.state }))`)
  report.phases = phases
  check('阶段条计入 model()：翻译 5/6 · 失败 1、部分失败', phases.length === 1 && phases[0].text === '翻译 5/6 · 失败 1' && phases[0].state === 'partial', phases)
  const cells = finished.models?.cells ?? ''
  const cellAt = (i) => ev(`(() => { const cv = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-model-canvas"]'); if (!cv) return null; const cols = Number(cv.dataset.cols); const step = Number(cv.dataset.step); const r = cv.getBoundingClientRect(); return { x: Math.round(r.left + (${i} % cols) * step + 2), y: Math.round(r.top + Math.floor(${i} / cols) * step + 2) } })()`)
  const probeText = () => ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-model-probe"]')?.innerText ?? ''`)
  const doneAt = [...cells].findIndex((c, i) => c === 'd' && i !== finished.models?.latest?.index)
  const failAt = cells.indexOf('f')
  check('运行卡有 model() 点阵格，每次调用一格', cells.length === 6 && doneAt >= 0 && failAt >= 0 && !!(await cellAt(0)), cells)
  const donePos = await cellAt(doneAt)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: donePos.x, y: donePos.y })
  await sleep(500)
  const doneProbe = await probeText()
  report.gridHover = doneProbe
  check('悬停完成格经按序号接口取到 label 与用时', /segments\/\d\.txt/.test(doneProbe) && /用时/.test(doneProbe), doneProbe)
  const failPos = await cellAt(failAt)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: failPos.x, y: failPos.y })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: failPos.x, y: failPos.y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: failPos.x, y: failPos.y, button: 'left', clickCount: 1 })
  await sleep(500)
  const errorText = await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"] [data-testid="v3-workflow-model-error"]')?.innerText ?? ''`)
  report.gridError = errorText
  check('点失败格看到错误原文', /segments\/4\.txt/.test(errorText) && /401/.test(errorText), errorText.slice(0, 200))
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(300)
  await shot('workflow-model-done-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(600)
  await shot('workflow-model-done-light')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(800)
  await ev(`document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')?.scrollIntoView({ block: 'start' })`)
  await sleep(400)
  const overflow = await ev(`(() => { const card = document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]'); if (!card) return null; const box = card.getBoundingClientRect(); const wide = [...card.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 1).length; return { width: Math.round(box.width), wide } })()`)
  check('窄屏下运行卡不横向溢出', overflow && overflow.wide === 0, overflow)
  await shot('workflow-model-done-narrow-light')
}
