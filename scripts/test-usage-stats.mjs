/** 启动页用量概览：按行计数（main/usage-stats.ts countLine）与范围聚合（shared/usage-stats.ts）。不启动 Electron。 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runUsageStatsTests(ok) {
  await build({ entryPoints: ['src/shared/usage-stats.ts'], outfile: 'out/test/usage-stats-shared.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  await build({ entryPoints: ['src/main/usage-stats.ts'], outfile: 'out/test/usage-stats-main.mjs', bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
  const s = await import(pathToFileURL('out/test/usage-stats-shared.mjs').href)
  const m = await import(pathToFileURL('out/test/usage-stats-main.mjs').href)

  const now = new Date(2026, 9, 10, 15, 0, 0).getTime()
  const at = (daysAgo, hour) => new Date(2026, 9, 10 - daysAgo, hour, 5, 0).toISOString()
  const user = (ts) => Buffer.from(JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: ts, message: { role: 'user', content: '"provider":"x","model":"fake" "usage":{"totalTokens":999999}' } }))
  const reply = (ts, total) => Buffer.from(JSON.stringify({ type: 'message', id: 'b', parentId: 'a', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }], api: 'x', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { total: 0 } }, stopReason: 'stop' } }))
  const a = {}
  m.countLine(user(at(0, 10)), a)
  m.countLine(reply(at(0, 10), 1200), a)
  m.countLine(reply(at(10, 22), 800), a)
  m.countLine(Buffer.from(JSON.stringify({ type: 'model_change', timestamp: at(0, 9), provider: 'p', modelId: 'q' })), a)
  m.countLine(Buffer.from(JSON.stringify({ type: 'message', timestamp: at(0, 9), message: { role: 'toolResult', content: 'x' } })), a)
  const today = s.localDay(now)
  ok(a[today]?.m === 2 && a[today]?.t === 1200, '按行计数：用户与助手消息计数，token 取助手的 totalTokens')
  ok(a[today]?.models['commandcode/deepseek/deepseek-v4.1-flash'] === 1200, '模型取用量前的 provider/model，正文里的转义字段不算')
  ok(a[today]?.h['10'] === 2, '按本地小时计数')
  const noTotal = {}
  m.countLine(Buffer.from(JSON.stringify({ type: 'message', timestamp: at(0, 9), message: { role: 'assistant', provider: 'p', model: 'q', usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 0 } } })), noTotal)
  ok(noTotal[today]?.t === 12, '没有 totalTokens 时按各项相加')

  const b = {}
  m.countLine(user(at(2, 14)), b)
  m.countLine(reply(at(40, 14), 500), b)
  const all = s.aggregateUsage([a, b], 'all', now)
  ok(all.sessions === 2 && all.messages === 5 && all.tokens === 2500, '全部：会话、消息、token 合计')
  ok(all.activeDays === 4 && all.peakHour === 10, '全部：活跃天数与高峰时段')
  const week = s.aggregateUsage([a, b], '7d', now)
  ok(week.sessions === 2 && week.tokens === 1200 && week.activeDays === 2, '7 天：只算范围内的天')
  const month = s.aggregateUsage([a, b], '30d', now)
  ok(month.tokens === 2000 && month.models[0].key === 'commandcode/deepseek/deepseek-v4.1-flash', '30 天：范围与模型排序')
  ok(all.heat.length >= (s.HEAT_WEEKS - 1) * 7 + 1 && all.heat.at(-1).date === today && new Date(all.heat[0].date + 'T00:00:00').getDay() === 1, '热力图从周一开始到今天')
  ok(s.aggregateUsage([], 'all', now).peakHour === null, '没有数据时高峰时段为空')
  const lv = s.heatLevels([0, 1, 2, 3, 4, 100])
  ok(lv[0] === 0 && lv[5] === 4 && lv[1] >= 1, '热力图分级：零为 0，最大为 4')
}
