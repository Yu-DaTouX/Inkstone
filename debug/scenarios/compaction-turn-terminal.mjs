import { readFileSync } from 'node:fs'

export const meta = { description: '回合内原生压缩（pi 在下一次模型请求前压缩）：运行中读取会话历史时，进行中的回合不应被标成已中断，回合结束后页脚也不应出现已中断；假模型，不调用真实模型' }

export default async function run({ cdp, box, check, report, state, until, waitFor, newSession, turn, sleep, shot, autoApprove }) {
  const ev = (expr) => cdp.evaluate(expr)
  process.env.YAN_FAKE_REQUEST_DELAY_MS ??= '400'
  process.env.YAN_FAKE_SUMMARY_DELAY_MS ??= '3000'
  await autoApprove()
  await newSession(box.project)
  await waitFor('!!s.session?.sessionFile')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light', lang: 'zh-CN' })`)
  await ev(`(() => { window.__seen = []; window.__seenTimer = setInterval(() => { const st = window.__yanStore.getState(); const hit = [...document.querySelectorAll('.v3-msg[data-turn-id]')].filter((row) => /已中断/.test(row.innerText || '')).map((row) => row.dataset.turnId); window.__seen.push({ compacting: !!st.session?.isCompacting, hit }) }, 100) })()`)
  const peeks = []
  const peek = () => ev(`(async () => { const file = window.__yanStore.getState().session?.sessionFile; const r = await window.yan.peekSession(file); return r.messages.filter((m) => m.turnTiming).map((m) => ({ id: m.id, terminal: m.turnTiming.terminalReason })) })()`)
  await turn('第一轮：先打个招呼。', { timeout: 60000 })
  const padding = '填充上下文，无关内容。'.repeat(16000)
  await turn(`USAGEIN=${process.env.COMPACT_USAGE ?? 380000} MANYTOOLS ${padding}`, {
    timeout: 240000,
    during: async () => {
      for (let i = 0; i < 6; i += 1) {
        await sleep(1500)
        peeks.push(await peek())
      }
    }
  })
  const seen = await ev(`(() => { clearInterval(window.__seenTimer); return window.__seen })()`)
  await sleep(1500)
  const footer = await ev(`[...document.querySelectorAll('.v3-msg[data-turn-id]')].map((row) => ({ id: row.dataset.turnId, text: (row.innerText || '').split('\\n').filter((line) => /已中断|已停止|次操作/.test(line)).join(' | ') })).filter((item) => item.text)`)
  const file = await state('s.session?.sessionFile ?? null')
  const compactions = readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('"type":"compaction"')).length
  const firstCompaction = readFileSync(file, 'utf8').split('\n').filter(Boolean).findIndex((line) => line.includes('"type":"compaction"'))
  const lastLine = readFileSync(file, 'utf8').split('\n').filter(Boolean).length - 1
  report.compactions = { compactions, firstCompaction, lastLine }
  report.peeks = peeks
  report.footer = footer
  report.compactingSamples = seen.filter((item) => item.compacting).length
  console.log(JSON.stringify({ peeks, footer, compactingSamples: report.compactingSamples }))
  await shot('compaction-turn-footer')
  const interruptedPeeks = peeks.flat().filter((item) => item.terminal === 'interrupted')
  check('回合内确实发生了压缩（压缩条目出现在回合中途，而不是回合末尾）', compactions >= 1 && firstCompaction >= 0 && firstCompaction < lastLine - 20, report.compactions)
  check('运行中读取会话历史时，进行中的回合不带已中断', interruptedPeeks.length === 0, interruptedPeeks)
  check('回合进行中页脚从未出现已中断', !seen.some((item) => item.hit.length), seen.filter((item) => item.hit.length).slice(0, 3))
  check('回合结束后页脚没有已中断', !footer.some((item) => /已中断/.test(item.text)), footer)
}
