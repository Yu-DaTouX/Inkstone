import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-subagent-composer-'))
try {
  const outfile = join(dir, 'composer.mjs')
  await build({ entryPoints: ['src/renderer/src/features/session/subagent-composer.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { subagentComposerMode, forwardedText } = await import(pathToFileURL(outfile).href)

  const run = (over) => ({ status: 'running', isolation: 'shared-cwd', ...over })
  assert.equal(subagentComposerMode(run({})), 'steer', '运行中可以纠偏')
  assert.equal(subagentComposerMode(run({ wrapUp: { reason: 'timeout', since: 1 } })), 'busy', '收尾中暂不接收')
  assert.equal(subagentComposerMode(run({ status: 'starting' })), 'busy', '启动中暂不接收')
  assert.equal(subagentComposerMode(run({ status: 'done' })), 'resume', '结束后可续接')
  assert.equal(subagentComposerMode(run({ status: 'error', isolation: 'controlled-cwd' })), 'resume', '只读子代理失败后也可续接')
  assert.equal(subagentComposerMode(run({ status: 'cancelled', launchFailed: true })), 'hidden', '没启动成功的不显示输入框')
  assert.equal(subagentComposerMode(run({ status: 'done', isolation: 'worktree', resumable: { ok: true } })), 'resume', 'worktree 未合并前可续接')
  assert.equal(subagentComposerMode(run({ status: 'done', isolation: 'worktree', resumable: { ok: false, reason: '已合并' } })), 'blocked', '不可续接时说明原因而不是隐藏')
  assert.equal(subagentComposerMode(run({ isolation: 'worktree' })), 'steer', 'worktree 运行中仍可纠偏')

  assert.deepEqual(forwardedText('【用户追加】请在继续之前先考虑这条信息；仍在原任务范围内工作。\n\n改查 src'), { text: '改查 src', forwarded: true })
  assert.deepEqual(forwardedText('【主会话追加】这是补充\n\n第一行\n\n第二行'), { text: '第一行\n\n第二行', forwarded: true })
  assert.deepEqual(forwardedText('普通消息'), { text: '普通消息', forwarded: false })
  console.log('subagent-composer: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
