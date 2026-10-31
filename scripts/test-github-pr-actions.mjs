import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const gitStub = 'export const pushCurrentBranchForPr = async () => ({ok:true}); export const checkoutPrHead = async () => ({ok:true});'
async function load(path, replacements = {}) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(path, root))], bundle: true, write: false,
    platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'fixtures', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in replacements ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: replacements[args.path], loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { createGithubPrBackend } = await load('src/main/github/actions.ts', { '../git-actions': gitStub })
const { createGhRunner, classifyGhFailure } = await load('src/main/github/command.ts')
const { ghPrList } = await load('src/main/github/gh.ts')
const sha = 'a'.repeat(40)
const url = 'https://github.com/acme/app/pull/12'
const rest = {
  number: 12, html_url: url, merged: true,
  head: { ref: 'feat/pr', sha, repo: { full_name: 'acme/app' } },
  base: { repo: { full_name: 'acme/app', html_url: 'https://github.com/acme/app', default_branch: 'main' } }
}
const success = stdout => ({ ok: true, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', missing: false, missingCwd: false, timedOut: false, overflow: false })
const failure = (stderr, extra = {}) => ({ ...success(''), ok: false, stderr, ...extra })
const calls = []
let respond
const run = async (cwd, args, maxBuffer, input) => {
  const call = { cwd, args, input, json: input?.startsWith('{') ? JSON.parse(input) : undefined }
  calls.push(call)
  if (respond) return respond(call)
  if (args[0] === 'pr' && args[1] === 'view') return success({ number: 12, url })
  if (args[0] === 'api' && args[1].includes('/git/ref/')) return success({ object: { sha } })
  if (args[0] === 'api' && args[1].endsWith('/pulls/12') && args.includes('GET')) return success(rest)
  if (args[0] === 'api' && args[1].endsWith('/pulls')) return success({ number: 12, html_url: url })
  return success({})
}
const gitCalls = []
let gitResponse = { ok: true }
const git = {
  pushCurrentBranchForPr: async (...args) => { gitCalls.push(['push', ...args]); return gitResponse },
  checkoutPrHead: async (...args) => { gitCalls.push(['checkout', ...args]); return gitResponse }
}
const backend = createGithubPrBackend(run, git)
const act = async request => { calls.length = 0; gitCalls.length = 0; return backend.action('/project', request) }
const body = '正文\n"quotes" $(never-execute) `literal`\n' + '长文本'.repeat(4000)
let result = await act({ kind: 'create', title: 'PR title', body, base: 'main', head: 'feat/pr', draft: true, pushFirst: { remote: 'origin', setUpstream: true } })
assert.equal(result.ok, true)
assert.equal(result.number, 12)
assert.equal(result.url, url)
assert.equal(result.pr.number, 12)
assert.deepEqual(result.completedSteps, ['push', 'create'])
assert.deepEqual(gitCalls[0], ['push', '/project', 'feat/pr', { remote: 'origin', setUpstream: true }])
assert.deepEqual(calls[0].args, ['api', 'repos/{owner}/{repo}/pulls', '--method', 'POST', '--input', '-'])
assert.equal(calls[0].json.body, body)
assert.equal(calls[0].json.draft, true)
assert.ok(calls.every(call => !call.args.includes(body)))

result = await act({ kind: 'comment', number: 12, body })
assert.equal(result.ok, true)
assert.deepEqual(calls[0].args, ['pr', 'comment', '12', '--body-file', '-'])
assert.equal(calls[0].input, body)
result = await act({ kind: 'reply', number: 12, commentId: 9876543210, body })
assert.equal(result.ok, true)
assert.equal(calls[0].args[1], 'repos/{owner}/{repo}/pulls/12/comments/9876543210/replies')
assert.equal(calls[0].json.body, body)

result = await act({ kind: 'edit', number: 12, title: 'Changed', body, addReviewers: ['octocat'], removeReviewers: ['old-user'], addLabels: ['bug', '功能'], removeLabels: ['needs work'] })
assert.equal(result.ok, true)
assert.deepEqual(result.completedSteps, ['edit', 'add-reviewers', 'remove-reviewers', 'add-labels', 'remove-label:needs work'])
assert.equal(calls[0].json.body, body)
assert.deepEqual(calls[1].json, { reviewers: ['octocat'] })
assert.equal(calls[2].args[3], 'DELETE')
assert.deepEqual(calls[3].json, { labels: ['bug', '功能'] })
assert.equal(calls[4].args[1], 'repos/{owner}/{repo}/issues/12/labels/needs%20work')

for (const method of ['merge', 'squash', 'rebase']) {
  result = await act({ kind: 'merge', number: 12, method, confirmed: true, autoMerge: true })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[1].args, ['pr', 'merge', '12', `--${method}`, '--match-head-commit', sha, '--auto'])
}
result = await act({ kind: 'merge', number: 12, method: 'squash', confirmed: true, deleteBranch: true })
assert.equal(result.branchDeletion, 'deleted')
assert.ok(calls.some(c => c.args[1] === 'repos/acme/app/git/refs/heads/feat/pr' && c.args[3] === 'DELETE'))
assert.ok(!calls.some(c => c.args.includes('--delete-branch')))
rest.merged = false
result = await act({ kind: 'merge', number: 12, method: 'merge', confirmed: true, autoMerge: true, deleteBranch: true })
assert.equal(result.branchDeletion, 'pending')
assert.ok(!calls.some(c => c.args.includes('DELETE')))
result = await act({ kind: 'delete-branch', number: 12, confirmed: true })
assert.equal(result.failure.code, 'invalid-input')
rest.merged = true
rest.head.ref = 'main'
result = await act({ kind: 'merge', number: 12, method: 'merge', confirmed: true, deleteBranch: true })
assert.equal(result.failure.code, 'forbidden')
assert.ok(!calls.some(c => c.args[1] === 'merge'))
rest.head.ref = 'feat/pr'
rest.head.repo.full_name = 'fork/app'
result = await act({ kind: 'delete-branch', number: 12, confirmed: true })
assert.equal(result.failure.code, 'forbidden')
rest.head.repo.full_name = 'acme/app'

for (const kind of ['ready', 'draft', 'close', 'reopen']) {
  result = await act({ kind, number: 12, confirmed: true })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].args, ['pr', kind === 'draft' ? 'ready' : kind, '12', ...(kind === 'draft' ? ['--undo'] : [])])
}
for (const event of ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']) {
  const comments = [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Please fix' }, { path: 'src/old.ts', line: 1, side: 'LEFT', body: 'Removed line' }]
  result = await act({ kind: 'review', number: 12, event, body, comments })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[1].json, { event, body, commit_id: sha, comments })
}
result = await act({ kind: 'checkout', number: 12 })
assert.equal(result.ok, true)
assert.deepEqual(gitCalls[0], ['checkout', '/project', 12, 'https://github.com/acme/app', sha, { headRef: 'feat/pr', headRepoUrl: null, baseRepoUrl: 'https://github.com/acme/app', maintainerCanModify: false }])

for (const request of [
  null, {}, { kind: 'close', number: '12', confirmed: true }, { kind: 'close', number: 10_000_000, confirmed: true },
  { kind: 'merge', number: 12, method: '--force', confirmed: true },
  { kind: 'comment', number: 12, body: '' }, { kind: 'reply', number: 12, commentId: -1, body },
  { kind: 'edit', number: 12, addReviewers: ['--admin'] }, { kind: 'edit', number: 12, addLabels: ['bug,other'] },
  { kind: 'edit', number: 12, addLabels: ['bug'], removeLabels: ['bug'] },
  { kind: 'review', number: 12, event: 'APPROVE', body, comments: [{ path: '../outside', line: 1, side: 'RIGHT', body: 'x' }] },
  { kind: 'review', number: 12, event: 'APPROVE', body, comments: [{ path: 'a', line: 0, side: 'RIGHT', body: 'x' }] },
  { kind: 'create', title: 'x', body, head: '--bad', base: 'main' },
  { kind: 'create', title: 'x', body, head: 'owner:branch', base: 'main', pushFirst: {} },
  { kind: 'create', title: 'x', body, head: 'branch', base: 'main', pushFirst: { remote: 123 } }
]) {
  result = await act(request)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'invalid-input')
  assert.equal(calls.length, 0)
  assert.equal(gitCalls.length, 0)
}
for (const kind of ['merge', 'close', 'delete-branch']) for (const confirmed of [undefined, false, 'true', 1]) {
  result = await act({ kind, number: 12, method: 'merge', confirmed })
  assert.equal(result.failure.code, 'confirmation-required')
  assert.equal(calls.length, 0)
}

for (const [runResult, code] of [
  [failure('', { missing: true }), 'gh-missing'], [failure('Run gh auth login'), 'not-authenticated'],
  [failure('HTTP 403: Resource not accessible'), 'forbidden'], [failure('HTTP 404 Not Found'), 'pr-not-found'],
  [failure('Pull request is not mergeable'), 'not-mergeable'], [failure('the base branch policy prohibits the merge'), 'checks-rejected'],
  [failure('Required status check failed'), 'checks-rejected'], [failure('TLS handshake timeout'), 'timeout'],
  [failure('', { timedOut: true }), 'timeout'], [failure('unknown error'), 'other']
]) {
  respond = () => runResult
  result = await act({ kind: 'comment', number: 12, body })
  assert.equal(result.failure.code, code)
  if (code === 'timeout' || code === 'other') assert.equal(result.failure.retrySafe, false)
  if (code === 'timeout') assert.match(result.failure.message, /结果未知.*刷新确认/)
}
assert.equal(classifyGhFailure(failure('', { timedOut: true }), false).retrySafe, true)
respond = call => call.args[0] === 'pr' && call.args[1] === 'view' ? failure('', { timedOut: true }) : success({})
result = await act({ kind: 'comment', number: 12, body })
assert.equal(result.ok, true)
assert.equal(result.refreshRequired, true)
assert.equal(result.refreshFailure.code, 'timeout')
respond = call => call.args[1].endsWith('/requested_reviewers') ? failure('HTTP 403') : success({})
result = await act({ kind: 'edit', number: 12, title: 'changed', addReviewers: ['octocat'] })
assert.deepEqual(result.completedSteps, ['edit'])
assert.equal(result.failure.retrySafe, false)
respond = undefined

gitResponse = { ok: false, failure: { code: 'non-fast-forward', message: '推送被拒', hint: '先同步', retrySafe: true, detail: 'not exposed' } }
result = await act({ kind: 'create', title: 'x', body: '', base: 'main', head: 'feat/pr', pushFirst: {} })
assert.equal(result.failure.code, 'git-failed')
assert.equal(result.failure.gitFailure.code, 'non-fast-forward')
assert.equal(result.failure.gitFailure.detail, undefined)
assert.equal(calls.length, 0)
gitResponse = { ok: false, failure: { code: 'timeout', message: '结果未知', retrySafe: false } }
result = await act({ kind: 'create', title: 'x', body: '', base: 'main', head: 'feat/pr', pushFirst: {} })
assert.equal(result.failure.code, 'timeout')
assert.equal(result.failure.retrySafe, false)
assert.match(result.failure.message, /结果未知.*刷新确认/)
gitResponse = { ok: true }
respond = () => failure('unexpected output credential-sentinel')
result = await act({ kind: 'comment', number: 12, body: 'test' })
assert.ok(!JSON.stringify(result).includes('credential-sentinel'))

respond = () => success([{ login: 'octocat' }])
result = await backend.candidates('/project', { kind: 'reviewers', page: 2, perPage: 1 })
assert.equal(result.hasMore, true)
assert.deepEqual(result.reviewers, [{ login: 'octocat' }])
assert.match(calls.at(-1).args[1], /collaborators\?per_page=1&page=2$/)
respond = () => success([{ name: 'bug', color: 'ff0000', description: 'bug label' }])
result = await backend.candidates('/project', { kind: 'labels' })
assert.equal(result.labels[0].name, 'bug')
assert.equal((await backend.candidates('/project', { kind: 'labels', page: 0 })).failure.code, 'invalid-input')
respond = undefined

calls.length = 0
result = await ghPrList('/project', { state: 'open', author: 'octocat', labels: ['bug'], draft: false, review: 'approved', sort: 'updated', direction: 'asc', limit: 1 }, async (...args) => {
  await run(...args)
  return success([{ number: 12, labels: [{ name: 'bug' }], reviewDecision: 'APPROVED' }, { number: 13 }])
})
assert.equal(result.items.length, 1)
assert.equal(result.hasMore, true)
assert.equal(result.items[0].labels[0].name, 'bug')
assert.ok(calls[0].args.includes('--draft=false'))
assert.ok(calls[0].args.includes('review:approved sort:updated-asc'))
assert.ok(calls[0].args.includes('2'))
for (const options of [{ limit: 501 }, { author: '--bad' }, { review: 'injected' }, { labels: ['bug,other'] }, { sort: '--force' }]) {
  assert.equal((await ghPrList('/project', options, () => { throw new Error('must not execute') })).failure.code, 'invalid-input')
}
assert.equal((await ghPrList('/project', 'closed', async () => success([]))).ok, true)

let executed
let stdin
const execute = (file, args, options, callback) => {
  executed = { file, args, options }
  const child = { stdin: new EventEmitter() }
  child.stdin.end = input => { stdin = input; queueMicrotask(() => callback(null, '{}', '')) }
  return child
}
await createGhRunner(execute)('/project', ['pr', 'comment', '12', '--body-file', '-'], undefined, body)
assert.equal(executed.file, 'gh')
assert.equal(executed.options.shell, undefined)
assert.equal(executed.options.timeout, 20_000)
assert.equal(executed.options.maxBuffer, 8 * 1024 * 1024)
assert.equal(executed.options.env.GH_PROMPT_DISABLED, '1')
assert.equal(stdin, body)
for (const [error, expected] of [[{ code: 'ETIMEDOUT', killed: true }, 'timeout'], [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'other'], [{ code: 'ENOENT' }, 'gh-missing']]) {
  const mock = (file, args, options, callback) => {
    queueMicrotask(() => callback(error, '', ''))
    return { stdin: { on() {}, end() {} } }
  }
  const runResult = await createGhRunner(mock)(process.cwd(), ['pr', 'comment', '12'])
  assert.equal(classifyGhFailure(runResult, true).code, expected)
}

const serviceStub = `
export const state = {running:false, dirty:false, overlap:false, commands:[], head:'${sha}', branch:'feat/pr'};
export async function resolveRepo(){return {root:'/project',repoId:'repo'}}
export async function readExpected(){return {head:state.head,indexDigest:'',statusDigest:''}}
export async function readRepoState(){return {head:state.head,branch:state.branch,upstream:'origin/feat/pr'}}
export async function readStatus(){return {entries:state.dirty?[{path:'src/a.ts'}]:[]}}
export async function refExists(){return true}
export function safeRepoPath(x){return x}
export async function gitRun(root,args){
state.commands.push(args);
let stdout='';
if(args[0]==='remote')stdout='origin';
if(args[0]==='rev-parse')stdout=state.head;
if(args[0]==='diff')stdout=state.overlap?'src/a.ts\\0':'src/other.ts\\0';
return {ok:true,stdout,stderr:''};
}
`
const guardBundle = await build({ stdin: { contents: `export * from './src/main/git-actions'; export {state} from './src/main/git-service'`, resolveDir: fileURLToPath(root) }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'git-service', setup(b) {
  b.onResolve({filter: /git-service$/}, () => ({path:'git-service',namespace:'fixture'}))
  b.onLoad({filter: /.*/, namespace:'fixture'}, () => ({contents:serviceStub,loader:'js'}))
} }] })
const local = await import(`data:text/javascript;base64,${Buffer.from(guardBundle.outputFiles[0].text).toString('base64')}`)
local.configureWriteContext({ hasRunningTask: () => local.state.running })
local.state.running = true
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha)
assert.equal(result.failure.code, 'busy')
assert.equal(local.state.commands.length, 0)
local.state.running = false
local.state.dirty = true
local.state.overlap = true
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha)
assert.equal(result.failure.code, 'dirty-blocks-switch')
assert.ok(!local.state.commands.some(args => args[0] === 'switch'))
local.state.overlap = false
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha)
assert.equal(result.ok, true)
assert.ok(local.state.commands.some(args => args[0] === 'switch' && args[1] === '--detach'))
local.state.commands.length = 0
const branchOptions = { headRef: 'feat/x', headRepoUrl: 'https://github.com/acme/app', baseRepoUrl: 'https://github.com/acme/app', maintainerCanModify: false }
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha, branchOptions)
assert.equal(result.ok, true)
assert.match(result.summary, /本地分支 feat\/x/)
assert.ok(!local.state.commands.some(args => args[1] === '--detach'))
assert.ok(local.state.commands.some(args => args[0] === 'switch' && args[1] === 'feat/x'))
assert.ok(local.state.commands.some(args => args[0] === 'config' && args[1] === 'branch.feat/x.remote' && args[2] === 'https://github.com/acme/app'))
assert.ok(local.state.commands.some(args => args[0] === 'config' && args[1] === 'branch.feat/x.merge' && args[2] === 'refs/heads/feat/x'))
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha, { ...branchOptions, headRepoUrl: 'https://github.com/fork/app' })
assert.match(result.summary, /fork/)
assert.match(result.summary, /不会强推/)
local.state.dirty = false
local.state.commands.length = 0
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', 'b'.repeat(40))
assert.equal(result.failure.code, 'stale')
assert.ok(!local.state.commands.some(args => args[0] === 'switch'))
local.configureWriteContext({ hasRunningTask: () => local.state.commands.some(args => args[0] === 'fetch') })
local.state.commands.length = 0
result = await local.checkoutPrHead('/project', 12, 'https://github.com/acme/app', sha)
assert.equal(result.failure.code, 'busy')
assert.ok(!local.state.commands.some(args => args[0] === 'switch'))
local.configureWriteContext({ hasRunningTask: () => false })
result = await local.pushCurrentBranchForPr('/project', 'other', {})
assert.equal(result.failure.code, 'stale')
assert.ok(!local.state.commands.some(args => args[0] === 'push'))
result = await local.pushCurrentBranchForPr('/project', 'feat/pr', { remote: 'missing' })
assert.equal(result.failure.code, 'no-remote')
assert.ok(!local.state.commands.some(args => args[0] === 'push'))
result = await local.pushCurrentBranchForPr('/project', 'feat/pr', { setUpstream: true })
assert.equal(result.ok, true)
assert.deepEqual(local.state.commands.find(args => args[0] === 'push'), ['push', '--set-upstream', '--', 'origin', 'refs/heads/feat/pr:refs/heads/feat/pr'])
const ipcModule = await load('src/main/ipc/github-ipc.ts', { electron: 'export const shell={openExternal:async()=>{}}', '../settings': 'export const getSettings=async()=>({}), patchSettings=async()=>({})', '../project-trust': 'export const trustStatus=async()=>({trusted:false})', '../collab/git': 'export const repoRootOf=async()=>null, resolveCommit=async()=>null', '../git-service': 'export const gitRun=async()=>({ok:true})', '../collab/github-publish': 'export const publishPeerBranch=async()=>({ok:false})', '../github/actions': 'export const githubPrBackend={action:async(cwd,request)=>({ok:true,cwd,request}),candidates:async(cwd,request)=>({ok:true,cwd,request})}' })
const handlers = new Map()
let authorized = false
ipcModule.registerGithubIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { authorizeReadCwd: async () => authorized ? { ok: true, cwd: '/authorized' } : { ok: false, error: 'denied' } })
assert.equal((await handlers.get('yan:github:action')('/project', { kind: 'close' })).failure.code, 'cwd-rejected')
assert.equal((await handlers.get('yan:github:candidates')('/project', { kind: 'labels' })).failure.code, 'cwd-rejected')
authorized = true
assert.equal((await handlers.get('yan:github:action')('/project', { kind: 'ready', number: 12 })).cwd, '/authorized')
console.log('test-github-pr-actions: ok (actions, stdin, validation, failures, confirmation, pagination, Git guards, IPC)')
