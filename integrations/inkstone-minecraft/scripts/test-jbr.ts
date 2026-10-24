import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadJbr, jbrPlatform, pickJbrPackage } from '../src/core/dev/jbr-download.ts'

const root = mkdtempSync(join(tmpdir(), 'inkstone-jbr-'))
let passed = 0

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run()
  passed++
  console.log(`  ✓ ${name}`)
}

function link(version: string, build: string, platform = 'windows-x64'): string {
  const base = 'https://cache-redirector.jetbrains.com/intellij-jbr'
  return [
    `| ${platform} | **JBR (vanilla, bundled by default)** | [jbr-${version}-${platform}-${build}.tar.gz](${base}/jbr-${version}-${platform}-${build}.tar.gz) | [checksum](${base}/jbr-${version}-${platform}-${build}.tar.gz.checksum) |`,
    `| ${platform} | JBR with JCEF | [jbr_jcef-${version}-${platform}-${build}.tar.gz](${base}/jbr_jcef-${version}-${platform}-${build}.tar.gz) | |`
  ].join('\n')
}

const releases = [
  { body: link('25.0.4.1', 'b508.40') },
  { body: link('25.0.4.1', 'b635.78') },
  { body: link('25.0.3', 'b700.1') },
  { body: link('21.0.11', 'b1163.116') },
  { body: link('25.0.9', 'b1.1'), prerelease: true },
  { body: link('25.0.5', 'b1.1', 'linux-x64') }
]

try {
  await test('挑选最新稳定版、本平台、不带 JCEF 的 JBR', () => {
    assert.equal(pickJbrPackage(releases, 25, 'windows-x64')?.url, 'https://cache-redirector.jetbrains.com/intellij-jbr/jbr-25.0.4.1-windows-x64-b635.78.tar.gz')
    assert.equal(pickJbrPackage(releases, 25, 'windows-x64')?.checksumUrl, 'https://cache-redirector.jetbrains.com/intellij-jbr/jbr-25.0.4.1-windows-x64-b635.78.tar.gz.checksum')
    assert.equal(pickJbrPackage(releases, 21, 'windows-x64')?.version, '21.0.11')
    assert.equal(pickJbrPackage(releases, 25, 'linux-x64')?.version, '25.0.5')
    assert.equal(pickJbrPackage(releases, 17, 'windows-x64'), null)
    assert.equal(pickJbrPackage({ message: 'rate limited' }, 25), null)
    assert.equal(jbrPlatform('win32', 'x64'), 'windows-x64')
    assert.equal(jbrPlatform('darwin', 'arm64'), 'osx-aarch64')
  })

  if (process.platform === 'win32') {
    const top = 'jbr-25.0.4.1-windows-x64-b635.78'
    const fixture = join(root, 'fixture')
    await mkdir(join(fixture, top, 'bin'), { recursive: true })
    await writeFile(join(fixture, top, 'bin', 'java.exe'), 'fake')
    const archive = join(root, 'jbr.tar.gz')
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-czf', archive, '-C', fixture, top])
    const bytes = readFileSync(archive)
    const digest = createHash('sha512').update(bytes).digest('hex')
    let downloads = 0
    const fakeFetch = (checksum: string): typeof fetch => (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(releases), { status: 200 })
      if (url.endsWith('.checksum')) return new Response(`${checksum}  ${top}.tar.gz\n`, { status: 200 })
      downloads++
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    }) as typeof fetch

    await test('下载、校验 sha512、解压到 runtimes 并复用已装版本', async () => {
      const runtimes = join(root, 'runtimes')
      const logs: string[] = []
      const java = await downloadJbr(25, runtimes, (line) => logs.push(line), fakeFetch(digest))
      assert.equal(java, join(runtimes, 'jbr-25.0.4.1-b635.78', 'bin', 'java.exe'))
      assert.ok(existsSync(java))
      assert.deepEqual(readdirSync(runtimes), ['jbr-25.0.4.1-b635.78'])
      assert.ok(logs.some((line) => line.includes('已安装')))
      assert.equal(await downloadJbr(25, runtimes, () => undefined, fakeFetch(digest)), java)
      assert.equal(downloads, 1)
    })

    await test('同时发起的下载只跑一次', async () => {
      const runtimes = join(root, 'runtimes-concurrent')
      const before = downloads
      const [a, b] = await Promise.all([downloadJbr(25, runtimes, () => undefined, fakeFetch(digest)), downloadJbr(25, runtimes, () => undefined, fakeFetch(digest))])
      assert.equal(a, b)
      assert.equal(downloads - before, 1)
    })

    await test('校验不一致时拒绝并清掉临时文件', async () => {
      const runtimes = join(root, 'runtimes-bad')
      await assert.rejects(downloadJbr(25, runtimes, () => undefined, fakeFetch('0'.repeat(128))), /校验失败/)
      assert.deepEqual(readdirSync(runtimes), [])
    })

    await test('发布列表读取失败时说明原因', async () => {
      const failing = (async () => new Response('limited', { status: 403 })) as typeof fetch
      await assert.rejects(downloadJbr(25, join(root, 'runtimes-403'), () => undefined, failing), /HTTP 403/)
    })
  }

  console.log(`✓ ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
