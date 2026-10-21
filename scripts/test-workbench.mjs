export async function runWorkbenchTests(ok) {
  const { workbenchSessionKey } = await import('../out/test/workbench.mjs')

  console.log('\n--- H-3a 布局身份 ---')
  ok(workbenchSessionKey('C:/a/session.jsonl', 'sid') === 'C:/a/session.jsonl', '优先使用稳定会话文件作为布局身份')
  ok(workbenchSessionKey(undefined, 'sid') === 'sid', '没有文件时回退到 sessionId')
  ok(workbenchSessionKey(undefined, undefined) === 'pending', '都没有时用临时身份 pending')
}
