/**
 * 检查点（回退代码）的集成测试：真 git、临时目录，不碰真实数据，不联网。
 * 用法： node scripts/test-checkpoints.mjs（用 esbuild 现场编译，不依赖 npm run build）
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const data = await mkdtemp(join(tmpdir(), 'yan-cp-data-'))
const proj = await mkdtemp(join(tmpdir(), 'yan-cp-proj-'))
process.env.YAN_DATA_DIR = data

let failed = 0
const ok = (cond, name, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}
const exists = (p) => access(p).then(() => true, () => false)
const read = (p) => readFile(p, 'utf8')

await build({ entryPoints: ['src/main/checkpoints.ts'], outfile: 'out/test/checkpoints.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const cp = await import(pathToFileURL(resolve('out/test/checkpoints.mjs')).href)
await build({ entryPoints: ['src/shared/checkpoints.ts'], outfile: 'out/test/checkpoints-shared.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
const shared = await import(pathToFileURL(resolve('out/test/checkpoints-shared.mjs')).href)

{
  /* 把界面上的一条用户消息对应到检查点：指纹一致且时间相近才算 */
  const { textFingerprint, matchCheckpoint } = shared
  const rec = (id, at, text, kind = 'turn') => ({ id, sessionKey: 's', at, textHash: textFingerprint(text), preview: text, kind })
  const records = [rec('r1', 1_000_000, '修一下登录'), rec('r2', 2_000_000, '修一下登录'), rec('r3', 3_000_000, '另一句'), rec('u1', 1_000_100, '修一下登录', 'restore')]
  ok(matchCheckpoint(records, '修一下登录', 1_000_500)?.id === 'r1', '匹配：同一句话取时间最近的那个检查点')
  ok(matchCheckpoint(records, '  修一下登录\n', 2_000_300)?.id === 'r2', '匹配：空白差异不影响')
  ok(matchCheckpoint(records, '没发过的话', 1_000_500) === null, '匹配：指纹不一致不猜')
  ok(matchCheckpoint(records, '修一下登录', 1_000_000 + 11 * 60_000 + 5_000_000) === null, '匹配：时间差太大不猜')
  ok(matchCheckpoint(records, '修一下登录', 1_000_100)?.kind === 'turn', '匹配：回退前自动存的快照（restore）不当作回合检查点')
  ok(textFingerprint('a  b') === textFingerprint(' a b '), '指纹：压缩空白后相同')
}

try {
  await writeFile(join(proj, '.gitignore'), 'ignored.log\n')
  await writeFile(join(proj, 'a.txt'), 'A1\n')
  await mkdir(join(proj, 'sub'))
  await writeFile(join(proj, 'sub', 'b.txt'), 'B1\n')
  await writeFile(join(proj, 'ignored.log'), 'log1\n')
  await mkdir(join(proj, 'node_modules'))
  await writeFile(join(proj, 'node_modules', 'x.js'), 'x\n')

  const c1 = await cp.captureCheckpoint(proj, 'sess-1', '第一轮：改 a')
  ok(!!c1 && c1.kind === 'turn' && c1.sessionKey === 'sess-1', '发消息前能存下检查点')

  await writeFile(join(proj, 'a.txt'), 'A2 changed\n')
  await rm(join(proj, 'sub', 'b.txt'))
  await writeFile(join(proj, 'new.txt'), 'NEW\n')
  await writeFile(join(proj, 'ignored.log'), 'log2\n')
  const c2 = await cp.captureCheckpoint(proj, 'sess-1', '第二轮：再改')
  ok(!!c2 && c2.id !== c1.id, '每一轮各有自己的检查点')

  const list = await cp.listCheckpoints(proj, 'sess-1')
  ok(list.length === 2 && list[0].id === c1.id, '按会话列出检查点（旧的在前）')
  ok((await cp.listCheckpoints(proj, 'other')).length === 0, '别的会话看不到')
  ok(!('sha' in list[0]), '界面看不到内部的快照提交号')

  const preview = await cp.previewCheckpoint(proj, c1.id)
  const by = Object.fromEntries(preview.changes.map((c) => [c.path, c.status]))
  ok(preview.ok && by['a.txt'] === 'M', '预览：被改过的文件标 M')
  ok(by['sub/b.txt'] === 'D', '预览：被删掉的文件回退后会恢复（D）')
  ok(by['new.txt'] === 'A', '预览：之后新建的文件回退后会被删（A）')
  ok(!('ignored.log' in by) && !Object.keys(by).some((p) => p.startsWith('node_modules')), '预览：被忽略的文件和 node_modules 不在其中')
  ok((await read(join(proj, 'a.txt'))) === 'A2 changed\n', '预览不改任何文件')

  const res = await cp.restoreCheckpoint(proj, c1.id, 'sess-1')
  ok(res.ok && !!res.undoId && res.restored >= 3, '回退成功并给出撤销点', `restored=${res.restored}`)
  ok((await read(join(proj, 'a.txt'))) === 'A1\n', '回退：改过的文件恢复')
  ok(await exists(join(proj, 'sub', 'b.txt')), '回退：被删的文件恢复')
  ok(!(await exists(join(proj, 'new.txt'))), '回退：之后新建的文件被删除')
  ok((await read(join(proj, 'ignored.log'))) === 'log2\n', '回退：被 .gitignore 忽略的文件不动')
  ok(await exists(join(proj, 'node_modules', 'x.js')), '回退：node_modules 不动')

  const undo = await cp.restoreCheckpoint(proj, res.undoId, 'sess-1')
  ok(undo.ok, '撤销回退成功')
  ok((await read(join(proj, 'a.txt'))) === 'A2 changed\n' && (await exists(join(proj, 'new.txt'))) && !(await exists(join(proj, 'sub', 'b.txt'))), '撤销：回到回退之前的样子')

  const again = await cp.captureCheckpoint(proj, 'sess-1', '第三轮：没有改动')
  ok(!!again, '没有改动的回合也有检查点')
  const gone = await cp.restoreCheckpoint(proj, 'no-such-id', 'sess-1')
  ok(!gone.ok && /找不到/.test(gone.error ?? ''), '不存在的检查点：明确报错、不动文件')

  ok(cp.isCheckpointableDir(proj) && !cp.isCheckpointableDir(process.env.USERPROFILE || process.env.HOME || '/'), '家目录不做检查点')
  ok((await cp.captureCheckpoint(join(proj, 'does-not-exist'), 's', 'x')) === null, '目录不存在：不做、不抛错')

  await cp.pruneCheckpoints(Date.now() + 31 * 24 * 3600 * 1000)
  ok((await cp.listCheckpoints(proj, 'sess-1')).length === 0, '超过 30 天的检查点被清理')
} finally {
  await rm(data, { recursive: true, force: true }).catch(() => undefined)
  await rm(proj, { recursive: true, force: true }).catch(() => undefined)
}
console.log(failed ? `${failed} 项失败` : '检查点：全部通过')
process.exit(failed ? 1 : 0)
