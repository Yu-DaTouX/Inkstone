import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  GIT_INSPECT_TOOL,
  gitInspectArgs,
  gitInspectEnv,
  gitFilterOverrides
} = await import('../resources/pi-extensions/readonly-tools.js')

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const built = gitInspectArgs('show', ['HEAD'])
ok(!built.error && built.argv.includes('--no-textconv') && built.argv.includes('--no-ext-diff'), '只读 git 检查禁用 textconv 与外部 diff', JSON.stringify(built.argv))
for (const blocked of ['--output=x', '--ext-diff', '--textconv', '--config-env=A=B', '--git-dir', '--work-tree', '--upload-pack=x', '-p']) {
  ok(!!gitInspectArgs('show', [blocked]).error, `拒绝会执行外部程序的参数：${blocked}`)
}
ok(!gitInspectArgs('diff', ['HEAD~1', '--', 'src/a.ts']).error, '路径参数仍可用', JSON.stringify(gitInspectArgs('diff', ['HEAD~1', '--', 'src/a.ts'])))
ok(!gitInspectArgs('blame', ['--', 'a.ts']).error, 'blame 允许路径参数')

const env = gitInspectEnv({ PATH: 'x', GIT_DIR: 'evil', GIT_INDEX_FILE: 'evil', GIT_WORK_TREE: 'evil', GIT_CONFIG_GLOBAL: 'C:/g', GIT_SSH_COMMAND: 'ssh', GIT_OPTIONAL_LOCKS: '1' })
ok(env.GIT_DIR === undefined && env.GIT_INDEX_FILE === undefined && env.GIT_WORK_TREE === undefined, '检查用的 git 不继承指向其他仓库的 GIT_*', JSON.stringify(env))
ok(env.GIT_CONFIG_GLOBAL === 'C:/g' && env.GIT_SSH_COMMAND === 'ssh', '保留用户全局配置与 SSH 设置', JSON.stringify(env))
ok(env.GIT_EXTERNAL_DIFF === '' && env.GIT_TERMINAL_PROMPT === '0', '禁用外部 diff、不弹交互提示', JSON.stringify(env))
ok(env.PATH === 'x', '保留普通环境变量')

const overrides = gitFilterOverrides('filter.lfs.clean\0filter.lfs.smudge\0filter.lfs.process\0filter.odd=name.clean\0filter.other.required\0')
ok(overrides.some(([key, value]) => key === 'filter.lfs.clean' && value === ''), '清空 filter 驱动（不执行仓库自定义过滤命令）', JSON.stringify(overrides))
ok(overrides.some(([key, value]) => key === 'filter.odd=name.smudge' && value === ''), '名字里带 = 的过滤器也覆盖', JSON.stringify(overrides))
ok(gitFilterOverrides('user.name\0core.fsmonitor').length === 0, '无关配置不生成覆盖项')

const root = await mkdtemp(join(tmpdir(), 'yan-readonly-git-'))
const repo = join(root, 'repo')
const textconvMarker = join(root, 'textconv-ran.log')
const filterMarker = join(root, 'filter-ran.log')
const posix = (path) => path.replace(/\\/g, '/')
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

try {
  await mkdir(repo, { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.name', 'Inkstone Test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'diff.probe.textconv', `sh -c 'cat; echo textconv >> "${posix(textconvMarker)}"'`])
  git(['config', 'filter.probe.clean', `sh -c 'cat; echo clean >> "${posix(filterMarker)}"'`])
  git(['config', 'filter.probe.smudge', `sh -c 'cat; echo smudge >> "${posix(filterMarker)}"'`])
  await writeFile(join(repo, '.gitattributes'), '*.txt diff=probe filter=probe\n', 'utf8')
  await writeFile(join(repo, 'note.txt'), 'hello driver\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  await rm(textconvMarker, { force: true })
  await rm(filterMarker, { force: true })

  execFileSync('git', ['show', '--textconv', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true })
  ok(existsSync(textconvMarker), '夹具：普通 git show --textconv 会执行仓库里的 textconv 程序')
  await rm(textconvMarker, { force: true })
  await rm(filterMarker, { force: true })

  const result = await GIT_INSPECT_TOOL.execute('call-1', { action: 'show', args: ['HEAD'] }, undefined, undefined, { cwd: repo })
  const output = typeof result === 'string' ? result : JSON.stringify(result)
  ok(/hello driver/.test(output), '只读工具仍能读到提交内容', output.slice(0, 200))
  ok(!existsSync(textconvMarker), '只读工具不执行仓库配置的 textconv 程序', existsSync(textconvMarker) ? await readFile(textconvMarker, 'utf8') : '')
  ok(!existsSync(filterMarker), '只读工具不执行仓库配置的过滤器', existsSync(filterMarker) ? await readFile(filterMarker, 'utf8') : '')
  ok(!/isError":true/.test(output), '检查本身没有报错', output.slice(0, 200))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`readonly-git-inspect: ${checks} checks passed`)
