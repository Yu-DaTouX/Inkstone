/**
 * 工作模式（实施-05 S2）的纯逻辑与存储测试。
 *
 * 分两层：
 *   · `src/shared/work-mode.ts`   契约与纯函数（迁移 / 循环 / 清洗）；
 *   · `src/main/work-mode-service.ts`  —— 真文件、真 CAS、真迁移。
 *
 * 为什么存储层要单独测：它的失败模式都在磁盘边上（CAS 被并发写绕过、
 * pending 迁移把别人的值覆盖掉、脏 JSON 让整份文档作废）。只看返回值验不出来。
 *
 * 用法：npm run test:unit
 */
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runWorkModeTests(ok) {
  const shared = await import('../out/test/work-mode.mjs')
  const service = await import('../out/test/work-mode-service.mjs')

  /* ------------------------------------------------------------ 纯逻辑 */

  ok(shared.WORK_MODES.join(',') === 'standard,clarify,autonomous', '模式顺序固定：标准 → 澄清 → 自主')
  ok(shared.isWorkMode('clarify') && !shared.isWorkMode('bogus') && !shared.isWorkMode(1), 'isWorkMode 只认三档字符串')
  ok(shared.normalizeWorkMode('autonomous') === 'autonomous', 'normalizeWorkMode 保留合法值')
  ok(shared.normalizeWorkMode('bogus') === 'standard', 'normalizeWorkMode 脏值回落标准')
  ok(shared.nextWorkMode('standard') === 'clarify', '循环：标准 → 澄清')
  ok(shared.nextWorkMode('clarify') === 'autonomous', '循环：澄清 → 自主')
  ok(shared.nextWorkMode('autonomous') === 'standard', '循环：自主 → 标准')
  ok(shared.nextWorkMode('bogus') === 'clarify', '循环对脏值先归一（脏值按标准处理）')

  ok(shared.migrateLegacyAutonomous('clarify', true) === 'clarify', '迁移：新字段合法就听新的')
  ok(shared.migrateLegacyAutonomous(undefined, true) === 'autonomous', '迁移：旧 autonomous=true → 自主')
  ok(shared.migrateLegacyAutonomous(undefined, false) === 'standard', '迁移：旧 false → 标准')
  ok(shared.migrateLegacyAutonomous('bogus', true) === 'autonomous', '迁移：新字段脏值仍可用旧布尔')
  ok(shared.migrateLegacyAutonomous(undefined, 'yes') === 'standard', '迁移：旧字段只认字面 true')
  const once = shared.migrateLegacyAutonomous(undefined, true)
  const twice = shared.migrateLegacyAutonomous(once, true)
  ok(once === twice && twice === 'autonomous', '迁移幂等（第二次读同一份输入结果不变）')

  ok(shared.isWorkModeTabShortcut(undefined) === true, 'Tab 快切：没改过 = 开')
  ok(shared.isWorkModeTabShortcut(true) === true, 'Tab 快切：显式 true = 开')
  ok(shared.isWorkModeTabShortcut(false) === false, 'Tab 快切：只有明确 false 才关')

  /* ------------------------------------------------------------ 存储层 */

  const dir = await mkdtemp(join(tmpdir(), 'yan-work-mode-'))
  const file = join(dir, 'work-modes.json')
  const exists = async (p) => stat(p).then(() => true, () => false)
  let clock = 1000
  const make = () => new service.WorkModeStore({ root: dir, now: () => (clock += 10) })

  ok(service.sanitizeWorkModeKey('r1') === 'r1', '键清洗：普通 id 原样保留')
  ok(service.sanitizeWorkModeKey('pending:r1') === 'pending:r1', '键清洗：pending 前缀（含冒号）合法')
  ok(
    service.sanitizeWorkModeKey('C:/Users/x/sessions/a.jsonl') === 'C:/Users/x/sessions/a.jsonl',
    '键清洗：会话文件路径合法（稳定键就是它）'
  )
  ok(service.sanitizeWorkModeKey('a\u0000b') === null, '键清洗：控制字符被拒')
  ok(service.sanitizeWorkModeKey('   ') === null, '键清洗：空白被拒')
  ok(service.sanitizeWorkModeKey('x'.repeat(401)) === null, '键清洗：超长被拒')
  ok(service.pendingWorkModeKey('r3') === 'pending:r3', 'pending 键格式固定')
  ok(
    service.normalizeSessionFileKey('C:\\Users\\x\\a.jsonl') === 'C:/Users/x/a.jsonl',
    '会话文件路径归一化：反斜杠 → 斜杠'
  )
  ok(service.normalizeSessionFileKey('/home/x/a.jsonl/') === '/home/x/a.jsonl', '会话文件路径归一化：去尾斜杠')
  ok(service.normalizeSessionFileKey('') === null && service.normalizeSessionFileKey(undefined) === null, '空路径不进键')
  ok(
    service.workModeSnapshotFileName('r1') === 'r1.json' &&
      service.workModeSnapshotFileName('a/b') === 'a_b.json',
    '快照文件名把非法字符换成下划线'
  )

  const store = make()
  await store.load()
  const fresh = store.state('s1')
  ok(fresh.mode === 'standard' && fresh.revision === 0, '没存过的会话：默认标准、revision 0')
  ok(!(await exists(file)), '只是读过的会话不写盘（新会话不留记录）')

  const set1 = await store.set('s1', 'clarify')
  ok(set1.ok && set1.state.mode === 'clarify' && set1.state.revision === 1, '提交：写入并 revision=1')
  const raw1 = JSON.parse(await readFile(file, 'utf8'))
  ok(raw1.entries.s1.mode === 'clarify' && raw1.entries.s1.revision === 1, '提交落盘内容正确')

  const set2 = await store.set('s1', 'autonomous')
  ok(set2.ok && set2.state.revision === 2, '第二次提交 revision 递增')

  const stale = await store.set('s1', 'standard', 1)
  ok(!stale.ok && stale.error === 'version-mismatch', '过期版本提交被拒')
  ok(stale.state.mode === 'autonomous' && stale.state.revision === 2, '被拒时回传当前权威值')
  const raw2 = JSON.parse(await readFile(file, 'utf8'))
  ok(raw2.entries.s1.mode === 'autonomous' && raw2.entries.s1.revision === 2, '被拒的提交没有写盘')

  const okCas = await store.set('s1', 'standard', 2)
  ok(okCas.ok && okCas.state.mode === 'standard' && okCas.state.revision === 3, '版本一致时提交成功')

  /* ---- pending → 稳定会话 ---- */
  await store.set('pending:r9', 'clarify')
  const adopted = await store.adopt('pending:r9', 'uuid-9')
  ok(adopted.mode === 'clarify' && adopted.revision === 1, '迁移把模式带到稳定 id，且不算一次用户提交')
  ok(store.snapshot().entries['pending:r9'] === undefined, '迁移后源键被清掉')
  ok(store.state('uuid-9').mode === 'clarify', '迁移后稳定 id 读得到')

  await store.set('pending:r10', 'autonomous')
  await store.set('uuid-10', 'standard')
  const kept = await store.adopt('pending:r10', 'uuid-10')
  ok(kept.mode === 'standard', '目标已有条目时保留目标（稳定会话的值更权威）')
  ok(store.snapshot().entries['pending:r10'] === undefined, '迁移时源键仍会被清掉')

  /* ---- 重新读盘 ---- */
  const reloaded = make()
  await reloaded.load()
  ok(reloaded.state('s1').mode === 'standard' && reloaded.state('s1').revision === 3, '新实例读盘拿到已存的模式')

  /* ---- 脏文档 ---- */
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      entries: {
        good: { mode: 'clarify', revision: 2, updatedAt: 1 },
        badMode: { mode: 'bogus', revision: 1, updatedAt: 1 },
        badRevision: { mode: 'standard', revision: 'x', updatedAt: 1 },
        badKey: {},
        'a\u0000b': { mode: 'standard', revision: 1, updatedAt: 1 }
      }
    }),
    'utf8'
  )
  const dirty = make()
  await dirty.load()
  const entries = dirty.snapshot().entries
  ok(entries.good?.mode === 'clarify', '脏文档：合法条目保留')
  ok(entries.badMode === undefined, '脏文档：非法 mode 丢弃')
  ok(entries.badRevision?.revision === 1, '脏文档：revision 脏值归 1')
  ok(entries['a\u0000b'] === undefined, '脏文档：非法键丢弃')

  /* ---- 坏 JSON ---- */
  await writeFile(file, '{ not json', 'utf8')
  const broken = make()
  await broken.load()
  ok(broken.state('s1').revision === 0, '坏 JSON 当空文档（模式不是关键数据，不能拦住启动）')

  /* ---- 扩展读的那份快照 ---- */
  const snapshotPath = service.workModeSnapshotPath('r1', dir)
  await service.writeWorkModeSnapshot('r1', { mode: 'clarify', revision: 2 }, dir)
  const snap1 = JSON.parse(await readFile(snapshotPath, 'utf8'))
  ok(snap1.mode === 'clarify' && snap1.revision === 2, '快照文件内容含 mode / revision')
  await service.writeWorkModeSnapshot('r1', { mode: 'standard', revision: 3 }, dir)
  const snap2 = JSON.parse(await readFile(snapshotPath, 'utf8'))
  ok(snap2.mode === 'standard' && snap2.revision === 3, '快照文件可被覆盖（切回标准立即生效）')
  ok(service.workModeSnapshotFileName('a/b') === 'a_b.json', '快照文件名清洗后仍在同一目录')

  await rm(dir, { recursive: true, force: true })
}
