import './lib/test-isolate.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  })) process.env[key] = value

  const mod = await compile(null, {
    stdin: {
      contents: "export { createIsolationView } from './src/main/isolation-view.ts'\nexport { AutoIsolationStore } from './src/main/session-isolation.ts'\n",
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    external: ['electron']
  })

  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const gitc = (cwd, args) => git(cwd, ['-c', 'user.name=yan-test', '-c', 'user.email=yan-test@example.com', ...args])
  const until = async (check, ms = 5000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) return false
      await new Promise((done) => setTimeout(done, 20))
    }
    return true
  }

  const root = mkdtempSync(join(tmpdir(), 'yan-iso-view-'))
  try {
    const repo = join(root, 'repo')
    const sessions = join(root, 'sessions')
    const storeRoot = join(root, 'store')
    mkdirSync(repo)
    mkdirSync(sessions)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, ['add', '-A'])
    gitc(repo, ['commit', '-q', '-m', 'init', '--no-verify'])

    const make = (overrides = {}) => {
      const statuses = []
      const changes = []
      let busy = false
      let windowState = { isDestroyed: () => false }
      const view = mod.createIsolationView({
        registry: () => ({
          statuses: () => statuses,
          agentOf: () => null,
          stopOne: async () => true,
          hasBusyCwd: () => busy
        }),
        window: () => windowState,
        isVisible: () => false,
        sessionsDir: sessions,
        publishStatus: (text) => changes.push(text),
        onChange: () => changes.push('runners'),
        store: new mod.AutoIsolationStore({ root: storeRoot }),
        ...overrides
      })
      return { view, changes, setBusy: (value) => { busy = value }, setWindow: (value) => { windowState = value } }
    }

    const first = make()
    const opened = await first.view.openWorktree(repo)
    ok(opened.ok && existsSync(opened.cwd), '开工作树：返回会话目录且目录已建')
    ok(first.view.of(opened.cwd)?.state === 'waiting' && first.view.of(opened.cwd)?.branch === opened.branch, '新工作树先显示为等待')
    ok(first.changes.includes(undefined) && first.changes.includes('runners'), '视图变化时发布状态并刷新实例列表')
    const listed = await first.view.worktrees()
    ok(listed.length === 1 && listed[0].cwd === opened.cwd && listed[0].branch === opened.branch, '列出已登记的工作树')
    await first.view.bindSession(opened.cwd, 'session-1')
    ok((await first.view.recordFor(opened.cwd))?.sessionId === 'session-1', '会话与工作树绑定后能按目录找回记录')
    ok((await first.view.recordFor(join(root, 'nowhere'))) === null, '未登记目录找不到记录')
    const before = first.changes.length
    await first.view.discardUnused()
    ok(existsSync(opened.cwd) && first.changes.length === before, '刚建好的工作树不被当作未使用而丢弃')

    writeFileSync(join(opened.cwd, 'b.txt'), 'b\n')
    const dirty = make()
    await dirty.view.initialize()
    ok(dirty.view.of(opened.cwd)?.state === 'waiting', '启动时按记录先显示等待')
    ok(await until(() => dirty.view.of(opened.cwd)?.state === 'ready'), '有未合并改动的工作树刷新后显示就绪')
    ok(dirty.changes.some((text) => typeof text === 'string' && /1/.test(text)), '有未合并改动时状态栏给出数量')

    const busy = make()
    busy.setBusy(true)
    await busy.view.initialize()
    await new Promise((done) => setTimeout(done, 300))
    ok(busy.view.of(opened.cwd)?.state === 'waiting', '目录仍在运行时保持等待，不提示合并')

    const closed = make()
    closed.setWindow({ isDestroyed: () => true })
    await closed.view.initialize()
    await new Promise((done) => setTimeout(done, 300))
    ok(closed.view.of(opened.cwd)?.state === 'waiting', '窗口已销毁时不再刷新')

    const noRegistry = make({ registry: () => null })
    await noRegistry.view.discardUnused()
    ok(noRegistry.changes.length === 0, '实例注册表未就绪时不清理')

    const store = new mod.AutoIsolationStore({ root: storeRoot })
    const gone = make({ store })
    await gone.view.initialize()
    ok(await until(() => gone.view.of(opened.cwd)?.state === 'ready'), '刷新前视图已就绪')
    await store.remove(opened.cwd)
    gone.view.scheduleRefresh()
    ok(await until(() => gone.view.of(opened.cwd) === undefined, 6000), '记录移除后下一次刷新不再显示该工作树')
    ok(gone.changes.at(-2) === undefined && gone.changes.at(-1) === 'runners', '最后一个待合并工作树消失后清空状态栏')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
