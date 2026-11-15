import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  await runWorkbenchTests(ok, await compile('src/renderer/src/state/workspace-key.ts', { platform: 'neutral' }))
})

export async function runWorkbenchTests(ok, { workbenchSessionKey }) {

  console.log('\n--- H-3a 布局身份 ---')
  ok(workbenchSessionKey('C:/a/session.jsonl', 'sid') === 'C:/a/session.jsonl', '优先使用稳定会话文件作为布局身份')
  ok(workbenchSessionKey(undefined, 'sid') === 'sid', '没有文件时回退到 sessionId')
  ok(workbenchSessionKey(undefined, undefined) === 'pending', '都没有时用临时身份 pending')
}
