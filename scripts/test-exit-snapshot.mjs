import { readFile, rm } from 'node:fs/promises'

export async function runExitSnapshotTests(ok, snapshotModule) {
  const { EXIT_SNAPSHOT_FILE, writeExitSnapshot } = snapshotModule
  const status = {
    id: 'r-snapshot',
    runId: 'r-snapshot',
    sessionId: 'session-snapshot',
    sessionFile: 'C:/sessions/one.jsonl',
    projectId: 'project-snapshot',
    generation: 3,
    cwd: 'C:/work/project',
    running: true,
    waiting: false,
    failed: false,
    conn: 'ready',
    createdAt: 100,
    lastActiveAt: 200,
    isActive: true,
    text: '这段正文不应该被写入退出快照'
  }

  await writeExitSnapshot('save', [status])
  const saved = JSON.parse(await readFile(EXIT_SNAPSHOT_FILE, 'utf8'))
  ok(saved.version === 1 && saved.mode === 'save', '退出快照写入版本与 save 模式')
  ok(saved.runners.length === 1 && saved.runners[0].sessionId === 'session-snapshot', '退出快照保留会话运行实例身份')
  ok(saved.runners[0].generation === 3 && saved.runners[0].running === true, '退出快照保留 generation 与运行状态')
  ok(!('isActive' in saved.runners[0]) && !('text' in saved.runners[0]), '退出快照不写入视图字段和消息正文')

  await writeExitSnapshot('interrupt', [status])
  const interrupted = JSON.parse(await readFile(EXIT_SNAPSHOT_FILE, 'utf8'))
  ok(interrupted.mode === 'interrupt', '中断退出覆盖写入 interrupt 模式')
  await rm(EXIT_SNAPSHOT_FILE, { force: true })
}
