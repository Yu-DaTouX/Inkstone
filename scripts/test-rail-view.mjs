/**
 * 左栏视图（src/shared/rail-view.ts）的分区与排序。纯函数，不起界面。
 *
 * 单独运行：node scripts/test-rail-view.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runRailViewTests(ok) {
  await build({ entryPoints: ['src/shared/rail-view.ts'], outfile: 'out/test/rail-view.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
  const { normalizeRailView, buildRailSections, compareBy, dateSectionOf, DEFAULT_RAIL_VIEW } = await import(pathToFileURL('out/test/rail-view.mjs').href)

  // 固定「现在」为本地 2026-10-08 10:00，日期分区不依赖测试运行的时刻。
  const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime()
  const now = at(8, 10)
  const mk = (path, title, activity, created = activity) => ({ path, title, createdAt: created, updatedAt: activity, lastActivityAt: activity })

  ok(JSON.stringify(normalizeRailView(null)) === JSON.stringify(DEFAULT_RAIL_VIEW), '视图：空值回默认')
  ok(normalizeRailView({ group: 'state', sort: 'name', show: 'active' }).group === 'state', '视图：合法值保留')
  ok(normalizeRailView({ group: 'bogus', sort: 7 }).group === 'project' && normalizeRailView({ group: 'bogus', sort: 7 }).sort === 'recent', '视图：非法值逐项回默认')
  ok(normalizeRailView({ group: 'date' }).sort === 'recent', '视图：缺项只补缺的那项')
  ok(normalizeRailView({ show: 'archived' }).show === 'archived' && normalizeRailView({ show: 'x' }).show === 'active' && DEFAULT_RAIL_VIEW.show === 'active', '视图：显示范围只认 archived，其余回「进行中」')

  ok(dateSectionOf(at(8, 0), now) === 'today', '日期：当天零点算今天')
  ok(dateSectionOf(at(7, 23), now) === 'yesterday', '日期：昨天 23 点算昨天')
  ok(dateSectionOf(at(2, 12), now) === 'week', '日期：6 天内算本周')
  ok(dateSectionOf(at(1, 12), now) === 'older', '日期：更早')
  ok(dateSectionOf(at(8, 23), now) === 'today', '日期：未来时间（时钟漂移）归今天')

  const items = [mk('a', 'Beta', at(8, 9)), mk('b', 'alpha', at(7, 9), at(1)), mk('c', '十', at(1, 9), at(8, 8)), mk('d', 'Alpha 2', at(8, 8))]

  ok(buildRailSections(items, { group: 'project', sort: 'recent', show: 'active' }, () => 'idle', now).length === 0, '分区：按项目不在这里处理')

  const flat = buildRailSections(items, { group: 'none', sort: 'recent', show: 'active' }, () => 'idle', now)
  ok(flat.length === 1 && flat[0].key === 'all' && flat[0].items.map((x) => x.path).join('') === 'adbc', '分区：不分组按最近活动')
  ok(buildRailSections([], { group: 'none', sort: 'recent', show: 'active' }, () => 'idle', now).length === 0, '分区：没有会话不产生空分区')

  const byName = [...items].sort(compareBy('name')).map((x) => x.path).join('')
  ok(byName.indexOf('b') < byName.indexOf('d') && byName.indexOf('d') < byName.indexOf('a'), '排序：名称不区分大小写，alpha < Alpha 2 < Beta')
  const byCreated = [...items].sort(compareBy('created')).map((x) => x.path).join('')
  ok(byCreated === 'adcb', '排序：创建时间新的在前，同时刻回落到最近活动')

  const stateOf = (s) => ({ a: 'running', b: 'waiting', c: 'idle', d: 'failed' })[s.path]
  const byState = buildRailSections(items, { group: 'state', sort: 'recent', show: 'active' }, stateOf, now)
  ok(byState.map((s) => s.key).join() === 'waiting,failed,running,idle', '状态：等你回答 > 出错 > 运行中 > 其余')
  ok(buildRailSections(items, { group: 'state', sort: 'recent', show: 'active' }, () => 'idle', now).map((s) => s.key).join() === 'idle', '状态：全部空闲只剩一个分区')

  const byDate = buildRailSections(items, { group: 'date', sort: 'recent', show: 'active' }, () => 'idle', now)
  ok(byDate.map((s) => s.key).join() === 'today,yesterday,older', '日期：空分区不出现，顺序今天→昨天→更早')
  ok(byDate[0].items.map((x) => x.path).join('') === 'ad', '日期：分区内沿用所选排序')

  const dup = [mk('x', 'same', at(8, 9)), mk('y', 'same', at(8, 8))]
  ok([...dup].sort(compareBy('name')).map((s) => s.path).join('') === 'xy', '排序：同名回落到最近活动')
  ok(items.length === 4 && items[0].path === 'a', '纯函数：不改入参顺序')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  await runRailViewTests((cond, msg) => { if (!cond) { failed++; console.error('FAIL', msg) } else console.log('ok  ', msg) })
  process.exit(failed ? 1 : 0)
}
