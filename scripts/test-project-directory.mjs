import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'yan-project-directory-'))
const keys = ['YAN_PI_DIR', 'YAN_DATA_DIR', 'YAN_SESSIONS_DIR', 'YAN_TEST_DOCS_PATH']
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const source = join(temp, 'source'), target = join(temp, 'target'), other = join(temp, 'other'), later = join(temp, 'later')
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`✓ ${message}`) }
try {
  Object.assign(process.env, {
    YAN_PI_DIR: join(temp, 'pi'), YAN_DATA_DIR: join(temp, 'data'),
    YAN_SESSIONS_DIR: join(temp, 'sessions'), YAN_TEST_DOCS_PATH: join(temp, 'documents')
  })
  for (const path of [source, target, other, later, process.env.YAN_SESSIONS_DIR, process.env.YAN_TEST_DOCS_PATH]) await mkdir(path, { recursive: true })
  const outfile = join(temp, 'fixture.mjs')
  await build({
    stdin: { contents: `export * from './src/main/project-directory'; export * from './src/main/settings'; export * from './src/main/session-layout'; export * from './src/main/file-context';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'isolated-electron-and-write-fault', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'project-fixture' }))
      b.onLoad({ filter: /^electron$/, namespace: 'project-fixture' }, () => ({ contents: `export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_TEST_DOCS_PATH };`, loader: 'js' }))
      b.onResolve({ filter: /^node:fs\/promises$/ }, (args) => args.namespace === 'project-fixture' ? { path: args.path, external: true } : { path: 'fs', namespace: 'project-fixture' })
      b.onLoad({ filter: /^fs$/, namespace: 'project-fixture' }, () => ({ contents: `export * from 'node:fs/promises'; import * as fs from 'node:fs/promises'; export async function rename(from, to) { if (globalThis.__yanProjectFolderFailWrite && to.endsWith('desktop.json')) throw new Error('fixture write failure'); return fs.rename(from, to); }`, loader: 'js' }))
    } }]
  })
  const m = await import(pathToFileURL(outfile).href)
  const project = { id: 'p-main', cwd: source, name: 'Personal', groupId: 'g', createdAt: 1, updatedAt: 1 }
  await m.patchSettings({ cwd: source, projects: [project, { id: 'p-other', cwd: other, name: 'Other', createdAt: 2, updatedAt: 2 }],
    projectNames: { [source]: 'Personal', [other]: 'Other' }, projectGroups: [{ id: 'g', name: 'Group', createdAt: 1 }], projectOrder: ['p-main', 'p-other'], recentCwds: [source, other] })
  const file = join(process.env.YAN_DATA_DIR, 'desktop.json')
  const oldSession = join(process.env.YAN_SESSIONS_DIR, 'old.jsonl')
  const legacySession = join(process.env.YAN_SESSIONS_DIR, 'legacy.jsonl')
  const sessionText = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: source }) + '\n'
  await writeFile(oldSession, sessionText('old'))
  await writeFile(legacySession, sessionText('legacy'))
  await writeFile(join(source, 'keep.txt'), 'never moved')
  await m.rememberSession({ sessionId: 'old', sessionFile: oldSession, cwd: source, projectId: 'p-main', scope: 'project', pinned: true })
  const originalLog = await readFile(oldSession, 'utf8')
  const request = { projectId: 'p-main', expectedCwd: source, cwd: target }
  const before = await readFile(file, 'utf8')
  for (const invalid of [null, [], {}, { ...request, cwd: 'relative' }, { ...request, cwd: join(temp, 'missing') }, { ...request, cwd: oldSession }, { ...request, projectId: 'missing' }, { ...request, expectedCwd: other }]) {
    const result = await m.changeProjectDirectory(invalid)
    check(!result.ok && !!result.error, '非法请求/失效目录/陈旧来源明确拒绝')
  }
  check(await readFile(file, 'utf8') === before, '拒绝请求不改变设置文件')
  check(!(await m.changeProjectDirectory({ ...request, cwd: other })).ok, '拒绝被其他项目占用的目标')
  const alias = join(temp, 'other-link')
  try {
    await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
    check(!(await m.changeProjectDirectory({ ...request, cwd: alias })).ok, '目录链接不能绕过占用检查')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') console.log('SKIP: 本机无目录链接权限')
    else throw error
  }
  globalThis.__yanProjectFolderFailWrite = true
  const failure = await m.changeProjectDirectory(request)
  globalThis.__yanProjectFolderFailWrite = false
  check(!failure.ok && failure.error.includes('fixture write failure'), '设置落盘失败如实返回错误')
  check(await readFile(file, 'utf8') === before && (await m.getSettings()).projects.find((p) => p.id === 'p-main').cwd === source, '落盘失败不改变磁盘或缓存项目目录')
  const result = await m.changeProjectDirectory(request)
  check(result.ok, '有效目标更改成功')
  const moved = result.settings.projects.find((p) => p.id === 'p-main')
  check(moved.cwd === target && moved.name === 'Personal' && moved.groupId === 'g' && moved.createdAt === 1, '保留稳定身份、名称、分组与创建时间')
  check(result.settings.projectOrder.join(',') === 'p-main,p-other', '保留项目顺序')
  check(!result.settings.projects.some((p) => p.cwd === source) && !(source in result.settings.projectNames), '清理旧路径映射，不被设置清洗重建幽灵项目')
  check(result.settings.cwd === target && result.settings.recentCwds.includes(target), '更新默认/最近目录而不操作运行实例')
  check((await readFile(oldSession, 'utf8')) === originalLog && (await readFile(join(source, 'keep.txt'), 'utf8')) === 'never moved', '历史JSONL与项目磁盘文件不搬动、不改写')
  const entries = (await m.getSessionLayout()).entries
  check(['old', 'legacy'].every((id) => entries.some((e) => e.sessionId === id && e.projectId === 'p-main' && e.cwd === source)), '已登记和旧版未登记会话保持原归属及执行目录')
  check(entries.find((e) => e.sessionId === 'old').pinned, '保留会话置顶状态')
  const statuses = [{ cwd: source, projectId: 'p-main' }, { cwd: other, projectId: 'p-other' }]
  check(await m.isRunnerProjectCwd(source, 'p-main', statuses), '已打开的同项目旧会话仍可访问旧目录')
  check(!await m.isRunnerProjectCwd(source, 'p-other', statuses) && !await m.isRunnerProjectCwd(source, 'p-main', []), '拒绝跨项目或无宿主实例的旧目录请求')
  check(!await m.isRunnerProjectCwd(join(source, 'keep.txt'), 'p-main', statuses), '旧会话授权不能扩大到任意子路径作为根')
  check(!(await m.changeProjectDirectory(request)).ok, '旧对话框不能覆盖已经改过的目录')
  const stable = await readFile(file, 'utf8')
  check((await m.changeProjectDirectory({ ...request, expectedCwd: target })).ok && await readFile(file, 'utf8') === stable, '相同目录提交幂等，不重复写设置')
  await Promise.all([
    m.updateSettings((s) => ({ projects: s.projects.map((p) => p.id === 'p-main' ? { ...p, name: 'Renamed', archived: true } : p) })),
    m.changeProjectDirectory({ ...request, expectedCwd: target, cwd: later }).then((r) => assert.ok(r.ok, r.error))
  ])
  const concurrent = (await m.getSettings()).projects.find((p) => p.id === 'p-main')
  check(concurrent.cwd === later && concurrent.name === 'Renamed' && concurrent.archived, '串行更新保留并发改名/归档，不覆盖整份旧项目表')
  check(!(await m.changeProjectDirectory({ projectId: 'p-other', expectedCwd: other, cwd: later })).ok, '已归档项目也占用其目录，不静默合并')

  const host = await readFile('src/main/index.ts', 'utf8')
  const ui = await readFile('src/renderer/src/components/rail/ProjectDirectoryDialog.tsx', 'utf8')
  const preload = await readFile('src/preload/index.ts', 'utf8')
  check(host.includes('isRunnerProjectCwd(checked.cwd, projectId, runners?.statuses() ?? [])'), '正式文件上下文入口接入宿主实例归属检查')
  check(host.includes('next = await updateSettings((current) =>') && host.includes('项目文件夹已变化，请刷新后重试'), '旧的普通设置写入也在队列内拒绝陈旧目录')
  check(ui.includes('busyRef.current') && ui.includes('!mounted.current') && ui.includes('useFocusTrap(dialog, true, isTop)') && ui.includes('document.body'), '对话框包含重入/卸载保护、焦点圈定及Portal')
  check(preload.includes("'yan:project:changeDirectory'") && !ui.includes('window.yan.setCwd('), '独立IPC入口不复用会话切换')
  console.log(`项目文件夹定向检查：${checks} 项通过（隔离夹具，不代替真实窗口验收）`)
} finally {
  delete globalThis.__yanProjectFolderFailWrite
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  await rm(temp, { recursive: true, force: true })
}
