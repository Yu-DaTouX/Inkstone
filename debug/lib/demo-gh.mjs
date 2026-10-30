import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { demoGit } from './demo-repos.mjs'

const stateFile = process.env.YAN_DEBUG_GH_STATE
const args = process.argv.slice(2)
const flag = name => { const exact = args.indexOf(name); return exact >= 0 ? args[exact + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) }
const flags = name => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : [])
const has = name => args.includes(name)
const body = () => has('--input') || flag('--body-file') === '-' ? readFileSync(0, 'utf8') : flag('--body') ?? ''
const fail = message => { throw new Error(message) }
const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return !rel.startsWith('..') && !isAbsolute(rel) }
let locked = false
let lock
try {
  if (!stateFile || !isAbsolute(stateFile)) fail('demo gh requires an absolute YAN_DEBUG_GH_STATE')
  const dir = dirname(stateFile)
  if (!inside(dir, process.cwd())) fail('HTTP 403: demo gh only operates inside this demo directory')
  lock = `${stateFile}.lock`
  const until = Date.now() + 10000
  while (!locked) {
    try { mkdirSync(lock); locked = true } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= until) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  const s = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (s.version !== 1 || !isAbsolute(s.repo.origin) || !inside(dir, s.repo.origin) || !inside(dir, s.repo.project)) fail('Invalid demo state or non-local origin')
  const operation = args[0] === 'api' ? `api.${flag('--method') ?? 'GET'}` : args.slice(0, 2).join('.')
  const injected = process.env.YAN_DEBUG_GH_FAILURE || ''
  const [only, mode] = injected.includes(':') ? injected.split(':') : ['', injected]
  if (!only || operation === only) {
    if (mode === 'auth') fail('HTTP 401: not logged in; gh auth login')
    if (mode === 'forbidden') fail('HTTP 403: permission denied by demo policy')
    if (mode === 'timeout') fail('context deadline exceeded: demo timeout')
  }
  const now = () => new Date().toISOString()
  const git = (...a) => demoGit(s.repo.origin, a)
  const next = () => s.nextId++
  const touch = pr => { pr.updatedAt = now() }
  const find = number => s.prs.find(p => p.number === Number(number)) ?? fail('HTTP 404: pull request not found')
  const projectFields = value => {
    const fields = flag('--json')?.split(',')
    return fields ? Object.fromEntries(fields.map(f => [f, value[f] ?? null])) : value
  }
  function refresh(pr) {
    if (pr.state !== 'OPEN') return
    let sha
    try { sha = git('rev-parse', `refs/heads/${pr.headRefName}`) } catch { return }
    pr.headOid = pr.headRefOid = sha
    git('update-ref', `refs/pull/${pr.number}/head`, sha)
    pr.files = git('diff', '--numstat', pr.baseOid, sha).split('\n').filter(Boolean).map(line => { const [a, d, path] = line.split('\t'); return { path, additions: Number(a) || 0, deletions: Number(d) || 0 } })
    pr.changedFiles = pr.files.length
    pr.additions = pr.files.reduce((n, f) => n + f.additions, 0)
    pr.deletions = pr.files.reduce((n, f) => n + f.deletions, 0)
  }
  function rest(pr) {
    refresh(pr)
    return { ...pr, html_url: pr.url, merged: pr.state === 'MERGED', state: pr.state === 'OPEN' ? 'open' : 'closed', head: { ref: pr.headRefName, sha: pr.headOid, repo: { full_name: s.repo.nameWithOwner } }, base: { ref: pr.baseRefName, sha: git('rev-parse', `refs/heads/${pr.baseRefName}`), repo: { full_name: s.repo.nameWithOwner, html_url: s.repo.url, default_branch: s.repo.defaultBranch } } }
  }
  function create(input) {
    const head = input.head?.split(':').pop()
    if (!head || !input.base || !input.title) fail('HTTP 422: title, head and base required')
    if (s.prs.some(p => p.state === 'OPEN' && p.headRefName === head && p.baseRefName === input.base)) fail('HTTP 422: a pull request already exists')
    const sha = git('rev-parse', `refs/heads/${head}`)
    const base = git('rev-parse', `refs/heads/${input.base}`)
    const number = s.nextNumber++
    const pr = { number, title: input.title, body: input.body || '', author: s.viewer, state: 'OPEN', isDraft: !!input.draft, headRefName: head, baseRefName: input.base, headOid: sha, headRefOid: sha, baseOid: git('merge-base', base, sha), baseRefOid: base, createdAt: now(), updatedAt: now(), mergedAt: null, closedAt: null, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], comments: [], reviews: [], latestReviews: [], reviewRequests: [], reviewComments: [], reviewThreads: [], labels: [], commits: [{ oid: sha, messageHeadline: input.title, committedDate: now(), authors: [s.viewer] }], files: [], url: `${s.repo.url}/pull/${number}` }
    s.prs.push(pr)
    refresh(pr)
    return pr
  }
  function comment(pr, text) {
    if (!text.trim()) fail('HTTP 422: body cannot be blank')
    const id = next()
    const item = { id: `IC_${id}`, databaseId: id, author: s.viewer, user: s.viewer, body: text, createdAt: now(), updatedAt: now(), url: `${pr.url}#issuecomment-${id}` }
    pr.comments.push(item); touch(pr)
    return item
  }
  function review(pr, input) {
    const id = next()
    const item = { id: `PRR_${id}`, databaseId: id, author: s.viewer, user: s.viewer, state: ({ APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' })[input.event] ?? 'COMMENTED', body: input.body || '', submittedAt: now(), commit: { oid: pr.headOid } }
    pr.reviews.push(item)
    pr.latestReviews = [...pr.latestReviews.filter(r => r.author.login !== s.viewer.login), item]
    if (input.event !== 'COMMENT') pr.reviewDecision = item.state
    for (const c of input.comments || []) {
      const lineComment = { ...c, id: next(), pull_request_review_id: id, user: s.viewer, created_at: now() }
      pr.reviewComments.push(lineComment)
      pr.reviewThreads.push({ id: `thread-${lineComment.id}`, isResolved: false, isOutdated: false, path: c.path, line: c.line, side: c.side, startLine: c.start_line ?? null, startSide: c.start_side ?? null, comments: [lineComment] })
    }
    touch(pr)
    return item
  }
  function merge(pr) {
    refresh(pr)
    if (pr.state !== 'OPEN' || pr.isDraft) fail('HTTP 422: pull request is not ready for merge')
    if (flag('--match-head-commit') && flag('--match-head-commit') !== pr.headOid) fail('HTTP 409: head commit changed')
    if (pr.mergeable === 'CONFLICTING') fail('Pull request is not mergeable: merge conflict')
    const blocked = pr.statusCheckRollup.some(c => c.status === 'IN_PROGRESS' || c.conclusion === 'FAILURE') || pr.reviewDecision === 'CHANGES_REQUESTED'
    if (has('--auto') && blocked) { pr.autoMergeRequest = { enabledAt: now(), mergeMethod: has('--squash') ? 'SQUASH' : has('--rebase') ? 'REBASE' : 'MERGE' }; touch(pr); return }
    if (blocked) fail('Required status checks failed; branch policy prohibits the merge')
    const work = join(dir, `merge-${pr.number}-${next()}`)
    demoGit(dir, ['clone', '-q', '--no-hardlinks', s.repo.origin, work])
    demoGit(work, ['config', 'commit.gpgsign', 'false'])
    demoGit(work, ['switch', '-q', pr.baseRefName])
    if (has('--squash')) {
      demoGit(work, ['merge', '--squash', pr.headOid])
      demoGit(work, ['commit', '-q', '-m', `${pr.title} (#${pr.number})`])
    } else if (has('--rebase')) {
      const base = demoGit(work, ['merge-base', 'HEAD', pr.headOid])
      const commits = demoGit(work, ['rev-list', '--reverse', `${base}..${pr.headOid}`]).split('\n').filter(Boolean)
      for (const sha of commits) demoGit(work, ['cherry-pick', sha])
    } else demoGit(work, ['merge', '--no-ff', '-m', `Merge PR #${pr.number}: ${pr.title}`, pr.headOid])
    demoGit(work, ['push', '-q', 'origin', pr.baseRefName])
    pr.state = 'MERGED'; pr.mergedAt = pr.closedAt = now(); pr.mergeCommit = { oid: git('rev-parse', `refs/heads/${pr.baseRefName}`) }; pr.autoMergeRequest = null; touch(pr)
    if (has('--delete-branch')) git('update-ref', '-d', `refs/heads/${pr.headRefName}`)
  }
  let output = ''
  let raw = false
  if (args[0] === '--version') { output = 'gh version 2.65.0 (Inkstone offline demo)'; raw = true }
  else if (args[0] === 'auth' && args[1] === 'status') { output = 'github.com: Logged in as demo-developer (offline fixture, no credentials)'; raw = true }
  else if (args[0] === 'repo' && args[1] === 'view') output = projectFields({ ...s.repo, defaultBranchRef: { name: s.repo.defaultBranch } })
  else if (args[0] === 'pr' && args[1] === 'list') {
    let prs = [...s.prs]
    const state = (flag('--state') ?? 'open').toUpperCase()
    if (state !== 'ALL') prs = prs.filter(p => p.state === state)
    if (flag('--author')) prs = prs.filter(p => p.author.login === (flag('--author') === '@me' ? s.viewer.login : flag('--author')))
    for (const label of flags('--label')) prs = prs.filter(p => p.labels.some(l => l.name === label))
    if (flag('--draft') !== undefined) prs = prs.filter(p => p.isDraft === (flag('--draft') === 'true'))
    const search = flag('--search') ?? ''
    const decision = search.match(/review:(none|required|approved|changes_requested)/)?.[1]
    if (decision) prs = prs.filter(p => p.reviewDecision === ({ none: '', required: 'REVIEW_REQUIRED', approved: 'APPROVED', changes_requested: 'CHANGES_REQUESTED' })[decision])
    const [, sort = 'updated', order = 'desc'] = search.match(/sort:(created|updated|comments)-(asc|desc)/) ?? []
    prs.sort((a, b) => ((sort === 'comments' ? a.comments.length - b.comments.length : String(a[`${sort}At`]).localeCompare(String(b[`${sort}At`]))) || a.number - b.number) * (order === 'asc' ? 1 : -1))
    output = prs.slice(0, Number(flag('--limit') ?? 30)).map(p => { refresh(p); return projectFields(p) })
  } else if (args[0] === 'pr' && args[1] === 'create') { const p = create({ title: flag('--title'), body: body(), base: flag('--base') || 'main', head: flag('--head'), draft: has('--draft') }); output = p.url; raw = true }
  else if (args[0] === 'pr') {
    const pr = find(args[2]); refresh(pr)
    switch (args[1]) {
      case 'view': output = projectFields(pr); break
      case 'diff': output = git('diff', '--no-ext-diff', '--binary', pr.baseOid, pr.headOid); raw = true; break
      case 'comment': output = comment(pr, body()).url; raw = true; break
      case 'edit':
        if (flag('--title') !== undefined) pr.title = flag('--title')
        if (flag('--body') !== undefined || flag('--body-file')) pr.body = body()
        for (const name of flags('--add-label')) if (!pr.labels.some(l => l.name === name)) pr.labels.push(s.labels.find(l => l.name === name) || { name, color: 'eeeeee' })
        pr.labels = pr.labels.filter(l => !flags('--remove-label').includes(l.name))
        for (const login of flags('--add-reviewer')) if (!pr.reviewRequests.some(r => r.login === login)) pr.reviewRequests.push({ login })
        pr.reviewRequests = pr.reviewRequests.filter(r => !flags('--remove-reviewer').includes(r.login))
        touch(pr); break
      case 'review': output = review(pr, { body: body(), event: has('--approve') ? 'APPROVE' : has('--request-changes') ? 'REQUEST_CHANGES' : 'COMMENT' }); break
      case 'ready': pr.isDraft = has('--undo'); touch(pr); break
      case 'close': if (pr.state === 'MERGED') fail('HTTP 422: already merged'); pr.state = 'CLOSED'; pr.closedAt = now(); touch(pr); break
      case 'reopen': if (pr.state === 'MERGED') fail('HTTP 422: already merged'); pr.state = 'OPEN'; pr.closedAt = null; touch(pr); break
      case 'merge': merge(pr); break
      default: fail(`Unsupported demo gh command: ${args.slice(0, 2).join(' ')}`)
    }
  } else if (args[0] === 'api' && args[1] === 'user') output = s.viewer
  else if (args[0] === 'api' && args[1] === 'graphql') {
    const fields = Object.fromEntries([...flags('-f'), ...flags('-F')].map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)] }))
    const offset = Number(fields.cursor?.split(':').pop() || 0)
    const connection = (items, kind) => ({ nodes: items.slice(offset, offset + 100), pageInfo: { hasNextPage: items.length > offset + 100, endCursor: `${kind}:${offset + 100}` } })
    const gqlComment = c => ({ id: `PRRC_${c.id}`, databaseId: c.id, author: c.user || c.author, body: c.body, createdAt: c.created_at || c.createdAt, url: c.url || '', path: c.path, line: c.line ?? null, startLine: c.start_line ?? null, replyTo: c.in_reply_to_id ? { databaseId: c.in_reply_to_id } : null })
    if (fields.query?.includes('node(id:')) {
      const thread = s.prs.flatMap(p => p.reviewThreads).find(t => t.id === fields.id) ?? fail('HTTP 404: review thread not found')
      output = { data: { node: { comments: connection(thread.comments.map(gqlComment), 'comment') } } }
    } else {
      const pr = find(fields.number)
      const threads = pr.reviewThreads.map(t => ({ id: t.id, isResolved: t.isResolved, isOutdated: t.isOutdated || false, path: t.path, line: t.line ?? null, startLine: t.startLine ?? null, diffSide: t.side || 'RIGHT', startDiffSide: t.startSide ?? null, comments: { nodes: t.comments.slice(0, 100).map(gqlComment), pageInfo: { hasNextPage: t.comments.length > 100, endCursor: 'comment:100' } } }))
      output = { data: { repository: { pullRequest: { reviewThreads: connection(threads, 'thread') } } } }
    }
  } else if (args[0] === 'api') {
    const [endpoint, query = ''] = args[1].replace(/^\//, '').split('?')
    const tail = endpoint.replace(/^repos\/[^/]+\/[^/]+\//, '')
    const method = flag('--method') || 'GET'
    const input = has('--input') ? JSON.parse(body()) : {}
    const parts = tail.split('/').map(decodeURIComponent)
    if (tail === 'collaborators' || tail === 'labels') {
      const params = new URLSearchParams(query); const size = Number(params.get('per_page') || 100); const page = Number(params.get('page') || 1)
      output = (tail === 'labels' ? s.labels : s.reviewers).slice((page - 1) * size, page * size)
    } else if (tail === 'pulls' && method === 'POST') output = rest(create(input))
    else if (parts[0] === 'git' && ['ref', 'refs'].includes(parts[1]) && parts[2] === 'heads') {
      const ref = `refs/heads/${parts.slice(3).join('/')}`
      if (method === 'DELETE') { if (ref === `refs/heads/${s.repo.defaultBranch}`) fail('HTTP 403: cannot delete default branch'); git('update-ref', '-d', ref); output = {} }
      else output = { ref, object: { sha: git('rev-parse', ref) } }
    } else if (['pulls', 'issues'].includes(parts[0])) {
      const pr = find(parts[1]); refresh(pr)
      if (parts.length === 2 && method === 'GET') output = rest(pr)
      else if (parts.length === 2 && method === 'PATCH') { for (const key of ['title', 'body']) if (input[key] !== undefined) pr[key] = input[key]; touch(pr); output = rest(pr) }
      else if (parts[2] === 'requested_reviewers') {
        if (method === 'POST') for (const login of input.reviewers || []) { if (!pr.reviewRequests.some(r => r.login === login)) pr.reviewRequests.push({ __typename: 'User', login }) }
        if (method === 'DELETE') pr.reviewRequests = pr.reviewRequests.filter(r => !input.reviewers.includes(r.login))
        touch(pr); output = { users: pr.reviewRequests, teams: [] }
      } else if (parts[2] === 'labels') {
        if (method === 'POST') for (const name of input.labels || []) if (!pr.labels.some(l => l.name === name)) pr.labels.push(s.labels.find(l => l.name === name) || { name, color: 'eeeeee' })
        if (method === 'DELETE') pr.labels = pr.labels.filter(l => l.name !== parts[3])
        touch(pr); output = pr.labels
      } else if (parts[2] === 'reviews') output = method === 'POST' ? review(pr, input) : pr.reviews
      else if (parts[2] === 'comments' && parts[4] === 'replies' && method === 'POST') {
        const parent = pr.reviewComments.find(c => c.id === Number(parts[3])) ?? fail('HTTP 404: review comment not found')
        const item = { ...parent, id: next(), in_reply_to_id: parent.id, body: input.body, user: s.viewer, created_at: now() }
        pr.reviewComments.push(item); pr.reviewThreads.find(t => t.comments.some(c => c.id === parent.id))?.comments.push(item); touch(pr); output = item
      } else if (parts[2] === 'comments') output = pr.reviewComments
      else fail(`Unsupported demo API endpoint: ${tail}`)
    } else fail(`Unsupported demo API endpoint: ${tail}`)
  } else fail(`Unsupported demo gh command: ${args.join(' ')}`)
  s.operations.push({ at: now(), command: args, cwd: process.cwd() })
  const temp = `${stateFile}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(s, null, 2) + '\n')
  renameSync(temp, stateFile)
  process.stdout.write((raw ? output : JSON.stringify(output)) + '\n')
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  if (locked) rmSync(lock, { recursive: true })
}
