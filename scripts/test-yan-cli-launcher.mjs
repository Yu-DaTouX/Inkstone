import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { ensureYanLauncher, resolveYanCli } = await compile('src/main/yan-cli.ts')
  const { readFileSync } = await import('node:fs')
  const binDir = await mkdtemp(join(tmpdir(), 'yan-bin-'))

  ok(!!resolveYanCli({ devResourcesDir: 'resources' }), 'yan CLI：开发态能找到 resources/yan-cli/yan.mjs')

  const made = ensureYanLauncher({
    devResourcesDir: 'resources',
    execPath: 'C:/fake/electron.exe',
    binDir
  })
  ok(!!made, 'yan 启动器：能生成')
  if (made) {
    const text = readFileSync(made.launcher, 'utf8')
    ok(text.includes('ELECTRON_RUN_AS_NODE=1'), 'yan 启动器：以纯 Node 模式跑内置运行时')
    ok(text.includes('yan.mjs'), 'yan 启动器：指向随包 CLI 脚本')
    ok(text.includes('C:/fake/electron.exe'), 'yan 启动器：用的是应用自带运行时，不是用户的 node')
  }

  const missing = ensureYanLauncher({
    devResourcesDir: 'resources/does-not-exist',
    execPath: 'x',
    binDir
  })
  ok(missing === null, 'yan 启动器：找不到 CLI 时返回 null，不静默生成坏启动器')

  const { spawnSync } = await import('node:child_process')
  const syntax = spawnSync(process.execPath, ['--check', 'resources/yan-cli/yan.mjs'], { encoding: 'utf8' })
  ok(syntax.status === 0, 'yan CLI：语法可解析（node --check）', (syntax.stderr ?? '').split('\n')[0])
  const help = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', '--help'], { encoding: 'utf8' })
  ok(help.status === 0, 'yan CLI：--help 真的能跑（退出码 0）', (help.stderr ?? '').split('\n')[0])
  const capabilityHelp = spawnSync(process.execPath, ['resources/yan-cli/yan.mjs', 'capabilities', '--help'], { encoding: 'utf8' })
  ok(
    /你不能替用户批准/.test(capabilityHelp.stdout ?? '') &&
      /逐文件核对 Git 哈希/.test(capabilityHelp.stdout ?? ''),
    'yan CLI：能力接入帮助写明模型不能替用户批准，GitHub 技能固定到提交并逐文件核对哈希'
  )

  await rm(binDir, { recursive: true, force: true })
})
