/**
 * 会话移到另一个工作目录的文件头改写（src/main/session-move.ts）。
 * 用临时目录里的假会话文件验证：只改首行 cwd，其余逐字保留；非会话文件拒绝。
 *
 * 单独运行：node scripts/test-session-move.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runSessionMoveTests(ok) {
  await build({ entryPoints: ['src/main/session-move.ts'], outfile: 'out/test/session-move.mjs', bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' })
  const { withSessionHeaderCwd, sessionHeaderCwd, rewriteSessionCwd } = await import(pathToFileURL('out/test/session-move.mjs').href)

  const header = { type: 'session', version: 3, id: 'abc', timestamp: '2026-10-08T00:00:00.000Z', cwd: 'C:\\old\\proj' }
  const body = [JSON.stringify(header), '{"type":"message","id":"1","message":{"role":"user","content":"你好"}}', '']
  const lf = body.join('\n')
  const crlf = body.join('\r\n')

  const moved = withSessionHeaderCwd(lf, 'D:\\new\\proj')
  ok(sessionHeaderCwd(moved) === 'D:\\new\\proj', '首行 cwd 改成新目录')
  ok(moved.slice(moved.indexOf('\n')) === lf.slice(lf.indexOf('\n')), '首行之后逐字保留')
  ok(Object.keys(JSON.parse(moved.split('\n')[0])).join(',') === Object.keys(header).join(','), '会话头字段顺序不变')
  const movedCrlf = withSessionHeaderCwd(crlf, 'D:\\new\\proj')
  ok(movedCrlf.split('\n')[0].endsWith('\r') && movedCrlf.slice(movedCrlf.indexOf('\n')) === crlf.slice(crlf.indexOf('\n')), 'CRLF 文件保持 CRLF')
  ok(sessionHeaderCwd(withSessionHeaderCwd(JSON.stringify(header), 'E:\\x')) === 'E:\\x', '只有一行的会话文件也能改')

  let threw = false
  try { withSessionHeaderCwd('{"type":"message"}\n', 'x') } catch { threw = true }
  ok(threw, '首行不是会话头就拒绝')
  threw = false
  try { withSessionHeaderCwd('not json\n', 'x') } catch { threw = true }
  ok(threw, '首行不是 JSON 就拒绝')

  const dir = await mkdtemp(join(tmpdir(), 'yan-session-move-'))
  try {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, lf, 'utf8')
    const result = await rewriteSessionCwd(file, 'D:\\new\\proj')
    ok(result.previousCwd === 'C:\\old\\proj', '返回原来的工作目录')
    ok(sessionHeaderCwd(await readFile(file, 'utf8')) === 'D:\\new\\proj', '文件里的会话头已改写')
    ok((await readdir(dir)).length === 1, '没有留下临时文件')
    const bad = join(dir, 'bad.jsonl')
    await writeFile(bad, '{"type":"message"}\n', 'utf8')
    let failed = false
    try { await rewriteSessionCwd(bad, 'x') } catch { failed = true }
    ok(failed && (await readFile(bad, 'utf8')) === '{"type":"message"}\n' && (await readdir(dir)).length === 2, '改写失败时原文件不动、不留临时文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  let passed = 0
  await runSessionMoveTests((cond, name) => { if (cond) passed++; else { failed++; console.error('✗', name) } })
  console.log(failed ? `✗ ${failed} 项失败，${passed} 项通过` : `✓ 会话移动 ${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
