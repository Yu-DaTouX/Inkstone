import { spawnSync } from 'node:child_process'
import { runSuite } from './lib/test-suite.mjs'

const waitFor = async (check, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

await runSuite(import.meta.url, async (ok, compile) => {
  const decode = await compile('src/main/mcp/stderr-decode.ts', { packages: 'external' })
  const { StdioTreeClientTransport } = await compile('src/main/mcp/stdio-tree-transport.ts', { packages: 'external' })

  const gbk = Buffer.from([0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee])
  ok(decode.decodeProcessOutput(gbk, false, () => 936) === '不是内部或外部命令', 'GBK 字节在代码页 936 下按 GBK 解码')
  ok(decode.decodeProcessOutput(gbk, false, () => null).includes('\ufffd'), '代码页未知时保持原来的 UTF-8 宽松解码')
  ok(decode.decodeProcessOutput(gbk, false, () => 437).includes('\ufffd'), '不支持的代码页保持原样')
  const utf8 = Buffer.from('错误：找不到文件 ok\n', 'utf8')
  ok(decode.decodeProcessOutput(utf8, false, () => 936) === '错误：找不到文件 ok\n', 'UTF-8 输出不受 OEM 代码页影响')
  ok(decode.decodeProcessOutput(utf8, false, () => { throw new Error('UTF-8 不应查询代码页') }) === '错误：找不到文件 ok\n', 'UTF-8 输出不触发代码页查询')
  const cut = utf8.subarray(1)
  ok(!decode.decodeProcessOutput(cut, true, () => 936).includes('\ufffd') && decode.decodeProcessOutput(cut, true, () => 936).endsWith('：找不到文件 ok\n'), '头部被截断的 UTF-8 字符不会误判为 GBK')
  ok(decode.parseOemCodePage('    OEMCP    REG_SZ    936\r\n') === 936, '解析注册表 OEMCP')
  ok(decode.parseOemCodePage('garbage') === null, '无法解析时返回 null')

  if (process.platform !== 'win32') return

  const missing = 'yan-no-such-command-xyz'
  const direct = spawnSync('cmd.exe', ['/d', '/c', missing], { windowsHide: true })
  const directText = decode.decodeProcessOutput(direct.stderr)
  const zh = decode.systemOemCodePage() === 936
  ok(!directText.includes('\ufffd') && directText.includes(missing), '真实 cmd 找不到命令的 stderr 解码后无替换字符', directText)
  if (zh) ok(directText.includes('不是内部或外部命令'), '中文系统上能读到「不是内部或外部命令」', directText)
  else ok(/not recognized|不是内部|ni est pas|no se reconoce/i.test(directText) || directText.length > 0, '非中文系统 stderr 可读', directText)

  const transport = new StdioTreeClientTransport({ command: 'cmd.exe', args: ['/d', '/c', missing] })
  await transport.start()
  const got = await waitFor(() => transport.stderrTail().includes(missing), 8000)
  const tail = transport.stderrTail()
  ok(got && !tail.includes('\ufffd'), '传输层采集的 stderr 无替换字符', tail)
  if (zh) ok(tail.includes('不是内部或外部命令'), '传输层 stderr 含中文「不是内部或外部命令」', tail)
  await transport.close()

  const utfTransport = new StdioTreeClientTransport({ command: process.execPath, args: ['-e', "process.stderr.write('启动失败：缺少依赖\\n')"] })
  await utfTransport.start()
  await waitFor(() => utfTransport.stderrTail().includes('缺少依赖'), 8000)
  ok(utfTransport.stderrTail() === '启动失败：缺少依赖', '传输层对 UTF-8 stderr 保持原样', utfTransport.stderrTail())
  await utfTransport.close()
})
