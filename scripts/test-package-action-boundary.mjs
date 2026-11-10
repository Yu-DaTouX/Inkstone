import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-package-action-'))
const originalEnv = { ...process.env }
let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const built = await build({
  entryPoints: ['src/main/packages.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})

try {
  process.env.YAN_DATA_DIR = join(root, 'data')
  process.env.YAN_PI_DIR = join(root, 'pi')
  const project = join(root, 'project')
  const otherProject = join(root, 'other-project')
  const log = join(root, 'pi-calls.jsonl')
  const fakePi = join(root, 'fake-pi.mjs')
  await mkdir(project, { recursive: true })
  await mkdir(otherProject, { recursive: true })
  await writeFile(
    fakePi,
    "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ignoreScripts: process.env.npm_config_ignore_scripts ?? null }) + '\\n')\n",
    'utf8'
  )
  process.env.FAKE_PI_LOG = log
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const { configurePackageContext, runPackageAction } = mod
  configurePackageContext({
    bin: () => fakePi,
    agentDir: () => join(root, 'pi'),
    hasRunningTask: () => false,
    isProjectTrusted: async () => true,
    isKnownProject: (cwd) => cwd === project
  })
  const calls = async () => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const lastCall = async () => (await calls()).at(-1)

  {
    const result = await runPackageAction({ kind: 'install', source: 'npm:@scope/pkg', cwd: project })
    ok(result.ok, '全局安装执行成功', result.error)
    const call = await lastCall()
    ok(call.argv.join(' ') === 'install npm:@scope/pkg', '全局安装不传 -l', JSON.stringify(call.argv))
    ok(call.cwd === join(root, 'data', 'tmp', 'package-ops'), '全局安装不在项目目录里执行', call.cwd)
    ok(call.ignoreScripts === 'true', '全局安装默认不运行包安装脚本', String(call.ignoreScripts))
  }

  {
    const result = await runPackageAction({ kind: 'install', source: 'npm:@scope/pkg', cwd: project, allowLifecycleScripts: true })
    ok(result.ok, '显式允许脚本时安装执行成功', result.error)
    const call = await lastCall()
    ok(call.ignoreScripts === 'false', '用户确认后才允许安装脚本', String(call.ignoreScripts))
  }

  {
    const result = await runPackageAction({ kind: 'install', source: 'npm:@scope/pkg', cwd: project, local: true })
    ok(result.ok, '项目级安装执行成功', result.error)
    const call = await lastCall()
    ok(call.argv.join(' ') === 'install -l npm:@scope/pkg', '项目级安装使用 -l', JSON.stringify(call.argv))
    ok(call.cwd === project, '项目级安装在项目目录里执行', call.cwd)
    ok(call.ignoreScripts === 'true', '项目级安装默认不运行安装脚本', String(call.ignoreScripts))
  }

  {
    const before = (await calls()).length
    const result = await runPackageAction({ kind: 'install', source: 'npm:@scope/pkg', cwd: otherProject, local: true })
    ok(!result.ok && /不是当前打开的项目/.test(result.error ?? ''), '未打开的项目拒绝项目级安装', result.error)
    ok((await calls()).length === before, '被拒绝的项目级安装不调用 pi')
  }

  {
    const result = await runPackageAction({ kind: 'remove', source: 'npm:@scope/pkg', cwd: '', local: false })
    ok(result.ok, '全局卸载执行成功', result.error)
    const call = await lastCall()
    ok(call.cwd === join(root, 'data', 'tmp', 'package-ops'), '全局卸载同样在安全目录执行', call.cwd)
    ok(call.ignoreScripts === null, '卸载不额外改写脚本策略变量', String(call.ignoreScripts))
  }

  {
    const result = await runPackageAction({ kind: 'install', source: '--no-approve', cwd: project })
    ok(!result.ok, '以 - 开头的来源仍被拒绝')
  }

  console.log(`package-action-boundary: ${checks} assertions passed (fake pi runner, temp dirs)`)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
}
