import assert from 'node:assert/strict'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createFailedImageCache, createRemoteImageCache } = await compile('src/renderer/src/features/session/message-cache.ts')
  const { createMarkdownPathCache } = await compile('src/renderer/src/features/session/markdown-path-cache.ts')
  const { buildContentMatches } = await compile('src/renderer/src/features/sidebar/content-search.ts')
  const { createCompletionScopeSelector, completionRequestKey } = await compile('src/renderer/src/features/composer/completion-scope.ts')

  const failed = createFailedImageCache()
  for (let index = 0; index < 256; index++) failed.add(`file:///image-${index}.png`)
  failed.has('file:///image-0.png')
  failed.add('file:///next.png')
  ok(failed.has('file:///image-0.png') && !failed.has('file:///image-1.png'), '失败图片按最近访问淘汰，最多 256 项')
  failed.delete('file:///image-0.png')
  ok(!failed.has('file:///image-0.png'), '再次加载成功后清除该图片的失败记录')
  const failedByChars = createFailedImageCache()
  const longSource = (index) => `data:image/png;base64,${index}:` + 'a'.repeat(4_000)
  for (let index = 0; index < 32; index++) failedByChars.add(longSource(index))
  const oversizeSource = 'data:image/png;base64,' + 'b'.repeat(4_096)
  failedByChars.add(oversizeSource)
  ok(!failedByChars.has(longSource(0)) && failedByChars.has(longSource(31)) && !failedByChars.has(oversizeSource), '失败记录受总字符和单项大小约束，不持有大型 data URL')

  const remote = createRemoteImageCache()
  for (let index = 0; index < 32; index++) remote.set(`url-${index}`, `data-${index}`)
  remote.get('url-0')
  remote.set('new-url', 'new-data')
  ok(remote.get('url-0') === 'data-0' && remote.get('url-1') === undefined, '远程图片缓存 32 项上限且命中续期')
  const remoteByChars = createRemoteImageCache()
  const large = 'a'.repeat(8_000_000)
  remoteByChars.set('first', large)
  remoteByChars.set('second', large)
  remoteByChars.set('oversized', 'b'.repeat(16_000_000))
  ok(remoteByChars.get('first') === undefined && remoteByChars.get('second') === large && remoteByChars.get('oversized') === undefined, '远程图片按键和 data URL 总字符淘汰，超大项不挤掉现有命中')
  remoteByChars.set('second', 'replaced')
  remoteByChars.set('third', large)
  ok(remoteByChars.get('second') === 'replaced' && remoteByChars.get('third') === large, '替换缓存项正确释放旧项字符预算')

  let clock = 0
  const paths = createMarkdownPathCache(2, 128, () => clock)
  const weight = (result) => result.length
  let resolveOld
  const old = paths.load('same', () => new Promise((resolve) => { resolveOld = resolve }), weight)
  assert.strictEqual(paths.load('same', () => assert.fail('请求未去重'), weight), old)
  await paths.load('hot', async () => 'hit', weight)
  await paths.load('new', async () => null, weight)
  assert.equal(paths.get('same'), undefined)
  await paths.load('same', async () => 'new result', weight)
  resolveOld(null)
  ok(await old === null && paths.get('same') === 'new result', '并发 stat 去重；被淘汰的旧请求可返回给调用方，但不写回覆盖新项')
  clock = 2_999
  assert.equal(paths.get('new'), null)
  clock = 3_000
  ok(paths.get('new') === undefined && paths.get('same') === 'new result', '仅负缓存按 3 秒过期')
  await assert.rejects(paths.load('reject', async () => { throw Error('fail') }, weight), /fail/)
  ok(paths.get('reject') === undefined, '拒绝的 stat 请求不会留在缓存中')
  const shortPaths = createMarkdownPathCache(5, 10)
  await shortPaths.load('a', async () => '123456', weight)
  await shortPaths.load('b', async () => '789012', weight)
  const tooLong = await shortPaths.load('c', async () => '01234567890', weight)
  ok(shortPaths.get('a') === undefined && shortPaths.get('b') === '789012' && tooLong.length === 11 && shortPaths.get('c') === undefined, '路径和解析结果共用字符预算，超大结果返回但不留存')

  let pathReads = 0
  const row = { id: 'first', title: '原题', get path() { pathReads++; return 'E:\\Chat\\one.jsonl' } }
  const sessions = [row, { id: 'duplicate', path: 'e:/chat/one.jsonl' }]
  const search = (list) => buildContentMatches({
    sessions: list,
    hits: ['E:/CHAT/shown.jsonl', 'e:/chat/one.jsonl', 'E:\\CHAT\\ONE.jsonl', 'e:/chat/missing.jsonl'].map((path) => ({ path, updatedAt: 1, snippet: '词' })),
    shownPaths: ['e:\\chat\\shown.jsonl'],
    titleOf: (item) => item.title,
    fallbackTitle: () => '未命名'
  })
  const matches = search(sessions)
  assert.deepEqual(matches.map(({ id, title }) => [id, title]), [['first', '原题'], [null, '未命名']])
  const firstReads = pathReads
  assert.deepEqual(search(sessions), matches)
  ok(pathReads - firstReads === 1, '同一会话列表复用路径索引，只读命中项；保留大小写去重和首条记录匹配')
  ok(search([{ id: 'new', path: 'e:/chat/one.jsonl', title: '新标题' }])[0].id === 'new', '切换会话列表后不使用旧索引')

  let sessionPathReads = 0
  const selectScope = createCompletionScopeSelector()
  const state = {
    activeRunnerId: 'runner',
    runners: [{ id: 'legacy', runId: 'runner', generation: 2 }],
    sessions: [{ id: 'unknown', get path() { sessionPathReads++; return 'E:/s.jsonl' } }],
    session: { sessionId: 'sid', sessionFile: 'E:/s.jsonl', cwd: 'e:/work/' },
    settings: { projects: [{ id: 'project', cwd: 'E:/work' }] }
  }
  const scope = selectScope(state)
  assert.equal(scope.activeProjectId, 'project')
  for (let index = 0; index < 100; index++) {
    assert.strictEqual(selectScope({ ...state, session: { ...state.session, messageCount: index }, messages: ['chunk'] }), scope)
  }
  ok(sessionPathReads === 1, '100 次无关流式更新复用同一 completion scope，不扫描会话列表')
  ok(selectScope({ ...state, runners: [{ ...state.runners[0] }], sessions: [...state.sessions] }) === scope, '列表对象刷新但会话作用域不变时 selector 输出引用稳定')
  const switched = selectScope({ ...state, runners: [{ ...state.runners[0], generation: 3, projectId: 'runner-project' }] })
  ok(switched.activeProjectId === 'runner-project' && completionRequestKey(switched, 'file') !== completionRequestKey(scope, 'file'), '运行代际或项目变化使旧补全请求失效')
  const global = selectScope({ ...state, sessions: [{ id: 'sid', path: 'E:/s.jsonl', scope: 'global', projectId: 'ignored' }] })
  ok(global.activeProjectId === undefined && completionRequestKey(global, 'file') !== completionRequestKey(scope, 'file'), '全局会话不会误匹配同目录项目')
  const otherSession = selectScope({ ...state, session: { ...state.session, sessionId: 'other', sessionFile: 'E:/other.jsonl' } })
  ok(completionRequestKey(otherSession, 'file') !== completionRequestKey(scope, 'file') && completionRequestKey(scope, 'file2') !== completionRequestKey(scope, 'file'), '切换会话或补全查询使旧结果失效')
})
