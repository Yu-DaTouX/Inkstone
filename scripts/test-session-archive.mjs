/**
 * 自动归档的选择规则（src/shared/session-archive.ts）。纯函数，不起界面。
 *
 * 单独运行：node scripts/test-session-archive.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runSessionArchiveTests(ok) {
  await build({ entryPoints: ['src/shared/session-archive.ts'], outfile: 'out/test/session-archive.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
  const { selectAutoArchive, normalizeAutoArchiveDays } = await import(pathToFileURL('out/test/session-archive.mjs').href)
  const DAY = 86_400_000
  const now = 100 * DAY
  const mk = (id, ageDays, extra = {}) => ({ id, path: `C:/s/${id}.jsonl`, updatedAt: now - ageDays * DAY, ...extra })

  ok(normalizeAutoArchiveDays(7) === 7 && normalizeAutoArchiveDays(7.9) === 7, '天数：小数向下取整')
  ok(normalizeAutoArchiveDays(0) === 0 && normalizeAutoArchiveDays(-3) === 0 && normalizeAutoArchiveDays('7') === 0 && normalizeAutoArchiveDays(NaN) === 0, '天数：0、负数、非数字都当「从不」')
  ok(normalizeAutoArchiveDays(9999) === 365, '天数：封顶 365')

  const items = [mk('old', 10), mk('fresh', 1), mk('edge', 7), mk('pinned', 30, { pinned: true }), mk('done', 30, { archivedAt: 5 }), mk('busy', 30), mk('active', 30, { lastActivityAt: now - DAY })]
  const pick = (days, busy = []) => selectAutoArchive(items, { days, now, busyFiles: busy }).sort().join()
  ok(pick(0) === '', '关闭时什么都不选')
  ok(pick(7, ['C:/s/busy.jsonl']) === 'old', '7 天：只选闲置超过 7 天、没置顶、没归档、没运行实例的；正好 7 天不算')
  ok(pick(7) === 'busy,old', '没有运行实例时 busy 也在候选里')
  ok(pick(7, ['c:\\s\\BUSY.jsonl']) === 'old', '运行实例的路径按归一化比较（盘符与斜杠大小写不影响）')
  ok(pick(7, [undefined]) === 'busy,old', '运行实例没有会话文件时不报错')
  ok(pick(60) === '', '60 天：都不够久')
  ok(selectAutoArchive(items, { days: 7, now, busyFiles: [] }).includes('active') === false, '最近有活动（lastActivityAt）的不选，哪怕 updatedAt 很旧')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  await runSessionArchiveTests((cond, msg) => { if (!cond) { failed++; console.error('FAIL', msg) } else console.log('ok  ', msg) })
  process.exit(failed ? 1 : 0)
}
