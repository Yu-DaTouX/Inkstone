/**
 * PR 状态（方案 §7 的 G3）单测。
 *
 * 分两层：
 *   · **纯解析**（远端地址 → owner/repo、GitHub 的 JSON → 状态、HTTP → 分类）——
 *     这些是「状态显示错了」的全部来源，用合成数据钉住最划算。
 *   · **一次真实 API 往返** —— 匿名能不能读、404 怎么分类，只有真打一次才知道。
 *     网络不可用时**跳过并说清楚**（不假装通过）。
 */
export async function runHostingTests(ok) {
  const { splitRepo, mapPull, mapChecks, classifyHttp, prStatus } = await import('../out/test/hosting.mjs')

  /* ── 1. 远端地址 → owner/repo ────────────────────────── */
  {
    const a = splitRepo('https://github.com/o/r')
    ok(a?.owner === 'o' && a?.repo === 'r' && a?.host === 'github.com', '正常地址解析出 host/owner/repo', JSON.stringify(a))
    ok(splitRepo('https://github.com/o/r.git')?.repo === 'r', '带 .git 后缀要去掉', String(splitRepo('https://github.com/o/r.git')?.repo))
    ok(splitRepo('https://gitlab.com/group/sub/proj')?.repo === 'sub', '多级路径取前两段（GitLab 的 group 可能有多层）', JSON.stringify(splitRepo('https://gitlab.com/group/sub/proj')))
    ok(splitRepo('') === null, '空串 → null', String(splitRepo('')))
    ok(splitRepo('not a url') === null, '不是 URL → null', String(splitRepo('not a url')))
    ok(splitRepo('https://github.com/onlyowner') === null, '只有 owner 没有 repo → null', String(splitRepo('https://github.com/onlyowner')))
  }

  /* ── 2. GitHub 的 PR JSON → 我们的状态 ───────────────── */
  {
    ok(mapPull(null).state === 'none', '没有 PR → none')
    ok(mapPull({ state: 'open' }).state === 'open', 'open → open')
    ok(mapPull({ state: 'open', draft: true }).state === 'draft', '**draft 优先于 open**（草稿的 PR 也是开着的）', String(mapPull({ state: 'open', draft: true }).state))
    ok(mapPull({ state: 'closed' }).state === 'closed', 'closed → closed')
    ok(mapPull({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }).state === 'merged', '**merged_at 优先于 closed**（合并的 PR 状态也是 closed）', String(mapPull({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }).state))
    const full = mapPull({ state: 'open', title: 't', number: 7, html_url: 'u', head: { sha: 'abc' }, base: { ref: 'main' } })
    ok(full.title === 't' && full.number === 7 && full.url === 'u' && full.base === 'main' && full.headSha === 'abc', '标题/编号/链接/base/headSha 都带出来')
  }

  /* ── 3. check-runs → 三态 ───────────────────────────── */
  {
    ok(mapChecks([]) === 'none', '没有检查 → none')
    ok(mapChecks(null) === 'none', 'null → none（不抛）')
    ok(mapChecks([{ status: 'in_progress' }]) === 'pending', 'in_progress → pending')
    ok(mapChecks([{ status: 'queued' }]) === 'pending', 'queued → pending')
    ok(mapChecks([{ status: 'completed', conclusion: 'success' }]) === 'success', '全 success → success')
    ok(mapChecks([{ status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }]) === 'success', 'neutral / skipped 不算失败', String(mapChecks([{ status: 'completed', conclusion: 'neutral' }])))
    ok(mapChecks([{ status: 'completed', conclusion: 'failure' }]) === 'failure', 'failure → failure')
    ok(
      mapChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]) === 'failure',
      '**有失败就是失败**（不能因为大部分通过就显示通过）'
    )
    ok(
      mapChecks([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }]) === 'pending',
      '**还在跑就显示 pending**（不能因为已有部分通过就显示通过）'
    )
  }

  /* ── 4. HTTP → 分类 ────────────────────────────────── */
  {
    ok(classifyHttp(401, false) === 'auth', '401 → 认证')
    ok(classifyHttp(403, false) === 'auth', '403（非限流）→ 认证')
    ok(classifyHttp(403, true) === 'rate-limit', '**403 + 限流头 → 限流**（这两件事的下一步完全不同）', String(classifyHttp(403, true)))
    ok(classifyHttp(404, false) === 'not-found', '404 → 仓库不存在或没权限')
    ok(classifyHttp(500, false) === 'network', '5xx → 网络侧')
    ok(classifyHttp(0, false) === 'unknown', '0（连不上）→ unknown')
  }

  /* ── 5. 本地仓库：没有远端 → 如实说不支持（这一条**不发网络请求**）── */
  {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const root = mkdtempSync(join(tmpdir(), 'yan-hosting-'))
    const repo = join(root, 'r')
    mkdirSync(repo)
    const g = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    g(['init', '-q', '-b', 'main'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'T'])
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    g(['add', '-A'])
    g(['commit', '-q', '-m', 'init'])

    const noRemote = await prStatus(repo, null)
    ok(noRemote.ok === false && noRemote.error === 'unsupported', '没有远端 → unsupported（如实说，不发请求）', String(noRemote.error))
    ok(typeof noRemote.message === 'string' && noRemote.message.length > 0, '并带上一句人能看懂的原因', String(noRemote.message))

    /* 加一个本地 bare 远端（认不出托管站）*/
    const bare = join(root, 'bare.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' })
    g(['remote', 'add', 'origin', bare])
    const localRemote = await prStatus(repo, null)
    ok(localRemote.ok === false && localRemote.error === 'unsupported', '本地路径的远端 → unsupported（不是托管站）', String(localRemote.error))
    ok(/托管站/.test(localRemote.message ?? ''), '原因里说清「认不出托管站」', String(localRemote.message))

    rmSync(root, { recursive: true, force: true })
  }

  /* ── 6. 真实 API 往返（网络不可用时跳过，不假装通过）── */
  {
    try {
      const res = await fetch('https://api.github.com/repos/octocat/Hello-World', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yan-desktop', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(12_000)
      })
      ok(res.ok, '真实打一次 api.github.com（匿名可读公开仓库）', `HTTP ${res.status}`)
      const missing = await fetch('https://api.github.com/repos/yan-does-not-exist-xyz/nope', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yan-desktop' },
        signal: AbortSignal.timeout(12_000)
      })
      ok(classifyHttp(missing.status, false) === 'not-found', '不存在的仓库 → not-found 分类', `HTTP ${missing.status}`)
    } catch (error) {
      /* 离线环境：如实跳过。写进输出是为了让「为什么这组没跑」有据可查。 */
      console.log('  ⓘ 跳过真实 API 往返（网络不可用）：' + (error instanceof Error ? error.message : String(error)))
      ok(true, '真实 API：网络不可用，已跳过（不是通过，是没测）')
    }
  }
}
