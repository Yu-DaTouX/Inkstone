import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

async function load(path, replacements = {}) {
  const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, a => a.path in replacements ? { path: a.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: replacements[a.path], loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}
const gh = await load('src/main/github/gh.ts')
const { readPrCreateDefaults } = await load('src/main/github/defaults.ts')
const { readReviewThreads } = await load('src/main/github/threads.ts')
const { validateAction, listArguments } = await load('src/main/github/validation.ts')
const ok = value => ({ ok: true, stdout: JSON.stringify(value), stderr: '', missing: false, missingCwd: false, timedOut: false, overflow: false })
const fail = { ...ok(null), ok: false, stderr: 'HTTP 403: forbidden' }
const calls = []
const runStatus = async (cwd, args) => {
  calls.push(args)
  if (args[0] === 'repo') return ok({ nameWithOwner: 'demo/ledger', url: 'https://github.com/demo/ledger', defaultBranchRef: { name: 'trunk' } })
  if (args[0] === 'api') return ok({ login: 'demo-viewer' })
  return ok({})
}
const status = await gh.readGithubStatus('/fixture', runStatus)
assert.equal(status.viewerLogin, 'demo-viewer')
assert.equal(status.repo.defaultBranch, 'trunk')
assert.ok(calls.some(args => args[0] === 'api' && args[1] === 'user'))
const noViewer = await gh.readGithubStatus('/fixture', (cwd, args) => args[0] === 'api' ? Promise.resolve(fail) : runStatus(cwd, args))
assert.equal(noViewer.authed, true)
assert.equal(noViewer.viewerLogin, undefined)
assert.equal(listArguments({ author: '@me' }).ok, true)
assert.ok(listArguments({ author: '@me' }).args.includes('@me'))
for (const author of ['@other', '@me --bad', '--author', 'a b']) assert.equal(listArguments({ author }).ok, false)
const gitCalls = []
const git = async (cwd, args) => { gitCalls.push(args); return { ok: true, stdout: args[0] === 'branch' ? 'feature/refine\n' : 'Keep the title intact\0First paragraph\n\nSecond paragraph\n' } }
const defaults = await readPrCreateDefaults('/fixture', runStatus, git)
assert.deepEqual(defaults, { ok: true, currentBranch: 'feature/refine', latestCommit: { subject: 'Keep the title intact', body: 'First paragraph\n\nSecond paragraph' }, defaultBranch: 'trunk' })
assert.deepEqual(gitCalls, [['branch', '--show-current'], ['log', '-1', '--format=%s%x00%b']])
const detached = await readPrCreateDefaults('/fixture', runStatus, async (cwd, args) => ({ ok: true, stdout: args[0] === 'branch' ? '\n' : 'subject\0body\n' }))
assert.equal(detached.currentBranch, null)
assert.equal(detached.ok, true)
assert.equal((await readPrCreateDefaults('/fixture', async () => fail, git)).failure.code, 'forbidden')
assert.equal((await readPrCreateDefaults('/fixture', runStatus, async () => ({ ok: false, stdout: '' }))).failure.code, 'git-failed')
const badRepo = await readPrCreateDefaults('/fixture', async () => ok({ defaultBranchRef: null }), git)
assert.equal(badRepo.ok, false)
assert.equal(badRepo.latestCommit.subject, 'Keep the title intact')
const connection = (nodes, cursor = null) => ({ nodes, pageInfo: { hasNextPage: !!cursor, endCursor: cursor } })
const comment = (databaseId, extra = {}) => ({ id: `PRRC_${databaseId}`, databaseId, body: `comment ${databaseId}`, path: 'src/ledger.js', line: 14, author: { login: 'reviewer' }, createdAt: '2026-10-28T10:00:00Z', ...extra })
const thread = (id, extra = {}) => ({ id, isResolved: false, isOutdated: false, path: 'src/ledger.js', line: 14, startLine: 10, diffSide: 'LEFT', startDiffSide: 'LEFT', comments: connection([comment(1001)], 'comments-next'), ...extra })
const queries = []
const pages = async (cwd, args) => {
  queries.push(args)
  if (args.some(a => a.startsWith('id='))) return ok({ data: { node: { comments: connection([comment(1002, { replyTo: { databaseId: 1001 } })]) } } })
  const next = args.includes('cursor=threads-next')
  return ok({ data: { repository: { pullRequest: { reviewThreads: next ? connection([thread('thread-2', { isResolved: true, isOutdated: true, line: null, comments: connection([comment(2001, { line: null })]) })]) : connection([thread('thread-1')], 'threads-next') } } } })
}
const threads = await readReviewThreads('/fixture', 7, pages)
assert.equal(threads.reviewThreads.length, 2)
assert.equal(threads.reviewThreads[0].comments.length, 2)
assert.deepEqual(threads.reviewThreads[0].comments.map(c => c.databaseId), [1001, 1002])
assert.equal(threads.reviewThreads[0].comments[1].replyToId, 1001)
assert.equal(threads.reviewThreads[0].comments[0].side, 'LEFT')
assert.equal(threads.reviewThreads[0].startLine, 10)
assert.equal(threads.reviewThreads[1].isResolved, true)
assert.equal(threads.reviewThreads[1].line, null)
assert.equal(queries.length, 3)
assert.equal(threads.reviewThreadsTruncated, undefined)
const partial = await readReviewThreads('/fixture', 7, async (cwd, args) => args.some(a => a.startsWith('id=')) ? fail : pages(cwd, args))
assert.equal(partial.reviewThreads.length, 1)
assert.equal(partial.reviewThreadsTruncated, true)
assert.ok(partial.reviewThreadsError)
const looping = await readReviewThreads('/fixture', 7, async () => ok({ data: { repository: { pullRequest: { reviewThreads: connection([], 'same-cursor') } } } }))
assert.equal(looping.reviewThreadsTruncated, true)
assert.equal((await readReviewThreads('/fixture', 7, async () => ok({ errors: [{ message: 'not exposed' }] }))).reviewThreadsError, '无法读取行内评审讨论')
const detail = await gh.ghPrDetail('/fixture', 7, async (cwd, args) => args[0] === 'pr' ? ok({ number: 7, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) : fail)
assert.equal(detail.ok, true)
assert.equal(detail.pr.mergeable, 'CONFLICTING')
assert.equal(detail.pr.mergeStateStatus, 'DIRTY')
assert.ok(detail.pr.reviewThreadsError)
assert.equal((await gh.ghPrDetail('/fixture', 7, async () => ok({ number: 8 }))).ok, false)
const request = comments => ({ kind: 'review', number: 7, event: 'COMMENT', body: 'Overall review', comments })
const base = { path: 'src/ledger.js', line: 14, side: 'RIGHT', body: 'Review this range' }
assert.equal(validateAction(request([{ ...base, startLine: 10 }])), null)
assert.equal(validateAction(request([{ ...base, startLine: 10, startSide: 'LEFT' }])), null)
for (const range of [{ startLine: 0 }, { startLine: 15 }, { startLine: 1.5 }, { startSide: 'RIGHT' }, { startLine: 10, startSide: 'INVALID' }]) assert.equal(validateAction(request([{ ...base, ...range }])).code, 'invalid-input')
const { registerGithubIpc } = await load('src/main/ipc/github-ipc.ts', { electron: 'export const shell={openExternal:async()=>{}}', '../github/defaults': 'export const readPrCreateDefaults=async(cwd)=>({ok:true,currentBranch:cwd,latestCommit:{subject:"subject",body:"body"},defaultBranch:"trunk"})' })
const handlers = new Map()
let authorized = false
registerGithubIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { authorizeReadCwd: async () => authorized ? { ok: true, cwd: '/authorized' } : { ok: false, error: 'denied' } })
assert.equal((await handlers.get('yan:github:createDefaults')('/untrusted')).failure.code, 'cwd-rejected')
authorized = true
assert.equal((await handlers.get('yan:github:createDefaults')('/untrusted')).currentBranch, '/authorized')
const preload = await readFile('src/preload/index.ts', 'utf8')
assert.ok(preload.includes("'yan:github:createDefaults'"))
console.log('test-github-pr-details: PASS (@me, viewer/default branch, read-only commit defaults, thread/comment pagination and partial failures, numeric reply IDs, multi-line ranges, merge fields, authorized IPC/preload)')
