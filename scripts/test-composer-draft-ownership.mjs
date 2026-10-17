import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

export async function runComposerDraftOwnershipTests(ok) {
  const section = (name) => console.log(`\n## ${name}`)

  const had = {
    window: 'window' in globalThis,
    document: 'document' in globalThis,
    localStorage: 'localStorage' in globalThis,
    requestAnimationFrame: 'requestAnimationFrame' in globalThis,
    cancelAnimationFrame: 'cancelAnimationFrame' in globalThis
  }
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  }

  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    fn(0)
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: { lang: 'zh-CN' },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
  const hadNavigator = 'navigator' in globalThis
  if (!hadNavigator) globalThis.navigator = { userAgent: 'node' }

  globalThis.window = {
    yan: new Proxy(
      {},
      {
        get: () => async () => undefined
      }
    ),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }

  const temp = await mkdtemp(join(tmpdir(), 'yan-composer-ownership-'))
  const bundle = async (entry, name) => {
    const outfile = join(temp, name)
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        requestAnimationFrame: 'globalThis.requestAnimationFrame',
        cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
      }
    })
    return import(pathToFileURL(outfile).href)
  }

  try {
    const { useStore } = await bundle('src/renderer/src/state/store.ts', 'store.mjs')
    const { composerSubmitIdentity, composerDraftForView } = await bundle('src/renderer/src/state/composer-recovery.ts', 'composer-recovery.mjs')
    const { submitComposerInput } = await bundle('src/renderer/src/lib/composer-submit.ts', 'composer-submit.mjs')

    const runtimeSnapshot = (sessionId, runId, generation, draft, sessionFile, draftAttachments = []) => ({
      runtime: { sessionId, runId, generation },
      session: { sessionId, sessionFile, cwd: 'C:/p' },
      messages: [],
      stats: null,
      queue: { steering: [], followUp: [] },
      todos: [],
      todoHistory: [],
      uiRequests: [],
      statuses: {},
      widgets: {},
      widgetPlacements: {},
      draft,
      draftAttachments,
      goal: null,
      models: [],
      thinkingLevels: [],
      commands: [],
      touchedAt: 1
    })

    const img = (id) => ({
      id,
      kind: 'image',
      name: `${id}.png`,
      mimeType: 'image/png',
      size: 4,
      data: 'AAAA',
      preview: 'data:image/png;base64,AAAA'
    })
    const fileRef = (id, path) => ({
      id,
      kind: 'file',
      name: id,
      mimeType: '',
      size: 0,
      data: '',
      preview: '',
      path
    })

    const setView = (overrides = {}) =>
      useStore.setState({
        session: null,
        peekedSessionId: null,
        peekedPath: null,
        activeRunnerId: null,
        runners: [],
        sessionRuntimes: {},
        attachments: [],
        queueRestore: null,
        notices: [],
        ...overrides
      })

    const viewA = (extra = {}) =>
      setView({
        session: { sessionId: 'A', sessionFile: 'A', cwd: 'C:/p' },
        peekedSessionId: 'A',
        peekedPath: 'A',
        activeRunnerId: 'rA',
        runners: [{ id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'A', generation: 1 }],
        sessionRuntimes: { A: runtimeSnapshot('A', 'rA', 1, 'A-old', 'A') },
        ...extra
      })

    const viewB = () => {
      const runtimes = useStore.getState().sessionRuntimes
      setView({
        session: { sessionId: 'B', sessionFile: 'B', cwd: 'C:/p' },
        peekedSessionId: 'B',
        peekedPath: 'B',
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'B', generation: 1 }],
        sessionRuntimes: { ...runtimes, B: runtimeSnapshot('B', 'rB', 1, 'B-old', 'B') }
      })
    }

    function makePort({ text = '', onBash, onSend } = {}) {
      const view = useStore.getState()
      const identity = composerSubmitIdentity(view)
      const attachmentsAtSubmit = view.attachments
      const box = { text }
      const recover = (recoveredText, saved) => {
        useStore.getState().recoverComposerInput({ identity, text: recoveredText, attachments: saved })
      }
      return {
        get text() {
          return box.text
        },
        get attachments() {
          return useStore.getState().attachments
        },
        commands: [],
        models: [],
        t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
        actions: {
          runBash: async (cmd, options) => (onBash ? onBash(cmd, options) : { ok: true }),
          openSettings: () => {},
          newSession: () => {},
          compact: () => {},
          openBrowser: () => {},
          setModel: () => {},
          exportHtml: () => {},
          copyLastReply: () => {},
          clone: () => {},
          setManualTitle: () => {},
          setThinking: () => {},
          notify: () => {}
        },
        session: null,
        thinkingLevels: [],
        roundRunning: false,
        isCompacting: false,
        clearText: () => {
          box.text = ''
        },
        clearAll: () => {
          box.text = ''
          useStore.getState().clearAttachments()
        },
        restoreText: (raw) => recover(raw, []),
        restoreAttachments: (saved) => recover('', saved),
        readAttachments: () => attachmentsAtSubmit,
        send: async (outgoing, images, mode) => (onSend ? onSend(outgoing, images, mode) : true),
        holdSend: () => {},
        focusComposer: () => {},
        __box: box
      }
    }

    section('`!` A→B→失败：命令回 A 的草稿缓存，不动 B')
    {
      viewA({ attachments: [img('a1')] })
      const port = makePort({
        text: '!deploy A',
        onBash: () => {
          viewB()
          return { ok: false, error: 'boom' }
        }
      })
      const outcome = await submitComposerInput(port)
      const after = useStore.getState()
      ok(outcome === 'handled', '`!` 失败仍返回 handled', outcome)
      ok(after.queueRestore === null, '切到 B 后不把 A 的命令塞进 B 输入框', JSON.stringify(after.queueRestore))
      ok((after.sessionRuntimes.A?.draft ?? '').includes('!deploy A'), 'A 的命令写回 A 的草稿缓存', JSON.stringify(after.sessionRuntimes.A?.draft))
      ok((after.sessionRuntimes.A?.draft ?? '').includes('A-old'), '追加不覆盖 A 原有草稿', JSON.stringify(after.sessionRuntimes.A?.draft))
      ok(!(after.sessionRuntimes.B?.draft ?? '').includes('!deploy A'), 'B 的草稿缓存没被写脏', JSON.stringify(after.sessionRuntimes.B?.draft))
      ok(after.attachments.length === 0, 'B 的附件区没有被 A 的附件污染', JSON.stringify(after.attachments))
      useStore.setState({ session: { sessionId: 'A', sessionFile: 'A', cwd: 'C:/p' }, peekedSessionId: 'A', peekedPath: 'A' })
      ok((useStore.getState().sessionRuntimes.A?.draft ?? '').includes('!deploy A'), '切回 A 草稿缓存里能取回命令')
    }

    section('普通发送 A→B→失败：附件缓存回 A，切回完整取回，不污染 B')
    {
      viewA({ attachments: [img('a1'), fileRef('f1', 'C:/p/readme.md')] })
      const port = makePort({
        text: '发给 A 的话',
        onSend: () => {
          viewB()
          return false
        }
      })
      const outcome = await submitComposerInput(port)
      const after = useStore.getState()
      ok(outcome === 'sent', '普通发送失败仍返回 sent', outcome)
      ok(after.queueRestore === null, 'B 输入框不收到 A 的迟到文字', JSON.stringify(after.queueRestore))
      ok(after.attachments.length === 0, 'A 的图片/文件引用没有并进 B', JSON.stringify(after.attachments))
      ok((after.sessionRuntimes.A?.draft ?? '').includes('发给 A 的话'), 'A 的文字写回 A 的草稿缓存', JSON.stringify(after.sessionRuntimes.A?.draft))
      const cached = after.sessionRuntimes.A?.draftAttachments ?? []
      ok(cached.some((a) => a.id === 'a1') && cached.some((a) => a.id === 'f1'), 'A 的图片与 fileRef 都缓存回 A', JSON.stringify(cached.map((a) => a.id)))
      ok(cached.find((a) => a.id === 'f1')?.path === 'C:/p/readme.md', 'fileRef 的 path 完整缓存', JSON.stringify(cached.find((a) => a.id === 'f1')))
      ok(!after.notices.some((n) => /附件/.test(n.text)), '附件已缓存，不再提示丢弃', JSON.stringify(after.notices))

      useStore.setState({
        session: { sessionId: 'A', sessionFile: 'A', cwd: 'C:/p' },
        peekedSessionId: 'A',
        peekedPath: 'A',
        activeRunnerId: 'rA',
        runners: [{ id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'A', generation: 1 }]
      })
      useStore.getState().hydrateComposerDraft('A')
      const restored = useStore.getState().attachments
      ok(restored.some((a) => a.id === 'a1') && restored.some((a) => a.id === 'f1'), '回 A 完整取回图片与 fileRef', JSON.stringify(restored.map((a) => a.id)))
      ok(restored.find((a) => a.id === 'f1')?.path === 'C:/p/readme.md', '取回的 fileRef path 不变', JSON.stringify(restored.find((a) => a.id === 'f1')))
      ok(restored.length === 2, '取回不重复', JSON.stringify(restored.map((a) => a.id)))

      useStore.getState().hydrateComposerDraft('A')
      ok(useStore.getState().attachments.length === 2, '再次 hydrate 不重复堆叠', JSON.stringify(useStore.getState().attachments.map((a) => a.id)))

      useStore.getState().clearAttachments()
      useStore.getState().hydrateComposerDraft('A')
      ok(useStore.getState().attachments.length === 0, '成功发送后再次 hydrate 不复活旧附件', JSON.stringify(useStore.getState().attachments.map((a) => a.id)))
    }

    section('纯 helper 与 store hydrate 一致：从真实 store 缓存按草稿键取回')
    {
      viewA({ attachments: [img('a1'), fileRef('f1', 'C:/p/readme.md')] })
      const port = makePort({
        text: 'x',
        onSend: () => {
          viewB()
          return false
        }
      })
      await submitComposerInput(port)
      const snap = composerDraftForView(useStore.getState(), 'A')
      ok(snap.text.includes('x') && snap.attachments.length === 2, 'composerDraftForView 从真实 store 缓存读出文字与附件', JSON.stringify(snap))
      useStore.getState().hydrateComposerDraft('A')
      ok(useStore.getState().attachments.length === snap.attachments.length, 'store hydrate 与纯 helper 结果一致')
    }

    section('B 保留自己的附件：A 的跨会话恢复不污染 B 的草稿附件')
    {
      viewA({ attachments: [img('a1')] })
      const port = makePort({
        text: '给 A',
        onSend: () => {
          viewB()
          return false
        }
      })
      await submitComposerInput(port)
      useStore.setState({
        sessionRuntimes: {
          ...useStore.getState().sessionRuntimes,
          B: runtimeSnapshot('B', 'rB', 1, 'B-old', 'B', [img('b1')])
        }
      })
      useStore.getState().hydrateComposerDraft('B')
      const bAtt = useStore.getState().attachments
      ok(bAtt.length === 1 && bAtt[0].id === 'b1', 'B 取回自己的附件', JSON.stringify(bAtt.map((a) => a.id)))
      ok(!bAtt.some((a) => a.id === 'a1'), 'B 的附件区没有 A 的附件', JSON.stringify(bAtt.map((a) => a.id)))
    }

    section('同会话成功：清掉提交的附件缓存，保留 await 期间新添附件，不复活旧附件')
    {
      viewA({ attachments: [img('a1')] })
      const port = makePort({
        text: '成功发送',
        onSend: () => {
          useStore.getState().addAttachments([fileRef('a2', 'C:/p/a2.md')])
          return true
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.attachments.length === 1 && after.attachments[0].id === 'a2', '提交的 a1 已清，await 期间新添的 a2 保留', JSON.stringify(after.attachments.map((a) => a.id)))
      useStore.getState().hydrateComposerDraft('A')
      const cached = useStore.getState().attachments
      ok(cached.length === 1 && cached[0].id === 'a2', '再次 hydrate 只取回未发送的 a2，不复活 a1', JSON.stringify(cached.map((a) => a.id)))
    }

    section('附件移除：写入草稿缓存，hydrate 不复活已移除附件')
    {
      viewA({ attachments: [img('a1'), fileRef('f1', 'C:/p/readme.md')] })
      useStore.getState().removeAttachment('a1')
      ok(useStore.getState().attachments.length === 1, '移除后输入框只剩 f1', JSON.stringify(useStore.getState().attachments.map((a) => a.id)))
      useStore.getState().hydrateComposerDraft('A')
      const cached = useStore.getState().attachments
      ok(cached.length === 1 && cached[0].id === 'f1', 'hydrate 不复活已移除的 a1', JSON.stringify(cached.map((a) => a.id)))
    }

    section('仅路径 deferred 跨会话失败：写薄路径键，不盲写活动 runner B')
    {
      setView({
        session: null,
        peekedSessionId: null,
        peekedPath: 'A',
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'B', generation: 1 }],
        sessionRuntimes: {},
        attachments: [img('a1')]
      })
      const port = makePort({
        text: '!path cross',
        onBash: () => {
          setView({
            session: { sessionId: 'B', sessionFile: 'B', cwd: 'C:/p' },
            peekedSessionId: 'B',
            peekedPath: 'B',
            activeRunnerId: 'rB',
            runners: [{ id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'B', generation: 1 }],
            sessionRuntimes: {}
          })
          return { ok: false, error: 'fail' }
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === null, '不把 A 的命令塞进 B 输入框', JSON.stringify(after.queueRestore))
      ok((after.sessionRuntimes['file:a']?.draft ?? '').includes('!path cross'), '文字写到薄路径键', JSON.stringify(after.sessionRuntimes['file:a']?.draft))
      ok((after.sessionRuntimes['file:a']?.draftAttachments ?? []).some((a) => a.id === 'a1'), '附件写到薄路径键', JSON.stringify(after.sessionRuntimes['file:a']?.draftAttachments))
      ok(after.sessionRuntimes['run:rB'] === undefined, '没有把 A 的东西写进活动 runner B 的键', JSON.stringify(Object.keys(after.sessionRuntimes)))

      useStore.setState({ session: null, peekedSessionId: null, peekedPath: 'A', attachments: [] })
      useStore.getState().hydrateComposerDraft('file:a')
      const restored = useStore.getState().attachments
      ok(restored.some((a) => a.id === 'a1'), '回到路径 A 取回附件', JSON.stringify(restored.map((a) => a.id)))
    }

    section('同会话失败：queueRestore 追加，保留 await 期间新输入；图片与 fileRef 都回来')
    {
      viewA({ attachments: [img('a1'), fileRef('f1', 'C:/p/readme.md')] })
      const port = makePort({
        text: '重试前的话',
        onSend: () => {
          port.__box.text = '新敲的内容'
          return false
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === '重试前的话', '失败文字进 queueRestore', JSON.stringify(after.queueRestore))
      const composed = after.queueRestore ? `${after.queueRestore}\n${port.__box.text}` : port.__box.text
      ok(composed === '重试前的话\n新敲的内容', '恢复后输入框保留 await 期间新输入且顺序正确', JSON.stringify(composed))
      const ids = after.attachments.map((a) => a.id)
      ok(ids.includes('a1') && ids.includes('f1'), '图片与 fileRef 都放回', JSON.stringify(ids))
      ok(after.attachments.find((a) => a.id === 'f1')?.path === 'C:/p/readme.md', 'fileRef 的 path 完整保留', JSON.stringify(after.attachments.find((a) => a.id === 'f1')))
      ok(after.attachments.length === 2, '附件不重复', JSON.stringify(ids))
    }

    section('同会话附件已存在：按 id 去重，不重复')
    {
      const existing = img('dup')
      viewA({ attachments: [existing] })
      const port = makePort({
        text: '!echo dup',
        onBash: () => ({ ok: false, error: 'fail' })
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.attachments.filter((a) => a.id === 'dup').length === 1, '同一附件不重复堆叠', JSON.stringify(after.attachments))
    }

    section('pending→uuid 仍算原会话：回填输入框，不新建脏会话')
    {
      setView({
        session: { sessionId: 'pending:rA', sessionFile: 'A', cwd: 'C:/p' },
        peekedSessionId: 'pending:rA',
        peekedPath: 'A',
        activeRunnerId: 'rA',
        runners: [{ id: 'rA', runId: 'rA', sessionId: 'pending:rA', sessionFile: 'A', generation: 1 }],
        sessionRuntimes: { 'run:rA': runtimeSnapshot('pending:rA', 'rA', 1, '', 'A') },
        attachments: []
      })
      const port = makePort({
        text: '!pending cmd',
        onBash: () => {
          useStore.setState({
            session: { sessionId: 'A', sessionFile: 'A', cwd: 'C:/p' },
            peekedSessionId: 'A',
            peekedPath: 'A',
            runners: [{ id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'A', generation: 1 }]
          })
          return { ok: false, error: 'fail' }
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === '!pending cmd', 'pending→uuid 过渡仍判为原会话，回填输入框', JSON.stringify(after.queueRestore))
      ok(after.sessionRuntimes['pending:rA'] === undefined, '没有把草稿写到过期 pending 键', Object.keys(after.sessionRuntimes).join(','))
    }

    section('pending→uuid 后切到 B：写回 uuid 键，不是 pending 也不是 B')
    {
      setView({
        session: { sessionId: 'pending:rA', sessionFile: 'A', cwd: 'C:/p' },
        peekedSessionId: 'pending:rA',
        peekedPath: 'A',
        activeRunnerId: 'rA',
        runners: [{ id: 'rA', runId: 'rA', sessionId: 'pending:rA', sessionFile: 'A', generation: 1 }],
        sessionRuntimes: { 'run:rA': runtimeSnapshot('pending:rA', 'rA', 1, '', 'A') },
        attachments: []
      })
      const port = makePort({
        text: '!into A',
        onBash: () => {
          const runtimes = useStore.getState().sessionRuntimes
          setView({
            session: { sessionId: 'B', sessionFile: 'B', cwd: 'C:/p' },
            peekedSessionId: 'B',
            peekedPath: 'B',
            activeRunnerId: 'rB',
            runners: [
              { id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'A', generation: 1 },
              { id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'B', generation: 1 }
            ],
            sessionRuntimes: {
              ...runtimes,
              A: runtimeSnapshot('A', 'rA', 1, '', 'A'),
              B: runtimeSnapshot('B', 'rB', 1, 'B-old', 'B')
            }
          })
          return { ok: false, error: 'fail' }
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === null, '切到 B 后不塞输入框', JSON.stringify(after.queueRestore))
      ok((after.sessionRuntimes.A?.draft ?? '').includes('!into A'), '落进 A 的真实 uuid 草稿键', JSON.stringify(after.sessionRuntimes.A?.draft))
      ok(after.sessionRuntimes['pending:rA'] === undefined, '不写 pending 键')
      ok(!(after.sessionRuntimes.B?.draft ?? '').includes('!into A'), '不写 B 的草稿', JSON.stringify(after.sessionRuntimes.B?.draft))
    }

    section('仅路径 deferred：仍算原会话（不误认 activeRunner B）')
    {
      setView({
        session: null,
        peekedSessionId: null,
        peekedPath: 'A',
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'B', generation: 1 }],
        sessionRuntimes: {},
        attachments: [img('a1')]
      })
      const port = makePort({
        text: '!path only',
        onBash: () => ({ ok: false, error: 'fail' })
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === '!path only', '只有路径时仍判为原会话，回填输入框', JSON.stringify(after.queueRestore))
      ok(after.attachments.some((a) => a.id === 'a1'), '附件回到输入框', JSON.stringify(after.attachments))
      ok((after.sessionRuntimes.B?.draft ?? '') === '', '没有把 A 的命令写进 B')
    }

    section('实例被复用到新代次：不算原会话，不串新会话')
    {
      viewA({ attachments: [] })
      const port = makePort({
        text: '!stale gen',
        onBash: () => {
          setView({
            session: { sessionId: 'C', sessionFile: 'C', cwd: 'C:/p' },
            peekedSessionId: 'C',
            peekedPath: 'C',
            activeRunnerId: 'rA',
            runners: [{ id: 'rA', runId: 'rA', sessionId: 'C', sessionFile: 'C', generation: 2 }],
            sessionRuntimes: { C: runtimeSnapshot('C', 'rA', 2, '', 'C') }
          })
          return { ok: false, error: 'fail' }
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === null, '实例复用后旧代次不塞进新会话输入框', JSON.stringify(after.queueRestore))
      ok(!(after.sessionRuntimes.C?.draft ?? '').includes('!stale gen'), '不把旧代次恢复写进复用后的新会话 C', JSON.stringify(after.sessionRuntimes.C?.draft))
    }

    section('非 pending sessionId 与当前不一致：不按旧 run 误认，写回原 A')
    {
      viewA({ attachments: [] })
      const port = makePort({
        text: '!same gen',
        onBash: () => {
          setView({
            session: null,
            peekedSessionId: null,
            peekedPath: null,
            activeRunnerId: 'rA',
            runners: [{ id: 'rA', runId: 'rA', sessionId: 'B', sessionFile: 'B', generation: 1 }],
            sessionRuntimes: { B: runtimeSnapshot('B', 'rA', 1, 'B-old', 'B') }
          })
          return { ok: false, error: 'fail' }
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === null, '不把 A 的命令塞进当前输入框', JSON.stringify(after.queueRestore))
      ok((after.sessionRuntimes.A?.draft ?? '').includes('!same gen'), '按原来的非 pending sessionId 写回 A', JSON.stringify(after.sessionRuntimes.A?.draft))
      ok(!(after.sessionRuntimes.B?.draft ?? '').includes('!same gen'), '不写进被挂上的 B', JSON.stringify(after.sessionRuntimes.B?.draft))
    }

    section('runBash 抛异常也走同一恢复端口')
    {
      viewA({ attachments: [] })
      const port = makePort({
        text: '!boom',
        onBash: () => {
          throw new Error('通道断开')
        }
      })
      await submitComposerInput(port)
      const after = useStore.getState()
      ok(after.queueRestore === '!boom', '抛异常时文字回到输入框', JSON.stringify(after.queueRestore))
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (had[key]) globalThis[key] = value
      else delete globalThis[key]
    }
  }
}

async function main() {
  let passed = 0
  let failed = 0
  await runComposerDraftOwnershipTests((cond, label, detail) => {
    if (cond) {
      passed += 1
      console.log(`  [ok] ${label}`)
    } else {
      failed += 1
      console.error(`  [FAIL] ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
    }
  })
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
