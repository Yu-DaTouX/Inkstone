import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const endings = await import(new URL('../resources/pi-extensions/write-line-endings.js', import.meta.url))

assert.equal(endings.detectLineEnding('a\r\nb\n'), '\r\n', '按第一处换行判断 CRLF')
assert.equal(endings.detectLineEnding('a\nb\r\n'), '\n', '按第一处换行判断 LF')
assert.equal(endings.detectLineEnding('one line'), undefined, '没有换行时不判断')
assert.equal(endings.withLineEnding('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc', '混合换行统一成 CRLF，不出现 \\r\\r\\n')
assert.equal(endings.withLineEnding('a\r\nb\n', '\n'), 'a\nb\n', '统一成 LF')

const root = await mkdtemp(join(tmpdir(), 'inkstone-write-endings-'))
try {
  await writeFile(join(root, 'crlf.js'), 'const a = 1\r\nconst b = 2\r\n')
  await writeFile(join(root, 'lf.js'), 'const a = 1\nconst b = 2\n')
  await writeFile(join(root, 'single.txt'), 'no newline')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x62]))

  const hooks = {}
  endings.registerWriteLineEndings({ on: (name, fn) => { hooks[name] = fn } })
  const call = (input, toolName = 'write') => {
    const event = { toolName, input: { ...input } }
    assert.equal(hooks.tool_call(event, { cwd: root }), undefined, 'write 不被拦截')
    return event.input.content
  }

  assert.equal(call({ path: 'crlf.js', content: 'x\ny\n' }), 'x\r\ny\r\n', '覆盖 CRLF 文件时沿用 CRLF')
  assert.equal(call({ path: join(root, 'crlf.js'), content: 'x\r\ny\n' }), 'x\r\ny\r\n', '绝对路径与混合换行同样统一')
  assert.equal(call({ path: '@crlf.js', content: 'x\ny' }), 'x\r\ny', '兼容 pi 的 @ 路径前缀')
  assert.equal(call({ path: 'lf.js', content: 'x\r\ny\r\n' }), 'x\ny\n', '覆盖 LF 文件时沿用 LF')
  assert.equal(call({ path: 'lf.js', content: 'x\ny\n' }), 'x\ny\n', '换行一致时不改')
  assert.equal(call({ path: 'new.js', content: 'x\ny\n' }), 'x\ny\n', '新文件行为不变')
  assert.equal(call({ path: 'new-crlf.js', content: 'x\r\ny\r\n' }), 'x\r\ny\r\n', '新文件保留模型给的 CRLF')
  assert.equal(call({ path: 'single.txt', content: 'x\r\ny' }), 'x\r\ny', '原文件没有换行时不改')
  assert.equal(call({ path: 'binary.bin', content: 'x\ny' }), 'x\ny', '二进制文件不改')
  assert.equal(call({ path: 'crlf.js', content: 'xy' }), 'xy', '新内容没有换行时不改')
  assert.equal(call({ path: 'crlf.js', content: 'x\ny' }, 'edit'), 'x\ny', '只处理 write')
  assert.equal(call({ path: root, content: 'x\ny' }), 'x\ny', '目录路径不改')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('write line endings tests passed')
