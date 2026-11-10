import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = {
  description: '自动压缩：可控 usage 触发砚的压缩线（auto-compact 调 native compact），核对 context-compact 摘要、历史快照与显式 compact'
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export default async function run({ cdp, fake, box, check, report, log, state, until, waitFor, newSession, turn, sleep, shot }) {
  const settingsPath = join(box.piDir, 'settings.json')
  const linesPath = join(box.dataDir, 'compaction-lines.json')
  const reserve = () => readJson(settingsPath)?.compaction?.modelOverrides?.['fake/fake-model']?.reserveTokens
  const summaryRequests = (list) =>
    list.filter((item) => {
      const text = item.text ?? ''
      return text.startsWith('Stop here. Do not call any tool') || text.startsWith('<conversation>')
    })
  const sessionLines = async () => {
    const file = await state('s.session?.sessionFile ?? null')
    if (!file || !existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
  }
  const compactionEntries = async () => (await sessionLines()).filter((entry) => entry?.type === 'compaction')
  const historyText = async () => {
    const file = await state('s.session?.sessionFile ?? null')
    const path = `${file}.history.txt`
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  report.data = {}
  await newSession(box.project)
  await waitFor('!!s.session?.sessionFile')
  check('会话已建立并拿到会话文件', !!(await state('s.session?.sessionFile')))

  const defaultReserve = await until(() => reserve() === 40_000, 20000)
  report.data.defaultReserve = reserve()
  report.data.compactionLines = readJson(linesPath)
  check('砚按默认 400k 上限写入 pi 的压缩线（400k − min(400k, 0.9×400k) = 40k reserve）', defaultReserve, reserve())

  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ autoCompactTokens: 100000 })`)
  const patched = await until(() => reserve() === 300_000, 20000)
  report.data.patchedReserve = reserve()
  check('把自动压缩上限改成 100k 后压缩线随之变成 300k reserve（阈值 100k）', patched, reserve())
  check('pi 原生自动压缩是开着的', (await state('s.session?.autoCompactionEnabled')) === true)

  await turn('第一轮：先打个招呼。', { timeout: 60000 })
  check('小幅上下文第一轮不触发压缩', (await state('s.session?.lastCompaction ?? null')) === null)

  const padding = '填充上下文，无关内容。'.repeat(16000)
  const beforeSecond = fake.requests.length
  await turn(`USAGEIN=120000 ${padding}\n收到后只回一句话。`, { timeout: 240000 })
  const secondRequests = fake.requests.slice(beforeSecond)
  report.data.secondTurn = {
    requests: secondRequests.map((item) => ({ text: item.text, usage: item.usage })),
    stats: await state('s.stats?.contextUsage ?? null')
  }
  check('假模型按标记回报 input tokens=120000', secondRequests[0]?.usage?.input === 120000, secondRequests[0]?.usage)

  const compacted = await until('!!s.session?.lastCompaction && !s.session?.isCompacting', 90000)
  const last = await state('s.session?.lastCompaction ?? null')
  const entries = await compactionEntries()
  const history = await historyText()
  const summaries = summaryRequests(secondRequests)
  const summary = summaries[0]
  report.data.autoCompaction = {
    compacted,
    lastCompaction: last,
    entries: entries.length,
    history: history === null ? null : history.slice(0, 400),
    summaryRequests: summaries.map((item) => ({ text: item.text, instructions: (item.instructions ?? '').slice(0, 200) }))
  }
  check('达到砚的自动压缩上限后自动执行了原生 compact', compacted && last?.status === 'completed', last)
  check('压缩前的真实 token 估算高于保留窗口（说明确实有可压缩的原文）', (last?.beforeTokens ?? 0) > 20_000, last?.beforeTokens)
  check('压缩后 token 数明显变小', typeof last?.afterTokens === 'number' && last.afterTokens < (last?.beforeTokens ?? 0), [last?.beforeTokens, last?.afterTokens])
  check('压缩时发出了砚的摘要请求（context-compact，而不是 pi 默认摘要）', summaries.length >= 1, report.data.autoCompaction.summaryRequests)
  check('摘要请求是砚的快速路径提示词（仅 context-compact 有这句）', (summary?.text ?? '').startsWith('Stop here. Do not call any tool'), summary?.text)
  check('会话文件里有原生 compaction 条目', entries.length >= 1, entries.length)
  check('压缩摘要引用被压缩原文的快照文件', /\.history\.txt/.test(String(entries[0]?.summary ?? '')), String(entries[0]?.summary ?? '').slice(0, 160))
  check('被压缩原文写进了 <会话>.history.txt', history !== null && history.includes('=== compaction 1 '), history === null ? 'missing' : history.slice(0, 80))
  check('摘要里带砚追加的用户原文块与快照指针', /<user-messages>/.test(String(entries[0]?.summary ?? '')) && /<history-snapshot>/.test(String(entries[0]?.summary ?? '')), String(entries[0]?.summary ?? '').slice(0, 80))
  await shot('auto-compacted')

  await turn('压缩后再回一句。', { timeout: 120000 })
  await sleep(600)
  const replyAfter = await state('s.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? ""')
  check('压缩后会话还能继续对话', /好的，收到/.test(replyAfter), replyAfter.slice(0, 80))

  const extra = `继续补充细节。${'补充说明。'.repeat(12000)}`
  await turn(extra, { timeout: 120000 })
  await turn(`再补一段。${'补充说明。'.repeat(12000)}`, { timeout: 120000 })
  await sleep(800)

  const explicit = await cdp.evaluate('window.yan.compact()')
  const secondDone = await until('(s.session?.lastCompaction?.startedAt ?? 0) > 0 && !s.session?.isCompacting', 60000)
  await sleep(800)
  const afterExplicit = await state('s.session?.lastCompaction ?? null')
  const entriesAfter = await compactionEntries()
  const historyAfter = await historyText()
  report.data.explicitCompact = { explicit, secondDone, lastCompaction: afterExplicit, entries: entriesAfter.length }
  check('显式 native compact 调用成功', explicit?.ok === true, explicit)
  check('显式压缩完成并记为 manual', afterExplicit?.status === 'completed' && afterExplicit?.reason === 'manual', afterExplicit)
  check('第二次压缩又追加了一段原文快照', (historyAfter ?? '').includes('=== compaction 2 '), (historyAfter ?? '').slice(0, 80))
  check('会话文件里出现两条 compaction 条目', entriesAfter.length >= 2, entriesAfter.length)
}
