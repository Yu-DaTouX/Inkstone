import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-backup-ipc-'))
let count = 0
const check = (value, message) => { assert.ok(value, message); count++; console.log(`✓ ${message}`) }
try {
  const pi = join(root, 'pi-agent')
  const sessions = join(pi, 'sessions')
  const yan = join(pi, 'yan')
  const backups = join(root, 'backups')
  const recovered = join(root, 'recovered')
  for (const dir of [sessions, yan, backups, recovered]) await mkdir(dir, { recursive: true })
  await writeFile(join(sessions, 'session.jsonl'), '{"type":"session","version":3,"id":"fixture-ipc-test"}\n')
  const mock = { dialogs: [], confirmations: [], selections: [], launches: [], trashed: [], hold: null, limits: undefined }
  globalThis.__backupIpcFixture = mock
  const outfile = join(root, 'ipc.mjs')
  await build({
    entryPoints: ['src/main/ipc/workspace-data-ipc.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'isolated-ipc', setup(builder) {
      builder.onResolve({ filter: /^(electron|\.\.\/(paths|sessions|settings|data-restore-launch|data-backup))$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
        path === 'electron' ? `const fixture=globalThis.__backupIpcFixture; export const app={isPackaged:true,getAppPath:()=>'/fixture'}; export const shell={async trashItem(path){fixture.trashed.push(path)}}; export const dialog={async showOpenDialog(_win,options){fixture.dialogs.push(options);if(fixture.hold)await fixture.hold;return fixture.selections.shift()??{canceled:true,filePaths:[]}},async showMessageBox(_win,options){fixture.confirmations.push(options);return {response:fixture.answer??1}}};`
        : path === '../paths' ? `export const PI_AGENT_DIR=${JSON.stringify(pi)}; export const YAN_DIR=${JSON.stringify(yan)};`
        : path === '../sessions' ? `export const SESSIONS_DIR=${JSON.stringify(sessions)};`
        : path === '../data-backup' ? `import { createDataBackup as real } from ${JSON.stringify(resolve('src/main/data-backup.ts'))}; export * from ${JSON.stringify(resolve('src/main/data-backup.ts'))}; export const createDataBackup=(parent,sessions,yan,options={})=>real(parent,sessions,yan,{...options,limits:globalThis.__backupIpcFixture.limits});`
        : path === '../settings' ? "export const getSettings=async()=>({lang:'zh-CN'});"
        : 'export const launchRestoredData=async(...args)=>{globalThis.__backupIpcFixture.launches.push(args)};',
        resolveDir: process.cwd()
      }))
    }}]
  })
  const { registerWorkspaceDataIpc } = await import(pathToFileURL(outfile).href)
  const handlers = new Map()
  registerWorkspaceDataIpc({ handle(channel, fn) { handlers.set(channel, fn) } }, () => ({}))
  const handler = handlers.get('yan:backup')
  check(handler && handlers.has('yan:backup:incomplete') && handlers.has('yan:backup:incompleteTrash'), '备份与未完成恢复清单的通道都已注册')
  const choose = (path) => mock.selections.push({ canceled: false, filePaths: [path] })
  check(!(await handler('open-restored')).ok && mock.launches.length === 0, '未恢复前不能打开任意数据目录')
  check((await handler('unexpected')).cancelled && mock.dialogs.length === 0, '拒绝非法备份动作')
  choose(backups)
  const backup = await handler('create')
  check(backup.ok, '创建备份通过既有 IPC')
  choose(backup.summary.path)
  check((await handler('verify')).ok && mock.confirmations.length === 0, '校验不要求恢复、不写入当前数据')
  choose(backup.summary.path)
  const cancelled = await handler('restore')
  check(cancelled.cancelled && mock.confirmations[0].defaultId === 1 && mock.launches.length === 0, '恢复确认默认取消，取消不会启动新窗口')
  mock.answer = 0
  choose(backup.summary.path)
  choose(recovered)
  const restored = await handler('restore')
  check(restored.ok && restored.summary.path.startsWith(recovered) && mock.launches.length === 0, '恢复到新目录后不会自动启动或重启应用')
  check((await readFile(join(sessions, 'session.jsonl'), 'utf8')).includes('fixture-ipc-test'), '当前会话仍留在原位置')
  check((await handler('open-restored')).ok && mock.launches.length === 1 && mock.launches[0][0] === restored.summary.path, '只有明确点击打开才启动本次恢复目录')
  mkdirSync(join(yan, 'attachments'), { recursive: true })
  for (const name of ['1.png', '2.png']) await writeFile(join(yan, 'attachments', name), 'image')
  mock.limits = { maxFiles: 2 }
  mock.answer = 1
  const before = mock.confirmations.length
  const dirsBefore = (await readdir(backups)).length
  choose(backups)
  const declined = await handler('create')
  const prompt = mock.confirmations[before]
  check(declined.cancelled && prompt && /附件/.test(prompt.detail) && /将跳过/.test(prompt.detail) && prompt.defaultId === 1, '备份超限时先告诉用户哪些部分太大，默认选「取消」')
  check((await readdir(backups)).length === dirsBefore, '取消后不留新备份')
  mock.answer = 0
  choose(backups)
  const skipped = await handler('create')
  check(skipped.ok && skipped.summary.skipped?.[0]?.part === 'attachments' && skipped.summary.skipped[0].files === 2, '用户同意后跳过超限部分继续备份，并在结果里写明')
  mock.limits = undefined
  await writeFile(join(yan, 'desktop.json'), '{broken json')
  choose(backups)
  const broken = await handler('create')
  mock.answer = 0
  choose(broken.summary.path)
  choose(recovered)
  const failedRestore = await handler('restore')
  check(!failedRestore.ok && /Incomplete restore retained/.test(failedRestore.error), '恢复中途失败时返回错误并说明保留了半成品目录')
  const incomplete = await handlers.get('yan:backup:incomplete')()
  check(incomplete.length === 1 && incomplete[0].error && incomplete[0].bytes >= 0 && failedRestore.error.includes(incomplete[0].path), '半成品目录出现在未完成清单里，带原因和大小')
  const refused = await handlers.get('yan:backup:incompleteTrash')(backups)
  check(!refused.ok && mock.trashed.length === 0, '清单之外的目录拒绝移到回收站')
  const trashedOk = await handlers.get('yan:backup:incompleteTrash')(incomplete[0].path)
  check(trashedOk.ok && mock.trashed.join() === incomplete[0].path && (await handlers.get('yan:backup:incomplete')()).length === 0, '用户点击后才把半成品目录移到回收站')
  let release
  mock.hold = new Promise((resolve) => { release = resolve })
  const running = handler('verify')
  check(!(await handler('create')).ok, '同一窗口的备份与恢复操作互斥')
  release()
  await running
  mock.hold = null
  check((await handler('verify')).cancelled, '取消后恢复操作锁会释放')
  console.log(`\n${count} passed`)
} finally {
  delete globalThis.__backupIpcFixture
  await rm(root, { recursive: true, force: true })
}
