/** One failed subagent can be acknowledged without clearing others or rewriting its error. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-dismiss-'))
process.env.YAN_PI_DIR = join(work, 'pi')
process.env.YAN_DATA_DIR = join(work, 'yan')
process.env.YAN_USER_DATA = join(work, 'electron')
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const controllers = []
try {
  const output = join(work, 'controller.mjs')
  await build({ entryPoints: ['src/main/subagents.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { SubagentController } = await import(pathToFileURL(output).href)
  const rpcs = []
  const changes = []
  let notifications = 0
  const archive = join(work, 'archives')
  const make = () => {
    const controller = new SubagentController({ cwd: work, archiveDir: archive, onChange: run => changes.push(run), onFinished: () => { notifications++ },
      prepare: async (rootCwd, id, isolation) => ({ rootCwd, cwd: rootCwd, isolation }),
      createRpc: () => {
        const rpc = new EventEmitter()
        rpc.running = false
        rpc.spawn = () => { rpc.running = true }
        rpc.close = async () => { rpc.running = false }
        rpc.command = async command => ({ success: true, data: command === 'get_state' ? {} : undefined })
        rpcs.push(rpc)
        return rpc
      }
    })
    controller.waitTranscriptQuiet = async () => {}
    controllers.push(controller)
    return controller
  }
  const ctrl = make()
  const fail = async task => {
    const started = await ctrl.start(task, undefined, 'controlled-cwd')
    assert.ok(started.ok)
    const rpc = rpcs.at(-1)
    rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial evidence' }], stopReason: 'error', errorMessage: 'fixture failure' } })
    rpc.emit('event', { type: 'agent_settled' })
    const run = ctrl.runs.get(started.run.id)
    await run.settling
    return run
  }
  ok(!(await ctrl.dismiss('missing')).ok, 'unknown record rejected')
  const active = await ctrl.start('still running', undefined, 'controlled-cwd')
  ok(!(await ctrl.dismiss(active.run.id)).ok, 'running record cannot be dismissed')
  ok(ctrl.get(active.run.id).status === 'running', 'dismiss does not stop active task')
  const run = await fail('failed fixture')
  const originalError = ctrl.get(run.id).error
  const originalTranscript = JSON.stringify(ctrl.get(run.id).transcript)
  ok(ctrl.get(run.id).status === 'error' && run.reviewDecided, 'real event path reaches finalized error')
  const savedFile = join(archive, run.id + '.json')
  const originalFile = await readFile(savedFile, 'utf8')
  await rm(savedFile)
  await mkdir(savedFile)
  const beforeFail = changes.length
  const failedSave = await ctrl.dismiss(run.id)
  ok(!failedSave.ok && failedSave.error.includes('保存'), 'disk save failure reported')
  ok(ctrl.get(run.id).dismissedAt === undefined, 'failed save not published in memory')
  ok(changes.length === beforeFail, 'failed save does not push dismissal')
  await rm(savedFile, { recursive: true })
  await writeFile(savedFile, originalFile)
  const noticeCount = notifications
  ok((await ctrl.dismiss(run.id)).ok, 'failed record acknowledged')
  const dismissed = ctrl.get(run.id)
  ok(Number.isFinite(dismissed.dismissedAt), 'acknowledgment persisted in snapshot')
  ok(dismissed.status === 'error' && dismissed.error === originalError, 'original failure preserved')
  ok(JSON.stringify(dismissed.transcript) === originalTranscript, 'transcript preserved')
  ok(ctrl.get(active.run.id).status === 'running', 'other task not touched')
  ok(notifications === noticeCount, 'dismissal does not notify model again')
  ok((await ctrl.dismiss(run.id)).ok && ctrl.get(run.id).dismissedAt === dismissed.dismissedAt, 'repeated dismissal idempotent')
  await ctrl.history.save({ ...dismissed, dismissedAt: undefined }, work)
  const reload = make()
  await reload.loadHistory()
  const restored = reload.get(run.id)
  ok(restored?.dismissedAt === dismissed.dismissedAt && restored.status === 'error', 'restart and late stale saves retain acknowledgment')
  ok(restored?.error === originalError && JSON.stringify(restored.transcript) === originalTranscript, 'restart retains evidence')

  const pending = await fail('pending review fixture')
  pending.review = 'pending'
  ok(!(await ctrl.dismiss(pending.id)).ok && !ctrl.get(pending.id).dismissedAt, 'pending review cannot bypass discard or merge')
  pending.review = 'conflict'
  ok(!(await ctrl.dismiss(pending.id)).ok, 'conflict cannot bypass review')
  pending.review = 'none'
  pending.reviewDecided = false
  ok(!(await ctrl.dismiss(pending.id)).ok, 'undecided diff cannot be dismissed')
  pending.reviewDecided = true
  ok((await ctrl.dismiss(pending.id)).ok, 'resolved review may be acknowledged')
  const done = await ctrl.start('completed fixture', undefined, 'controlled-cwd')
  rpcs.at(-1).emit('event', { type: 'agent_settled' })
  await ctrl.runs.get(done.run.id).settling
  ok(!(await ctrl.dismiss(done.run.id)).ok, 'successful records cannot be relabeled')
  console.log(`Subagent dismiss backend: ${checks} passed`)
} finally {
  for (const controller of controllers) await controller.stopAll()
  await rm(work, { recursive: true, force: true })
}
