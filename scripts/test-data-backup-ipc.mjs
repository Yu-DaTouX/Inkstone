import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const mock = { dialogs: [], confirmations: [], selections: [], launches: [], hold: null }
  globalThis.__backupIpcFixture = mock
  const outfile = join(root, 'ipc.mjs')
  await build({
    entryPoints: ['src/main/ipc/workspace-data-ipc.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'isolated-ipc', setup(builder) {
      builder.onResolve({ filter: /^(electron|\.\.\/(paths|sessions|settings|data-restore-launch))$/ }, (args) => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
        path === 'electron' ? `const fixture=globalThis.__backupIpcFixture; export const app={isPackaged:true,getAppPath:()=>'/fixture'}; export const dialog={async showOpenDialog(_win,options){fixture.dialogs.push(options);if(fixture.hold)await fixture.hold;return fixture.selections.shift()??{canceled:true,filePaths:[]}},async showMessageBox(_win,options){fixture.confirmations.push(options);return {response:fixture.answer??1}}};`
        : path === '../paths' ? `export const PI_AGENT_DIR=${JSON.stringify(pi)}; export const YAN_DIR=${JSON.stringify(yan)};`
        : path === '../sessions' ? `export const SESSIONS_DIR=${JSON.stringify(sessions)};`
        : path === '../settings' ? "export const getSettings=async()=>({lang:'zh-CN'});"
        : 'export const launchRestoredData=async(...args)=>{globalThis.__backupIpcFixture.launches.push(args)};'
      }))
    }}]
  })
  const { registerWorkspaceDataIpc } = await import(pathToFileURL(outfile).href)
  let handler
  registerWorkspaceDataIpc({ handle(channel, fn) { assert.equal(channel, 'yan:backup'); handler = fn } }, () => ({}))
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
