#!/usr/bin/env node
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

async function load() {
  await build({
    entryPoints: ['src/renderer/src/app/peer-approval-model.ts'],
    outfile: 'out/test/peer-approval-model.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return import(pathToFileURL('out/test/peer-approval-model.mjs').href)
}

export async function runPeerApprovalModelTests(ok) {
  const { peerDecisionOutcome, withoutApprovalRequest } = await load()
  ok(peerDecisionOutcome(true) === 'approved', '主进程确认已处理：出队')
  ok(peerDecisionOutcome(false) === 'gone', '请求已过期被主进程丢弃：同样出队（它已不再等待）')
  ok(peerDecisionOutcome(null) === 'failed', '调用抛错：保留请求，提示后重试')
  const queue = [{ requestId: 'a' }, { requestId: 'b' }, { requestId: 'c' }]
  const kept = withoutApprovalRequest(queue, 'b')
  ok(kept.map((item) => item.requestId).join('') === 'ac', '只移除已处理的那一条')
  ok(withoutApprovalRequest(queue, 'zz').length === 3, '不存在的请求：队列不变')
  ok(queue.length === 3, '不改动原队列')
}

async function main() {
  let failed = 0
  let passed = 0
  await runPeerApprovalModelTests((cond, label) => {
    if (cond) passed += 1
    else {
      failed += 1
      console.error('✗', label)
    }
  })
  console.log(failed ? `✗ ${failed} 项失败，${passed} 项通过` : `✓ 连接审批 ${passed} 项通过`)
  if (failed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
