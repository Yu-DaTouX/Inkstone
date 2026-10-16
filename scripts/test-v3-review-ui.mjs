import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible'
  }
}

async function buildBundle(outdir) {
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as Page from '${p('src/renderer/src/features/review/ReviewPage.tsx')}'`,
    `import * as Model from '${p('src/renderer/src/features/review/review-model.ts')}'`,
    `import * as Client from '${p('src/renderer/src/features/review/review-client.ts')}'`,
    `import * as Text from '${p('src/renderer/src/features/review/review-text.ts')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    "export { React, renderToStaticMarkup, Page, Model, Client, Text, i18n }"
  ].join('\n')
  const outfile = join(outdir, 'v3-review-ui.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'tsx' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

function mockBridge(responses = {}) {
  const calls = []
  const record = (name) => (...args) => {
    calls.push({ name, args })
    const reply = responses[name]
    return Promise.resolve(typeof reply === 'function' ? reply(...args) : (reply ?? { ok: true }))
  }
  return {
    calls,
    changeSet: record('changeSet'),
    diff: record('diff'),
    annotations: record('annotations'),
    annotationAdd: record('annotationAdd'),
    annotationUpdate: record('annotationUpdate'),
    annotationRemove: record('annotationRemove'),
    annotationClear: record('annotationClear'),
    annotationTask: record('annotationTask'),
    start: record('start'),
    ghStatus: record('ghStatus'),
    commit: record('commit'),
    push: record('push'),
    pullRequest: record('pullRequest')
  }
}

const OWNER = { key: 'session:s1', cwd: 'C:/work/repo', sessionId: 's1', sessionPath: 'C:/sessions/s1', projectId: 'p1', active: true }

const SAMPLE_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@ section',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' export default a',
  ''
].join('\n')

const annotation = (over = {}) => ({
  id: over.id ?? 'a1',
  changeSetId: over.changeSetId ?? 'uncommitted-abc',
  path: over.path ?? 'src/app.ts',
  side: over.side ?? 'new',
  lineStart: over.lineStart ?? 2,
  lineEnd: over.lineEnd ?? 3,
  body: over.body ?? '这里要兼容旧 token',
  anchorRevision: over.anchorRevision ?? 'rev-1',
  createdAt: 1,
  updatedAt: 1,
  author: 'user'
})

const finding = (over = {}) => ({
  severity: over.severity ?? 'high',
  path: over.path ?? 'src/auth/oauth.ts',
  line: over.line ?? 88,
  message: over.message ?? 'code_verifier 未做长度校验',
  suggestion: over.suggestion ?? '校验长度'
})

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-review-ui-'))
  const require = createRequire(import.meta.url)

  try {
    const bundle = require(await buildBundle(outdir))
    const { React, renderToStaticMarkup, Page, Model, Client, Text, i18n } = bundle
    const { createElement } = React
    const render = (element) => renderToStaticMarkup(element)
    const zh = Text.reviewText('zh-CN')
    const en = Text.reviewText('en-US')
    const t = (lang) => (key, vars) => i18n.translate(lang, key, vars)

    const sourceOptions = Model.reviewSourceOptions({ cwd: 'C:/work/repo' })
    ok(sourceOptions.length === 4, '四种来源都在')
    ok(
      sourceOptions.map((option) => option.source).join(',') === 'session,branch,worktree,uncommitted',
      '来源顺序与方案一致'
    )
    ok(sourceOptions.every((option) => option.available), '有 cwd 时四种来源均可用')
    ok(sourceOptions.find((option) => option.source === 'session').note === 'sessionShare', '本会话来源标注同源局限')
    ok(sourceOptions.find((option) => option.source === 'worktree').note === 'worktreeNeedsPath', 'worktree 来源要目录')
    ok(
      Model.reviewSourceOptions({ cwd: '' }).every((option) => !option.available),
      '无 cwd 时来源全部不可用'
    )

    const sessionQuery = Model.reviewQueryForSource('session', OWNER, { base: 'main' })
    ok(sessionQuery.sessionId === 's1' && sessionQuery.cwd === 'C:/work/repo', '会话来源查询带 sessionId 与 cwd')
    ok(sessionQuery.base === 'main', '附加基准透传')
    const uncommittedQuery = Model.reviewQueryForSource('uncommitted', OWNER)
    ok(uncommittedQuery.sessionId === undefined, '未提交来源不带 sessionId（归属由 scopeKey 区分）')
    const worktreeQuery = Model.reviewQueryForSource('worktree', OWNER, { worktreePath: 'C:/wt' })
    ok(worktreeQuery.worktreePath === 'C:/wt', 'worktree 目录透传')

    const sessionDiff = Model.reviewDiffQueryForChangeSet({ source: 'session', cwd: 'C:/work/repo' }, OWNER, 'src/app.ts')
    ok(sessionDiff?.sessionId === 's1' && sessionDiff.path === 'src/app.ts', '会话来源 diff 查询带 sessionId 与路径')
    ok(
      Model.reviewDiffQueryForChangeSet({ source: 'session', cwd: 'C:/work/repo' }, { ...OWNER, sessionId: undefined }, 'a.ts') === null,
      '会话来源缺 sessionId 时 diff 查询为空（fail-closed）'
    )
    const uncommittedDiff = Model.reviewDiffQueryForChangeSet({ source: 'uncommitted', cwd: 'C:/work/repo' }, OWNER, 'a.ts')
    ok(uncommittedDiff?.sessionId === undefined && uncommittedDiff.base === undefined, '非会话来源 diff 查询不带 sessionId')

    ok(
      Model.reviewOwnerKey(OWNER) !== Model.reviewOwnerKey({ ...OWNER, sessionId: 's2' }),
      '不同会话的归属键不同（切会话必须失效）'
    )

    {
      const gate = new Model.ReviewRequestGate()
      const id = gate.next()
      const result = await Model.guardedLoad(() => gate.isCurrent(id), async () => 'ok')
      ok(!result.stale && result.value === 'ok', '当前请求正常返回')
    }
    {
      const gate = new Model.ReviewRequestGate()
      const id = gate.next()
      const pending = Model.guardedLoad(() => gate.isCurrent(id), async () => {
        await delay(30)
        return 'late'
      })
      gate.invalidate()
      const result = await pending
      ok(result.stale === true && result.value === undefined, '切来源后迟到的 changeSet 结果被丢弃')
    }
    {
      const gate = new Model.ReviewRequestGate()
      const first = gate.next()
      const pending = Model.guardedLoad(() => gate.isCurrent(first), async () => {
        await delay(30)
        return 'first'
      })
      const second = gate.next()
      const old = await pending
      const fresh = await Model.guardedLoad(() => gate.isCurrent(second), async () => 'second')
      ok(old.stale === true && fresh.value === 'second', '后发请求顶掉更早的在途请求')
    }
    {
      const gate = new Model.ReviewRequestGate()
      const id = gate.next()
      const result = await Model.guardedLoad(() => gate.isCurrent(id), async () => {
        throw new Error('boom')
      })
      ok(!result.stale && result.error === 'boom', '当前请求的错误如实返回')
    }

    const anchors = Model.reviewLineAnchors(SAMPLE_PATCH)
    ok(anchors.newLines.join(',') === '1,2,3,4', '新侧真实行号来自补丁')
    ok(anchors.oldLines.join(',') === '1,2,3', '旧侧真实行号来自补丁')
    ok(anchors.minNew === 1 && anchors.maxNew === 4, '行号范围正确')
    ok(!anchors.binary, '文本补丁不是二进制')

    ok(Model.validateReviewAnchor(anchors, 'new', 2, 3).ok, '真实新侧行范围通过校验')
    ok(Model.validateReviewAnchor(anchors, 'old', 2, 3).ok, '真实旧侧行范围通过校验')
    ok(!Model.validateReviewAnchor(anchors, 'new', 2, 999).ok, '补丁外的行号被拒（不放假行锚）')
    ok(!Model.validateReviewAnchor(anchors, 'new', 3, 2).ok, '倒置范围被拒')
    ok(Model.validateReviewAnchor(anchors, 'file', 1, 1).ok, '整文件批注不要求行号落在补丁里')
    ok(Model.reviewLineAnchors('Binary files a/x and b/x differ\n').binary, '二进制补丁被识别')

    ok(Model.annotationIsStale(annotation({ anchorRevision: 'old' }), 'new'), '写后代码变化 → 批注过期')
    ok(!Model.annotationIsStale(annotation({ anchorRevision: 'rev' }), 'rev'), '版本一致不算过期')
    ok(!Model.annotationIsStale(annotation({ anchorRevision: '' }), 'rev'), '没有版本时不误判过期')

    const grouped = Model.groupAnnotationsByPath([
      annotation({ id: 'a', path: 'b.ts', lineStart: 9 }),
      annotation({ id: 'b', path: 'a.ts', lineStart: 5 }),
      annotation({ id: 'c', path: 'a.ts', lineStart: 2 })
    ])
    ok(grouped.get('a.ts').map((item) => item.id).join(',') === 'c,b', '按路径分组并按行号排序')

    ok(Model.classifyGitOutcome({ ok: true }) === 'ok', '成功动作归类 ok')
    ok(Model.classifyGitOutcome({ ok: false, code: 'gh-missing' }) === 'gh-missing', '缺 gh 归类')
    ok(Model.classifyGitOutcome({ ok: false, code: 'gh-not-authenticated' }) === 'gh-not-authenticated', '未登录归类')
    ok(Model.ghStatusDegrade({ ok: false, installed: false, authenticated: false }) === 'missing', 'gh 缺失降级')
    ok(Model.ghStatusDegrade({ ok: false, installed: true, authenticated: false }) === 'unauthenticated', 'gh 未登录降级')
    ok(Model.ghStatusDegrade({ ok: true, installed: true, authenticated: true }) === 'ready', 'gh 就绪')

    const suggested = Model.suggestedCommitMessage({
      ok: true,
      id: 'x',
      scopeKey: 'k',
      source: 'uncommitted',
      cwd: 'C:/w',
      repoRoot: 'C:/w',
      scope: '.',
      branch: 'feat/pkce',
      base: null,
      head: 'h',
      revision: 'r',
      truncated: false,
      generatedAt: 0,
      files: [
        { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true, untracked: false, added: 1, removed: 0, binary: false, annotations: 0 }
      ]
    })
    ok(suggested.includes('feat/pkce') && suggested.includes('src/a.ts'), '提交信息建议取材真实分支与文件')

    const parsed = Model.parseFindingsText('```json\n' + JSON.stringify([finding({ severity: 'low' }), finding({ severity: 'high' })]) + '\n```')
    ok(parsed.findings.length === 2 && parsed.findings[0].severity === 'high', '意见解析并按严重度排序')
    const bad = Model.parseFindingsText('这不是 JSON')
    ok(bad.findings.length === 0 && !!bad.error, '非 JSON 不猜成意见，给出错误')

    const bridge = mockBridge({
      changeSet: { ok: true, id: 'cs-1' },
      annotations: { ok: true, annotations: [annotation()], revision: 3 },
      annotationAdd: { ok: true, revision: 2, annotation: annotation() },
      annotationUpdate: { ok: true, revision: 3, annotation: annotation() },
      annotationRemove: { ok: true, revision: 4 },
      annotationClear: { ok: true, revision: 5 },
      diff: { ok: true, path: 'src/a.ts', patch: SAMPLE_PATCH, truncated: false, binary: false, staged: false, unstaged: false, untracked: false, bytes: 10 },
      annotationTask: { ok: true, message: 'M', count: 1 },
      start: { ok: true, changeSetId: 'cs-1', code: 'R04', status: 'started' },
      ghStatus: { ok: false, installed: false, authenticated: false },
      commit: { ok: true, commit: 'abc' },
      push: { ok: true },
      pullRequest: { ok: true, url: 'https://example.com/pr/1' }
    })
    ok(Client.resolveReviewBridge(bridge) === bridge, '注入的桥被原样使用')

    const csQuery = Model.reviewQueryForSource('uncommitted', OWNER)
    await Client.fetchChangeSet(bridge, csQuery)
    ok(bridge.calls[0].name === 'changeSet' && bridge.calls[0].args[0] === csQuery, 'changeSet 转发到正式方法')
    await Client.fetchAnnotationList(bridge, 'cs-1', 'scope-1')
    ok(bridge.calls[1].name === 'annotations' && bridge.calls[1].args[0] === 'cs-1' && bridge.calls[1].args[1] === 'scope-1', 'annotations 转发 id + scopeKey')
    await Client.fetchDiff(bridge, { source: 'uncommitted', cwd: 'C:/w', path: 'a.ts' })
    ok(bridge.calls[2].name === 'diff' && bridge.calls[2].args[0].path === 'a.ts', 'diff 转发单文件补丁查询')
    await Client.addAnnotation(bridge, { changeSetId: 'cs-1', scopeKey: 'scope-1', path: 'a.ts', lineStart: 2, body: 'x', anchorRevision: 'r' })
    ok(bridge.calls[3].name === 'annotationAdd' && bridge.calls[3].args[0].scopeKey === 'scope-1', 'annotationAdd 转发带 scopeKey 的输入')
    await Client.updateAnnotation(bridge, 'cs-1', 'scope-1', 'a1', { body: 'y' })
    ok(bridge.calls[4].name === 'annotationUpdate' && bridge.calls[4].args[0].id === 'a1' && bridge.calls[4].args[0].patch.body === 'y', 'annotationUpdate 转发 patch')
    await Client.removeAnnotation(bridge, 'cs-1', 'scope-1', 'a1')
    ok(bridge.calls[5].name === 'annotationRemove' && bridge.calls[5].args[0].id === 'a1', 'annotationRemove 转发 id')
    await Client.clearAnnotations(bridge, 'cs-1', 'scope-1')
    ok(bridge.calls[6].name === 'annotationClear', 'annotationClear 转发变更集')
    await Client.requestAnnotationTask(bridge, csQuery)
    ok(bridge.calls[7].name === 'annotationTask' && bridge.calls[7].args[0] === csQuery, 'annotationTask 用 query 由主进程重读')
    await Client.startReviewRun(bridge, { query: csQuery, model: 'commandcode/deepseek/deepseek-v4.1-flash' })
    ok(bridge.calls[8].name === 'start' && bridge.calls[8].args[0].model === 'commandcode/deepseek/deepseek-v4.1-flash', 'start 转发评分模型')
    await Client.fetchGhStatus(bridge, 'C:/w')
    ok(bridge.calls[9].name === 'ghStatus' && bridge.calls[9].args[0] === 'C:/w', 'ghStatus 转发 cwd')
    await Client.commitChanges(bridge, 'C:/w', 'msg')
    ok(bridge.calls[10].name === 'commit' && bridge.calls[10].args[0].cwd === 'C:/w' && bridge.calls[10].args[0].message === 'msg', 'commit 转发 cwd + message')
    await Client.pushChanges(bridge, { cwd: 'C:/w', remote: 'origin', branch: 'feat', setUpstream: true })
    ok(bridge.calls[11].name === 'push' && bridge.calls[11].args[0].setUpstream === true, 'push 转发窄目标')
    await Client.createPullRequest(bridge, { cwd: 'C:/w', base: 'main', head: 'feat', title: 'T', body: 'B', draft: true, remote: null })
    ok(bridge.calls[12].name === 'pullRequest' && bridge.calls[12].args[0].draft === true, 'pullRequest 转发标题 / 正文 / 草稿')
    await Client.fetchDiff(bridge, { source: 'session', cwd: 'C:/w', path: 'a.ts' })
    ok(bridge.calls.length === 13, 'session 来源缺 sessionId 时不发 diff 请求（fail-closed）')
    await Client.fetchDiff(bridge, { source: 'session', cwd: 'C:/w', path: 'a.ts', sessionId: 's1' })
    ok(bridge.calls[13].name === 'diff' && bridge.calls[13].args[0].sessionId === 's1', 'session 来源 diff 转发 sessionId')

    const findingsHtml = render(
      createElement(Page.ReviewFindingsPanel, {
        text: zh,
        status: 'ready',
        findings: [finding()],
        error: '',
        run: { ok: true, changeSetId: 'cs-1', code: 'R04', status: 'started' },
        runError: ''
      })
    )
    ok(findingsHtml.includes('data-testid="review-findings"') && findingsHtml.includes('R04'), '意见栏渲染 R 编号')
    ok(findingsHtml.includes('src/auth/oauth.ts:88') && findingsHtml.includes('code_verifier'), '意见栏渲染文件行与说明')
    ok(findingsHtml.includes(zh.severityHigh), '意见栏渲染严重度')
    ok(findingsHtml.includes(zh.runStarted('R04')), '意见栏说明 R 编号已登记')

    const unavailableHtml = render(
      createElement(Page.ReviewFindingsPanel, {
        text: zh,
        status: 'unavailable',
        findings: [],
        error: '',
        run: { ok: true, changeSetId: 'cs-1', code: 'R04', status: 'started' },
        runError: ''
      })
    )
    ok(unavailableHtml.includes('data-testid="review-findings-unavailable"'), '未接线时给出明确占位')
    ok(unavailableHtml.includes(zh.findingsUnavailable), '说明 R 事件 producer 待接线，不当作已完成')

    const wiringHtml = render(
      createElement(Page.ReviewFindingsPanel, {
        text: zh,
        status: 'idle',
        findings: [],
        error: '',
        run: { ok: false, changeSetId: 'cs-1', error: '评审运行尚未接线', requiredWiring: ['ReviewAgentPort'] },
        runError: ''
      })
    )
    ok(wiringHtml.includes('ReviewAgentPort') && wiringHtml.includes(zh.runWiring), '未装配时列出还差哪根线')

    const annotationsHtml = render(
      createElement(Page.ReviewAnnotationList, {
        text: zh,
        annotations: [annotation({ anchorRevision: 'old' }), annotation({ id: 'a2', anchorRevision: 'rev' })],
        changeSetRevision: 'rev',
        busy: false,
        onEdit: () => {},
        onRemove: () => {}
      })
    )
    ok(annotationsHtml.includes('data-testid="review-annotations"'), '批注列表渲染')
    ok(annotationsHtml.includes('data-stale="1"') && annotationsHtml.includes(zh.annotationStale), '代码变化后批注标记过期')
    ok(annotationsHtml.includes('src/app.ts:2-3'), '批注显示真实行范围')

    const pageBridge = mockBridge({ changeSet: { ok: true } })
    const pageHtml = render(
      createElement(
        i18n.I18nProvider,
        null,
        createElement(Page.ReviewPage, {
          bridge: pageBridge,
          owner: OWNER,
          lang: 'zh-CN',
          initialSource: 'session'
        })
      )
    )
    ok(pageHtml.includes('data-testid="v3-review-page"'), '页面根节点使用 v3-review-page')
    ok(pageHtml.includes(zh.title) && pageHtml.includes(zh.sourceLabel), '页面显示标题与来源选择')
    for (const source of ['session', 'branch', 'worktree', 'uncommitted']) {
      ok(pageHtml.includes(`data-testid="review-source-${source}"`), `来源选择含 ${source}`)
    }
    ok(pageHtml.includes('data-testid="review-session-note"') && pageHtml.includes(zh.sessionShareNote), '会话来源直接说明与未提交同源、不做精确归因')
    ok(pageHtml.includes(zh.commit) && pageHtml.includes(zh.push) && pageHtml.includes(zh.createPr), '底部 Git 操作入口都在')
    ok(pageHtml.includes(zh.startReview) && pageHtml.includes(zh.makeAnnotationTask), '评审运行与按批注修改入口都在')
    ok(pageBridge.calls.length === 0, 'SSR 首帧不自动调用任何 bridge 方法（不自动查真实 auth / git）')

    const enHtml = render(createElement(i18n.I18nProvider, null, createElement(Page.ReviewPage, { bridge: pageBridge, owner: OWNER, lang: 'en-US' })))
    ok(enHtml.includes(en.title) && !enHtml.includes(zh.title), '英文语言下用英文文案')

    const pageSrc = await readFile(join(process.cwd(), 'src/renderer/src/features/review/ReviewPage.tsx'), 'utf8')
    ok(pageSrc.includes("from '../../ui'"), '页面控件来自 v3 ui/ primitives')
    ok(pageSrc.includes("from './review-client'") && pageSrc.includes("from './review-model'"), '页面复用本地桥接与纯模型')
    ok(!pageSrc.includes("components/") && !pageSrc.includes("styles/"), '页面不引入 v2 组件或 styles/*')
    ok(pageSrc.includes('reviewLineAnchors') && pageSrc.includes('validateReviewAnchor'), '页面用真实行锚校验')
    ok(pageSrc.includes('anchorRevision: changeSet.revision'), '新批注带上写入时的变更集版本')
    ok(pageSrc.includes('scopeKey: changeSet.scopeKey'), '批注写入带归属键（后端据此防错归属）')
    ok(pageSrc.includes('csGate') && pageSrc.includes('diffGate') && pageSrc.includes('annGate'), 'changeSet / diff / annotations 各有请求闸门')
    ok(pageSrc.includes('suggestedCommitMessage') && pageSrc.includes('suggestedPullRequestTitle'), 'Git 动作有显式目标确认')

    const clientSrc = await readFile(join(process.cwd(), 'src/renderer/src/features/review/review-client.ts'), 'utf8')
    ok(clientSrc.includes('window') && clientSrc.includes('review'), '客户端缺省读 preload 暴露的 window.yan.review')
    ok(clientSrc.includes('bridge.changeSet(') && clientSrc.includes('bridge.commit(') && clientSrc.includes('bridge.pullRequest('), '客户端逐一转发正式方法')

    const css = await readFile(join(process.cwd(), 'src/renderer/src/features/review/review-page.css'), 'utf8')
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
    ok(css.startsWith('@layer features'), 'CSS 落在 features 层')
    ok(!cssCode.includes('@import') && !/@keyframes/.test(cssCode), 'CSS 不 @import、不自建关键帧')
    ok(!/styles\/|components\//.test(cssCode), 'CSS 不依赖 v2 样式目录')
    ok(cssCode.includes('minmax(0, 1fr)'), '弹性列使用 minmax(0, 1fr)')

    ok(zh.commit === '提交' && en.commit === 'Commit', '文案双语存在')

    console.log(`\nv3-review-ui: ${checks} checks passed`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
