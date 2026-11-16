import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile(null, {
    stdin: {
      contents: "export * from './src/main/exit-snapshot.ts'\nexport { rememberSession } from './src/main/session-layout.ts'\n",
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    external: ['electron']
  })
  const sessions = process.env.YAN_SESSIONS_DIR
  const dir = join(sessions, '--C--work--')
  mkdirSync(dir, { recursive: true })
  const line = (role, extra = {}) => JSON.stringify({ type: 'message', timestamp: '2026-11-16T00:00:00.000Z', message: { role, ...extra } })
  const sessionFile = (name, lines) => {
    const file = join(dir, `${name}.jsonl`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    return file
  }
  const status = (file, running) => ({
    id: 'r1', runId: 'r1', sessionId: 's1', sessionFile: file, generation: 1, cwd: 'C:/work',
    running, waiting: false, failed: false, conn: 'ready', createdAt: 1, lastActiveAt: 2, isActive: true
  })

  ok((await mod.restorePreviousSession()) === undefined && mod.takeRestoreNotice() === undefined, '没有快照也没有会话记录时不恢复、不提示')

  const done = sessionFile('done', [line('user'), line('assistant', { stopReason: 'stop' })])
  await mod.writeExitSnapshot('save', [status(done, false)])
  const clean = await mod.restorePreviousSession()
  ok(clean?.sessionFile === done && clean.interrupted === false, '快照里的已结束会话按原文件恢复')
  ok(mod.takeRestoreNotice() === undefined, '正常结束的会话不提示')
  ok(!existsSync(mod.EXIT_SNAPSHOT_FILE), '读取后清掉退出快照')

  await mod.writeExitSnapshot('interrupt', [status(done, true)])
  const running = await mod.restorePreviousSession()
  ok(running?.sessionFile === done && running.interrupted === true, '退出时仍在运行的会话标为中断')
  const notice = mod.takeRestoreNotice()
  ok(typeof notice === 'string' && notice.length > 0, '中断恢复给出一次提示')
  ok(mod.takeRestoreNotice() === undefined, '提示取走后不重复')

  const halfway = sessionFile('halfway', [line('assistant', { stopReason: 'stop' }), line('user')])
  await mod.writeExitSnapshot('save', [status(halfway, false)])
  ok((await mod.restorePreviousSession())?.interrupted === true && !!mod.takeRestoreNotice(), '会话尾停在用户消息时视为中断')

  const outside = join(process.env.YAN_DATA_DIR, 'outside.jsonl')
  writeFileSync(outside, `${line('user')}\n`)
  await mod.writeExitSnapshot('save', [status(outside, true)])
  ok((await mod.restorePreviousSession()) === undefined && mod.takeRestoreNotice() === undefined, '会话目录外的文件不恢复')

  await mod.rememberSession({ sessionId: 'layout-1', sessionFile: done, cwd: 'C:/work' })
  const fromLayout = await mod.restorePreviousSession()
  ok(fromLayout?.sessionFile === done && fromLayout.interrupted === false, '没有快照时按最近打开的会话恢复')
})
