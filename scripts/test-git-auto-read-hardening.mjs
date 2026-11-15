import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gitInspectArgs, gitInspectEnv, GIT_INSPECT_TOOL } = await import('../resources/pi-extensions/readonly-tools.js')
  const policy = await compile('src/main/git-run-policy.ts')
  const service = await compile('src/main/git-service.ts')
  const isolation = await compile('src/main/session-isolation.ts', { external: ['electron'] })
  const stubbedIsolation = await compile('src/main/session-isolation.ts', {
    external: ['electron'],
    plugins: [{
      name: 'git-service-stub',
      setup(build) {
        build.onResolve({ filter: /[\\/]git-service$|^\.\/git-service$/ }, () => ({ path: 'git-service', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: [
            '',
            'export async function readStatus(root, options) { (globalThis.__readStatusCalls ??= []).push(options); return { entries: [] } }',
            "export async function gitRun() { return { ok: true, stdout: '0', stderr: '' } }",
            'export async function gitReadBytes() { return { ok: false, error: "stub" } }',
            'export async function refExists() { return false }',
            'export async function resolveRepo() { return null }'
          ].join('\n')
        }))
      }
    }]
  })

  const root = mkdtempSync(join(tmpdir(), 'yan-git-hardening-'))
  const slash = (path) => path.replace(/\\/g, '/')
  const marker = join(root, 'marker.txt')
  const hookFile = join(root, 'hook.sh')
  writeFileSync(hookFile, `#!/bin/sh\necho ran >> "${slash(marker)}"\ncat\n`)
  const hook = `sh "${slash(hookFile)}"`
  writeFileSync(join(root, 'empty.gitconfig'), '')
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: slash(join(root, 'empty.gitconfig')) }
  const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=yan-tests@example.invalid', '-c', 'user.name=Yan tests', '-c', 'core.autocrlf=false', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  let bump = 0
  const touch = (file) => {
    bump += 1
    const later = new Date(Date.now() + 60_000 * bump)
    utimesSync(file, later, later)
  }
  const reset = () => rmSync(marker, { force: true })
  const ran = () => existsSync(marker)
  const runInspectOut = (cwd, action, args) => {
    const built = gitInspectArgs(action, args)
    if (built.error) return { code: -1, stdout: '', error: built.error }
    try {
      const stdout = execFileSync('git', built.argv, { cwd, env: { ...gitInspectEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      return { code: 0, stdout }
    } catch (error) {
      return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  }
  const runInspect = (cwd, action, args) => {
    const built = gitInspectArgs(action, args)
    if (built.error) return { rejected: true }
    try {
      execFileSync('git', built.argv, { cwd, env: { ...gitInspectEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL }, stdio: 'ignore' })
    } catch {
    }
    return { rejected: false }
  }

  try {
    const src = join(root, 'sub-src')
    mkdirSync(src)
    gitIn(src, 'init', '-q')
    writeFileSync(join(src, 'a.txt'), 'x\n')
    writeFileSync(join(src, '.gitattributes'), '* filter=evil\n')
    gitIn(src, 'add', '.')
    gitIn(src, 'commit', '-qm', 'sub')
    const main = join(root, 'main')
    mkdirSync(main)
    gitIn(main, 'init', '-q')
    gitIn(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    gitIn(main, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', slash(src), 'sub')
    gitIn(main, 'commit', '-qm', 'add sub')
    gitIn(join(main, 'sub'), 'config', 'filter.evil.clean', hook)

    for (const args of [['--no-ignore-submodules'], ['--ignore-sub=none'], ['--ignore-submodules=none'], ['--no-ignore-sub'], ['--', 'sub']]) {
      reset()
      touch(join(main, 'sub', 'a.txt'))
      const result = runInspect(main, 'status', args)
      ok(!ran(), `git_inspect status ${args.join(' ')} 不执行子模块过滤器`, result.rejected ? 'rejected' : 'ran git')
    }
    for (const args of [['--no-ignore-submodules'], ['--ignore-sub=none'], ['--no-ignore-sub']]) {
      ok(!!gitInspectArgs('status', args).error, `名称层面拒绝 ${args[0]}`)
    }
    const tail = gitInspectArgs('status', ['-s', '--', 'sub']).argv
    const sep = tail.indexOf('--')
    ok(tail.lastIndexOf('--ignore-submodules=dirty') > tail.indexOf('-s') && tail.lastIndexOf('--ignore-submodules=dirty') < sep, '用户参数之后、-- 之前再追加一次子模块保护', JSON.stringify(tail))
    const diffTail = gitInspectArgs('diff', ['HEAD', '--', 'sub']).argv
    const diffSep = diffTail.indexOf('--')
    ok(diffTail.lastIndexOf('--submodule=short') > diffTail.indexOf('HEAD') && diffTail.lastIndexOf('--ignore-submodules=dirty') < diffSep && diffTail.lastIndexOf('--ignore-submodules=dirty') > diffTail.indexOf('HEAD'), 'diff 有 -- 时在 -- 之前追加子模块保护', JSON.stringify(diffTail))
    const diffPlain = gitInspectArgs('diff', ['HEAD', 'sub']).argv
    ok(diffPlain.indexOf('--ignore-submodules=dirty') < diffPlain.indexOf('HEAD') && diffPlain.lastIndexOf('--ignore-submodules=dirty') < diffPlain.indexOf('HEAD'), 'diff 没有 -- 时只在用户参数前放保护，不破坏路径参数', JSON.stringify(diffPlain))
    reset()
    touch(join(main, 'sub', 'a.txt'))
    runInspect(main, 'diff', ['HEAD', 'sub'])
    ok(!ran(), 'diff 不带 -- 的子模块路径也不执行子模块过滤器')

    const signed = join(root, 'signed')
    mkdirSync(signed)
    gitIn(signed, 'init', '-q')
    writeFileSync(join(signed, 'a.txt'), 'x\n')
    gitIn(signed, 'add', '.')
    gitIn(signed, 'commit', '-qm', 'base')
    const tree = gitIn(signed, 'rev-parse', 'HEAD^{tree}').trim()
    const body = `tree ${tree}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`
    writeFileSync(join(root, 'commit.txt'), body)
    const sha = gitIn(signed, 'hash-object', '-t', 'commit', '-w', slash(join(root, 'commit.txt'))).trim()
    gitIn(signed, 'update-ref', 'refs/heads/signed', sha)
    gitIn(signed, 'config', 'gpg.program', slash(hookFile))
    gitIn(signed, 'config', 'pretty.sig', 'format:%G?')
    reset()
    execFileSync('git', ['log', '-1', '--format=%G?', 'signed'], { cwd: signed, env, stdio: 'ignore' })
    ok(ran(), '前提：%G? 会调用仓库配置的 gpg.program')
    for (const [action, args] of [
      ['log', ['-1', '--format=%G?', 'signed']],
      ['log', ['-1', '--pretty=format:%GS', 'signed']],
      ['log', ['-1', '--show-signature', 'signed']],
      ['show', ['-s', '--format=%GK', 'signed']],
      ['log', ['-1', '--pretty=sig', 'signed']],
      ['log', ['-1', '--format=sig', 'signed']],
      ['log', ['-1', '--format=%+G?', 'signed']],
      ['log', ['-1', '--format=%-GS', 'signed']],
      ['log', ['-1', '--format=% GK', 'signed']],
      ['show', ['-s', '--pretty=tformat:%h%+GG', 'signed']],
      ['log', ['-1', 'signed']]
    ]) {
      reset()
      const result = runInspect(signed, action, args)
      ok(!ran(), `git_inspect ${action} ${args.join(' ')} 不调用 gpg.program`, result.rejected ? 'rejected' : 'ran git')
    }
    gitIn(signed, 'config', 'format.pretty', 'format:%G?')
    reset()
    runInspect(signed, 'log', ['-1', 'signed'])
    ok(!ran(), '仓库配置 format.pretty 带 %G 也不调用 gpg.program')
    ok(!gitInspectArgs('log', ['--oneline', '-5']).error && !gitInspectArgs('log', ['--format=%h %s']).error && !gitInspectArgs('log', ['--pretty=fuller']).error, '普通格式参数仍可用')
    reset()
    const literal = runInspectOut(signed, 'log', ['-1', '--format=%%G? %h', 'signed'])
    ok(literal.code === 0 && literal.stdout.startsWith('%G? ') && !ran(), '%%G 是字面量，照常可用且不调用 gpg', JSON.stringify(literal))

    for (const [action, args, expect] of [
      ['log', ['-5', 'a.txt'], /base/],
      ['log', ['--oneline', '--follow', 'a.txt'], /base/],
      ['diff', ['HEAD', 'a.txt'], /^$/],
      ['diff', ['--stat', 'HEAD~0', 'a.txt'], /^$/],
      ['show', ['--stat', 'HEAD', 'a.txt'], /base/],
      ['log', ['-1', '--', 'a.txt'], /base/],
      ['status', ['--short', 'a.txt'], /^$/],
      ['blame', ['a.txt'], /x/]
    ]) {
      const result = runInspectOut(signed, action, args)
      ok(result.code === 0 && expect.test(result.stdout), `不带 -- 的路径参数照常输出：${action} ${args.join(' ')}`, JSON.stringify(result))
    }

    for (const [action, args] of [
      ['status', ['--', '//attacker.invalid/s']],
      ['log', ['//attacker.invalid/s/x']],
      ['diff', ['HEAD', '--', '\\\\attacker.invalid\\s\\a']],
      ['blame', ['--ignore-revs-file=//attacker.invalid/s/r', 'a.txt']],
      ['blame', ['--ignore-revs-file', '\\\\attacker.invalid\\s\\r', 'a.txt']],
      ['log', ['--', '/??/UNC/attacker.invalid/s']]
    ]) {
      ok(!!gitInspectArgs(action, args).error, `git_inspect 拒绝网络路径参数：${action} ${args.join(' ')}`)
    }
    ok(!gitInspectArgs('log', ['--', '\\\\?\\C:\\a.txt']).error, 'git_inspect 不拦本地长路径')

    const proj = join(root, 'proj')
    mkdirSync(join(proj, 'src'), { recursive: true })
    gitIn(proj, 'init', '-q', '-b', 'main')
    writeFileSync(join(proj, 'src', 'a.ts'), 'one\n')
    gitIn(proj, 'add', '.')
    gitIn(proj, 'commit', '-qm', 'one')
    writeFileSync(join(proj, 'src', 'a.ts'), 'one\ntwo\n')
    gitIn(proj, 'commit', '-qam', 'two')
    writeFileSync(join(proj, 'src', 'a.ts'), 'one\ntwo\nthree\n')
    const secret = join(root, 'auth.json')
    writeFileSync(secret, '{"token":"TOP-SECRET-VALUE"}\n')
    const plain = mkdtempSync(join(tmpdir(), 'yan-git-plain-'))
    writeFileSync(join(plain, 'y.txt'), 'y\n')
    const leaked = (result) => JSON.stringify(result).includes('TOP-SECRET-VALUE')
    const raw = (() => { try { return execFileSync('git', ['--no-pager', 'diff', slash(secret), 'src/a.ts'], { cwd: proj, env }).toString() } catch (error) { return String(error.stdout ?? '') } })()
    ok(raw.includes('TOP-SECRET-VALUE'), '前提：不加 --no-index 时 git diff 也会读出仓库外的文件')
    const call = (cwd, action, args) => GIT_INSPECT_TOOL.execute('t', { action, args }, undefined, undefined, { cwd })
    try {
      for (const [cwd, args, label] of [
        [proj, [slash(secret), 'src/a.ts'], '仓库外绝对路径'],
        [proj, [secret, 'src/a.ts'], '仓库外绝对路径（反斜杠）'],
        [proj, ['--', slash(secret), 'src/a.ts'], '-- 之后的仓库外绝对路径'],
        [join(proj, 'src'), ['../../auth.json', 'a.ts'], '../ 跳出仓库'],
        [proj, ['--', '..\\auth.json', 'src/a.ts'], '..\\ 跳出仓库'],
        [proj, ['C:auth.json', 'src/a.ts'], '盘符相对路径'],
        [plain, ['--', slash(secret), 'y.txt'], '非仓库目录带 --'],
        [plain, ['--', 'y.txt', 'y.txt'], '非仓库目录里的相对路径']
      ]) {
        const result = await call(cwd, 'diff', args)
        ok(result.isError && !leaked(result), `git_inspect diff 拒绝${label}且不读文件`, JSON.stringify(result).slice(0, 300))
      }
      for (const [args, expect] of [
        [['HEAD~1..HEAD'], /\+two/],
        [['main...HEAD', '--stat'], /no output|^$/],
        [['HEAD', 'src/a.ts'], /\+three/],
        [['HEAD~1', '--', 'src/a.ts'], /\+two/],
        [['--stat'], /src\/a\.ts/]
      ]) {
        const result = await call(proj, 'diff', args)
        const output = result.content[0].text
        ok(!result.isError && expect.test(output), `git_inspect diff ${args.join(' ')} 照常输出`, output.slice(0, 200))
      }
      for (const [action, args] of [['blame', ['-S', slash(secret), 'src/a.ts']], ['blame', ['-wS' + slash(secret), 'src/a.ts']], ['blame', ['--ignore-revs-file', slash(secret), 'src/a.ts']], ['blame', ['--ignore-revs-f=' + slash(secret), 'src/a.ts']]]) {
        const result = await call(proj, action, args)
        ok(result.isError && !leaked(result), `git_inspect 拒绝 ${action} ${args[0].slice(0, 20)} 读仓库外文件`, JSON.stringify(result).slice(0, 300))
      }
      for (const [action, args] of [['log', ['-1', '--', '../auth.json']], ['show', ['HEAD:../auth.json']], ['log', ['-1', '-L', '1,1:../auth.json']]]) {
        const result = await call(proj, action, args)
        ok(!leaked(result), `git_inspect ${action} ${args.join(' ')} 读不到仓库外文件`, JSON.stringify(result).slice(0, 300))
      }
      const blamed = await call(proj, 'blame', ['-w', 'src/a.ts'])
      ok(!blamed.isError && /one/.test(blamed.content[0].text), 'blame 照常可用')
      const picked = await call(proj, 'log', ['-SOne', '--oneline'])
      ok(!picked.isError, '-S 后面的搜索串含 O 不误拦', JSON.stringify(picked).slice(0, 200))
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }

    for (const [action, args] of [
      ['diff', ['-sO//attacker.invalid/s/x']],
      ['log', ['-pO\\\\attacker.invalid\\s\\x']],
      ['show', ['-sO', 'C:/x']],
      ['blame', ['-wS//attacker.invalid/s/x', 'a.txt']],
      ['blame', ['-wfS', 'C:/x', 'a.txt']],
      ['status', ['--', '::\\\\attacker.invalid\\s\\x']],
      ['status', ['--', ':/://attacker.invalid/s']],
      ['log', ['--', ':(top)://attacker.invalid/s']]
    ]) {
      ok(!!gitInspectArgs(action, args).error, `git_inspect 拒绝 ${action} ${args.join(' ')}`)
    }

    for (const [action, args] of [['diff', ['--no-index', 'C:/Windows/win.ini', 'a.txt']], ['blame', ['--contents', '//attacker/s/a', '--', 'a.txt']], ['blame', ['--contents=C:/x', 'a.txt']], ['blame', ['--cont', 'C:/x', 'a.txt']]]) {
      ok(!!gitInspectArgs(action, args).error, `git_inspect 拒绝 ${action} ${args[0]}`)
    }

    const readEnv = policy.readOnlyGitEnv(['status'])
    ok(readEnv.GIT_NO_LAZY_FETCH === '1' && /^file:git:http:https:ssh$/.test(readEnv.GIT_ALLOW_PROTOCOL ?? ''), '自动只读 git 禁止懒拉取并限定协议', JSON.stringify(readEnv))
    for (const write of [['fetch'], ['pull'], ['clone', 'x'], ['checkout', 'main'], ['push']]) {
      const writeEnv = policy.readOnlyGitEnv(write)
      ok(writeEnv.GIT_NO_LAZY_FETCH === undefined && writeEnv.GIT_ALLOW_PROTOCOL === undefined, `用户操作 ${write[0]} 不受影响`)
    }
    const inspectEnv = gitInspectEnv({ PATH: 'x', GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'ext' })
    ok(inspectEnv.GIT_NO_LAZY_FETCH === '1' && inspectEnv.GIT_ALLOW_PROTOCOL === 'file:git:http:https:ssh', 'git_inspect 同样禁止懒拉取并限定协议', JSON.stringify(inspectEnv))

    const origin = join(root, 'origin')
    mkdirSync(origin)
    gitIn(origin, 'init', '-q')
    gitIn(origin, 'config', 'uploadpack.allowFilter', 'true')
    writeFileSync(join(origin, 'a.txt'), 'old\n')
    gitIn(origin, 'add', '.')
    gitIn(origin, 'commit', '-qm', 'one')
    writeFileSync(join(origin, 'a.txt'), 'new\n')
    gitIn(origin, 'commit', '-qam', 'two')
    gitIn(root, 'clone', '-q', '--filter=blob:none', `file://${slash(origin)}`, 'partial')
    const partial = join(root, 'partial')
    const lazy = await service.gitRun(partial, ['show', 'HEAD~1:a.txt'], { allowFailure: true })
    ok(!lazy.ok, '自动读取不会为部分克隆懒拉取缺失对象', lazy.stdout)
    const blob = gitIn(partial, 'show', 'HEAD:a.txt')
    ok(blob === 'new\n', '已有对象照常读取')

    const iso = join(root, 'iso')
    mkdirSync(iso)
    gitIn(iso, 'init', '-q')
    writeFileSync(join(iso, 'a.txt'), 'x\n')
    writeFileSync(join(iso, '.gitattributes'), '* filter=evil\n')
    gitIn(iso, 'add', '.')
    gitIn(iso, 'commit', '-qm', 'base')
    gitIn(iso, 'branch', 'iso-branch')
    gitIn(iso, 'config', 'filter.evil.clean', hook)
    const record = { worktree: iso, repoRoot: iso, mainCwd: iso, branch: 'iso-branch', baseBranch: 'iso-branch', sessionId: 's', createdAt: 1 }
    reset()
    touch(join(iso, 'a.txt'))
    const pending = await isolation.pendingIsolationChanges(record)
    ok(!ran(), '隔离工作树改动统计不执行仓库 filter', JSON.stringify(pending))
    ok(pending.ok && pending.files === 0, '干净的隔离工作树统计为 0 个改动', JSON.stringify(pending))
    writeFileSync(join(iso, 'b.txt'), 'new\n')
    reset()
    const dirty = await isolation.pendingIsolationChanges(record)
    ok(!ran() && dirty.ok && dirty.files === 1, '有新文件时照常计数', JSON.stringify(dirty))
    rmSync(join(iso, 'b.txt'))
    reset()
    touch(join(iso, 'a.txt'))
    const kept = await isolation.discardUnusedIsolation({ ...record, worktree: join(root, 'missing-worktree') })
    ok(kept === true, '工作树已不在时仍正常清理记录')
    touch(join(iso, 'a.txt'))
    await isolation.discardUnusedIsolation({ ...record, repoRoot: join(root, 'not-a-repo') })
    ok(!ran(), '清理未使用的隔离工作树不执行仓库 filter')

    globalThis.__readStatusCalls = []
    await stubbedIsolation.pendingIsolationChanges(record)
    await stubbedIsolation.discardUnusedIsolation(record)
    const timeouts = globalThis.__readStatusCalls.map((options) => options?.timeout)
    ok(timeouts.length === 2 && timeouts.every((timeout) => timeout === 30_000), '隔离工作树状态读取保持 30 秒超时', JSON.stringify(timeouts))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, { isolate: true })
