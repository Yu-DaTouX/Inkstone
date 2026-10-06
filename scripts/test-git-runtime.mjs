/**
 * 受管 Git 的下载 / 校验 / 安装流程（src/main/git-runtime.ts）。
 * 用本机 HTTP 服务代替 GitHub，用桩函数代替 7z 自解压：验的是
 *   · 哈希不符绝不解压、不留下载残留；
 *   · 第一个来源失败会换下一个；
 *   · 进度阶段齐全、安装记录写入；
 *   · 同时只允许一次安装，且能取消。
 * 真正的 PortableGit 自解压要联网下载 60MB，不放进这里。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

await build({
  entryPoints: ['src/main/git-runtime.ts'],
  outfile: 'out/test/git-runtime.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const runtime = await import('../out/test/git-runtime.mjs')

const good = Buffer.from('fake portable git payload '.repeat(2000))
const bad = Buffer.from('tampered payload '.repeat(2000))
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const server = createServer((request, response) => {
  if (request.url === '/ok') return response.end(good)
  if (request.url === '/bad') return response.end(bad)
  response.statusCode = 500
  response.end('nope')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const work = mkdtempSync(join(tmpdir(), 'yan-git-runtime-'))
const pin = (github, mirror, payload = good) => ({ version: '0.0.0-test', size: payload.length, sha256: sha(good), github: `${base}${github}`, mirror: `${base}${mirror}` })
const stubExtract = async (_file, stage) => {
  mkdirSync(join(stage, 'cmd'), { recursive: true })
  mkdirSync(join(stage, 'bin'), { recursive: true })
  writeFileSync(join(stage, 'cmd', 'git.exe'), 'x')
  writeFileSync(join(stage, 'bin', 'bash.exe'), 'x')
}

try {
  /* 1. 第一个来源失败，换第二个；阶段齐全；安装记录写入 */
  {
    const root = join(work, 'a', 'git')
    const phases = []
    const result = await runtime.installManagedGit({ root, pin: pin('/fail', '/ok'), extract: stubExtract, onProgress: (p) => phases.push(p.phase) })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(['downloading', 'verifying', 'extracting', 'done'].every((phase) => phases.includes(phase)), `阶段：${phases}`)
    assert.ok(existsSync(join(root, 'cmd', 'git.exe')) && existsSync(join(root, 'bin', 'bash.exe')), '安装目录齐全')
    assert.equal(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')).version, '0.0.0-test')
    assert.equal(readdirSync(join(root, '..')).filter((name) => name.endsWith('.download.exe')).length, 0, '没有下载残留')
  }

  /* 2. 哈希不符：所有来源都被拒，绝不解压，也不留残留 */
  {
    const root = join(work, 'b', 'git')
    let extracted = false
    const result = await runtime.installManagedGit({ root, pin: pin('/bad', '/bad'), extract: async (...args) => { extracted = true; await stubExtract(...args) } })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /下载失败/)
    assert.equal(extracted, false, '校验失败不能运行下载物')
    assert.equal(existsSync(root), false, '校验失败不能留下安装目录')
    assert.equal(readdirSync(join(root, '..')).filter((name) => name.endsWith('.download.exe')).length, 0)
  }

  /* 3. 同时只允许一次；取消会终止 */
  {
    const root = join(work, 'c', 'git')
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const first = runtime.installManagedGit({ root, pin: pin('/ok', '/ok'), extract: async (file, stage, signal) => { await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('已取消'))))]); await stubExtract(file, stage) } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await runtime.installManagedGit({ root, pin: pin('/ok', '/ok'), extract: stubExtract })
    assert.equal(second.ok, false)
    assert.match(second.error ?? '', /已经在安装中/)
    runtime.cancelGitInstall()
    const result = await first
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /已取消/)
    assert.equal(existsSync(root), false, '取消后不留安装目录')
    release()
  }

  /* 4. 对齐 PATH 不抛错（开发机上系统已有 git 时不改 PATH） */
  const before = process.env.PATH
  await runtime.refreshManagedGit(join(work, 'nonexistent'))
  assert.equal(process.env.PATH, before, '没装受管 Git 时不改 PATH')

  /* 5. 安装位置必须是纯 ASCII：中文用户名下改装到 ProgramData（pi 用 where 找 bash，中文路径会乱码） */
  assert.equal(runtime.hasNonAscii('C:/Users/zhang/x'), false)
  assert.equal(runtime.hasNonAscii('C:/Users/张三/x'), true)
  const slashes = (value) => value.split(String.fromCharCode(92)).join('/')
  assert.equal(slashes(runtime.managedGitRootFor('C:/Users/zhang/.pi/agent/yan', 'D:/PD')), 'C:/Users/zhang/.pi/agent/yan/tools/git')
  assert.equal(slashes(runtime.managedGitRootFor('C:/Users/张三/.pi/agent/yan', 'D:/PD')), 'D:/PD/Inkstone/tools/git')

  console.log('git-runtime: ok')
} finally {
  server.close()
  rmSync(work, { recursive: true, force: true })
}
