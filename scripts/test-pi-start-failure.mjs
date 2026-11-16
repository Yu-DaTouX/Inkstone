import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const failure = await compile('src/shared/pi-start-failure.ts', { platform: 'neutral' })
  const verification = await compile('src/main/mcp/verification-error.ts', { platform: 'neutral' })

  const loadLine = '\u001b[31mError: Failed to load extension "C:\\Users\\me\\.pi\\agent\\extensions\\herdr-agent-state.ts": Cannot find module \'./host-message.js\'\u001b[0m'
  const parsed = failure.parsePiExtensionFailures(['noise', loadLine, loadLine])
  ok(parsed.length === 1, '同一扩展的重复报错只算一条')
  ok(parsed[0].name === 'herdr-agent-state.ts' && parsed[0].path.endsWith('herdr-agent-state.ts'), '解析出扩展名与路径（含终端颜色码）', JSON.stringify(parsed))
  ok(parsed[0].reason === "Cannot find module './host-message.js'" && parsed[0].conflict === false, '解析出失败原因')

  const indexLine = 'Error: Failed to load extension "/home/me/.pi/agent/packages/fancy/index.ts": SyntaxError: Unexpected token'
  ok(failure.parsePiExtensionFailures([indexLine])[0].name === 'fancy', 'index 入口的扩展包用目录名')

  const conflictLine = 'Error: Failed to load extension "E:\\ext\\b.js": Tool "search" conflicts with E:\\ext\\a.js'
  const conflict = failure.parsePiExtensionFailures([conflictLine])
  ok(conflict.length === 1 && conflict[0].conflict === true && conflict[0].name === 'b.js', '工具重名识别为冲突')

  const secret = failure.parsePiExtensionFailures(['Failed to load extension "x.js": bad key sk-abcdefghijklmnop'])
  ok(!secret[0].reason.includes('sk-abcdefghijklmnop'), '原因里的密钥已遮蔽')

  const text = failure.piStartFailureText({ running: false, stderr: ['noise', loadLine] })
  ok(text.includes('herdr-agent-state.ts') && text.includes("Cannot find module './host-message.js'"), '提示写明是哪个扩展、什么原因', text)
  ok(!text.includes('probe-pi'), '提示里没有面向开发者的 probe-pi')
  const conflictText = failure.piStartFailureText({ running: false, stderr: [conflictLine] })
  ok(conflictText.includes('冲突') && conflictText.includes('b.js'), '重名时提示冲突', conflictText)

  const many = failure.piStartFailureText({ running: false, stderr: ['a', 'b', 'c', 'd', 'e'].map((name) => `Failed to load extension "/x/${name}.js": boom`) })
  ok(many.includes('a.js') && many.includes('c.js') && !many.includes('d.js') && many.includes('另有 2 个'), '多个失败只列前三个并给出余数', many)

  for (const input of [
    { running: false, stderr: [] },
    { running: true, stderr: [] },
    { running: false, spawnFailure: 'spawn EPERM', stderr: [] }
  ]) {
    const generic = failure.piStartFailureText(input)
    ok(generic.length > 0 && !generic.includes('probe-pi'), '没有扩展报错时的兜底提示也不含 probe-pi', generic)
  }
  ok(failure.piStartFailureText({ running: false, spawnFailure: 'spawn EPERM', stderr: [] }).includes('spawn EPERM'), '启动失败保留原始原因')

  ok(verification.verificationErrorText(new Error('a sk-abcdefghijklmnop b')) === 'a [redacted] b', '检查失败原因经密钥遮蔽')
  ok(verification.verificationErrorText(new Error('x'.repeat(7000))).length === 6001, '检查失败原因有长度上限')
  ok(verification.verificationErrorText(undefined) === undefined && verification.verificationErrorText('  ') === undefined, '没有原因时不返回')
})
