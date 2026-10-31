import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function demoGit(cwd, args, extraEnv = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=.demo-no-hooks', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Lin Chen', GIT_AUTHOR_EMAIL: 'lin@demo.invalid', GIT_COMMITTER_NAME: 'Lin Chen', GIT_COMMITTER_EMAIL: 'lin@demo.invalid', ...extraEnv }
  })
  if (result.status !== 0) throw new Error(`demo git ${args[0]}: ${result.stderr || result.error || result.stdout}`)
  return result.stdout.trimEnd()
}

export function demoFile(dir, path, content) {
  const file = join(dir, path)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

export function createDemoRepos(runDir, { fixtureRoot = process.env.YAN_DEBUG_FIXTURES || 'E:/Inkstone/bench/Harness-test/tasks' } = {}) {
  const dir = join(runDir, 'demo')
  if (existsSync(join(dir, 'gh-state.json')) || existsSync(join(dir, 'ledger'))) throw new Error('演示目录已存在，请使用新的运行目录')
  mkdirSync(dir, { recursive: true })
  const project = join(dir, 'ledger')
  const second = join(dir, 'async-worker')
  for (const [target, task] of [[project, '40-ledger-incident'], [second, '30-async-refactor']]) {
    const source = join(fixtureRoot, task, 'fixture')
    if (!existsSync(source)) throw new Error(`缺少演示 fixture：${source}（可设置 YAN_DEBUG_FIXTURES）`)
    cpSync(source, target, { recursive: true, filter: path => !/[\\/](node_modules|\.git)([\\/]|$)/.test(path) })
    demoGit(target, ['init', '-q', '-b', 'main'])
    demoGit(target, ['config', 'user.name', 'Demo Developer'])
    demoGit(target, ['config', 'user.email', 'developer@demo.invalid'])
    demoGit(target, ['config', 'commit.gpgsign', 'false'])
    demoGit(target, ['config', 'core.autocrlf', 'false'])
  }
  let tick = 0
  const authors = [['Lin Chen', 'lin'], ['Maya Patel', 'maya'], ['Alex Morgan', 'alex']]
  function commit(cwd, message) {
    const [name, login] = authors[tick % authors.length]
    const date = new Date(Date.now() - (32 - tick++) * 8 * 3600000).toISOString()
    demoGit(cwd, ['add', '-A'])
    demoGit(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${login}@demo.invalid`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    return demoGit(cwd, ['rev-parse', 'HEAD'])
  }
  demoFile(project, '.gitignore', 'node_modules/\n.demo-no-hooks/\n')
  for (const name of ['staged', 'unstaged', 'partial', 'rename-before', 'delete-me']) demoFile(project, `demo/${name}.txt`, `${name}\noriginal entry\n`)
  demoFile(project, 'demo/chart.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  demoFile(project, 'demo/conflict.txt', 'rounding=legacy\n')
  demoFile(project, 'package.json', JSON.stringify({ ...JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')), scripts: { ...JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).scripts, 'demo:preview': 'node demo/server.mjs' } }, null, 2) + '\n')
  demoFile(project, 'demo/server.mjs', "import { createServer } from 'node:http'\ncreateServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>Ledger demo</h1><p>Local-only reconciliation preview · 128 entries · 0 missing</p>')}).listen(4179,'127.0.0.1')\n")
  commit(project, 'chore: import incident ledger with reproducible fixture')
  const topics = ['deployment checklist', 'reconciliation examples', 'rounding edge cases', 'currency fixtures', 'refund trace', 'batch import plan', 'CSV contract', 'audit log format', 'load test notes', 'release checklist', 'incident timeline', 'retry budget', 'review checklist', 'observability plan', 'recovery playbook']
  for (const [index, topic] of topics.entries()) {
    demoFile(project, `demo/history/${String(index + 1).padStart(2, '0')}.md`, `# ${topic}\n\nOwner: ${authors[index % 3][0]}\n\nReproduce with npm test. Preserve the event order and compare balances before rollout.\n`)
    commit(project, `docs: add ${topic}`)
  }
  const fork = demoGit(project, ['rev-parse', 'HEAD~3'])
  const branches = ['feature/decimal-money', 'fix/csv-header', 'feature/batch-import', 'feature/audit-log', 'fix/rounding-conflict', 'feature/docs-refresh', 'fix/retry-budget', 'feature/review-threads', 'feature/export-reports']
  const heads = []
  for (const [index, branch] of branches.entries()) {
    demoGit(project, ['switch', '-q', '-c', branch, index === 4 ? fork : 'main'])
    if (index === 4) demoFile(project, 'demo/conflict.txt', 'rounding=bankers\n')
    else if (index === 8) for (let i = 1; i <= 36; i++) demoFile(project, `demo/reports/report-${String(i).padStart(2, '0')}.csv`, `account,currency,amount\naccount-${i},CNY,${i * 17}.25\n`)
    else demoFile(project, `demo/changes/${branch.replaceAll('/', '-')}.md`, `# ${branch}\n\nExpected behavior\n- Preserve event ordering.\n- Validate empty batches.\n- Keep the command-line output stable.\n\nTest: npm test\n`)
    heads.push(commit(project, `${branch.startsWith('fix/') ? 'fix' : 'feat'}: ${branch.split('/')[1]}`))
  }
  demoGit(project, ['switch', '-q', 'main'])
  demoFile(project, 'demo/conflict.txt', 'rounding=half-up\n')
  commit(project, 'fix: document the current rounding contract')
  demoGit(project, ['merge', '--no-ff', '-m', 'Merge reviewed documentation refresh', branches[5]])
  const origin = join(dir, 'ledger-origin.git')
  demoGit(dir, ['init', '-q', '--bare', origin])
  demoGit(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const localOrigin = origin.replaceAll('\\', '/')
  demoGit(project, ['config', '--add', `url.${localOrigin}.insteadOf`, 'https://github.com/inkstone-demo/ledger.git'])
  demoGit(project, ['config', '--add', `url.${localOrigin}.insteadOf`, 'https://github.com/inkstone-demo/ledger'])
  demoGit(project, ['remote', 'add', 'origin', localOrigin])
  demoGit(project, ['push', '-q', '-u', 'origin', '--all'])
  for (let i = 0; i < heads.length; i++) demoGit(origin, ['update-ref', `refs/pull/${101 + i}/head`, heads[i]])
  const remoteWork = join(dir, 'remote-maintainer')
  demoGit(dir, ['clone', '-q', origin, remoteWork])
  demoFile(remoteWork, 'demo/remote-update.txt', 'The remote maintainer added a release note.\n')
  commit(remoteWork, 'docs: publish remote release note')
  demoGit(remoteWork, ['push', '-q', 'origin', 'main'])
  demoGit(project, ['fetch', '-q', 'origin'])
  demoFile(project, 'demo/local-update.txt', 'Local preparation awaiting push.\n')
  commit(project, 'chore: prepare local reconciliation review')
  demoGit(project, ['branch', 'feature/no-upstream'])
  demoGit(project, ['branch', 'fix/maintenance'])
  const worktree = join(dir, 'maintenance-worktree')
  demoGit(project, ['worktree', 'add', '-q', worktree, 'fix/maintenance'])
  demoFile(project, 'demo/staged.txt', 'staged\nvalidated entry\n')
  demoFile(project, 'demo/partial.txt', 'partial\nstaged correction\n')
  demoGit(project, ['add', 'demo/staged.txt', 'demo/partial.txt'])
  demoFile(project, 'demo/partial.txt', 'partial\nstaged correction\nunstaged follow-up\n')
  demoFile(project, 'demo/unstaged.txt', 'unstaged\nlocal draft\n')
  demoGit(project, ['mv', 'demo/rename-before.txt', 'demo/renamed.txt'])
  demoGit(project, ['rm', '-q', 'demo/delete-me.txt'])
  demoFile(project, 'demo/chart.bin', Buffer.from([0, 9, 8, 7, 0, 128]))
  demoFile(project, 'demo/untracked.md', '# Investigation scratchpad\nNot staged yet.\n')
  commit(second, 'chore: import async worker fixture')
  demoFile(second, 'demo-notes.md', '# Async worker\n\nCompare cancellation, retries and queue ordering.\n')
  commit(second, 'docs: add refactoring acceptance notes')
  demoFile(second, 'demo-notes.md', '# Async worker\n\nCompare cancellation, retries and queue ordering.\n\nTry an aborted request.\n')
  return { dir, project, second, projects: [project, second], origin, worktree, branches, heads, stateFile: join(dir, 'gh-state.json') }
}
