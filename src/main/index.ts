/**
 * 主进程入口：窗口 + IPC + AgentController 的生命周期。
 *
 * 一个窗口 = 一个 AgentController = 一个 pi 子进程。
 * 会话切换走 pi 自己的 switch_session，不开新进程（进程很贵）。
 */
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname, basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentController } from './agent'
import { cachedTitles } from './title'
import { MemoryStore, YAN_DIR, readSoul } from './memory'
import { getSettings, patchSettings } from './settings'
import { listSessions, deleteSession } from './sessions'
import { resolvePi } from './protocol'
import type { Attachment, MainPush } from '../shared/ipc'

const __dirname_ = fileURLToPath(new URL('.', import.meta.url))

/* ------------------------------------------------------------------
   测试隔离：YAN_USER_DATA 指向临时目录时，把 Electron 的 userData
   （localStorage / sessionData / cache）也搬过去。

   为什么需要：右栏分区顺序、主题、语言都存在 localStorage 里。
   验收测试会改这些 —— 共用一个 userData 就会把用户的设置改掉
   （已经踩过一次：测试把右栏顺序弄成了 status 开头）。

   注意：必须放在 app.whenReady() 之前。
   ------------------------------------------------------------------ */
if (process.env.YAN_USER_DATA) {
  app.setPath('userData', process.env.YAN_USER_DATA)
}

/* ------------------------------------------------------------------
   全局状态
   ------------------------------------------------------------------ */
let win: BrowserWindow | null = null
let agent: AgentController | null = null
const memory = new MemoryStore()

/** 打包后扩展在 resources/ 下；开发期在仓库的 resources/pi/ 下 */
function extensionPath(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'pi', 'yan-memory.ts'),
    join(__dirname_, '../../resources/pi/yan-memory.ts'),
    join(app.getAppPath(), 'resources/pi/yan-memory.ts')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return candidates[1]
}

function push(msg: MainPush): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('yan:push', msg)
}

/**
 * 退出前的清理。
 *
 * 两件事都不能省：
 *   1. 等记忆写盘 —— persist() 是异步链在 writeQueue 上的，
 *      不等的话「点完确认立刻关窗口」会丢改动。
 *   2. 收好 pi 子进程 —— 否则会留下孤儿 node 进程。
 */
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await memory.flush()
  } catch {
    /* 写不了就算了，不能因为一个记忆文件卡住退出 */
  }
  memory.close()
  try {
    await agent?.stop()
  } catch {
    /* 已死 */
  }
}

/* ------------------------------------------------------------------
   Agent 生命周期
   ------------------------------------------------------------------ */
async function startAgent(): Promise<{ ok: boolean; error?: string }> {
  if (agent?.running) return { ok: true }
  await agent?.stop()

  const settings = await getSettings()

  agent = new AgentController({
    push,
    cwd: settings.cwd,
    extensionPath: extensionPath(),
    memoryPath: join(YAN_DIR, 'memory.json'),
    piBin: settings.piBin
  })

  // 工具改了记忆文件 → 让界面同步
  agent.on('memory-touched', () => {
    void memory.load().then((items) => push({ ch: 'memory-changed', payload: items }))
  })

  const res = await agent.start()
  if (res.ok) {
    await memory.load()
  }
  return res
}

/* ------------------------------------------------------------------
   IPC
   ------------------------------------------------------------------ */
function registerIpc(): void {
  const handle = <T>(ch: string, fn: (...a: never[]) => Promise<T> | T): void => {
    ipcMain.handle(ch, async (_e, ...args) => fn(...(args as never[])))
  }

  /* ---- 会话 ---- */
  handle('yan:start', async () => {
    const settings = await getSettings()
    const res = await startAgent()
    return { ...res, state: agent?.getState() ?? undefined, settings }
  })

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[]) => {
    if (!agent?.running) {
      const r = await startAgent()
      if (!r.ok) return r
    }
    return agent!.send(text, images)
  })

  handle('yan:steer', async (text: string) => agent?.steer(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:followUp', async (text: string) => agent?.followUp(text) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abort', async () => {
    // 把 clear_queue 拿回来的排队文本一并返回，客户端应放回输入框
    const cleared = (await agent?.abort()) ?? { steering: [], followUp: [] }
    return cleared
  })

  /* ---- 直执行 bash ---- */
  handle('yan:runBash', async (command: string) => agent?.runBash(command) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:abortBash', async () => {
    await agent?.abortBash()
  })

  /* ---- 会话管理 ---- */
  handle('yan:renameSession', async (name: string) => agent?.renameSession(name) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:fork', async (entryId: string) => agent?.fork(entryId) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:clone', async () => agent?.clone() ?? { ok: false, error: 'pi 未运行' })
  handle('yan:forkPoints', async () => agent?.forkPoints() ?? [])
  handle('yan:exportHtml', async () => {
    const res = (await agent?.exportHtml()) ?? { ok: false, error: 'pi 未运行' }
    if (res.ok && res.path) await shell.openPath(res.path)
    return res
  })
  handle('yan:deleteSession', async (path: string) => {
    // 不让删当前正在用的那份（pi 还持有它）
    if (agent?.getState()?.sessionFile === path) {
      return { ok: false, error: '不能删除当前正在使用的会话' }
    }
    try {
      await deleteSession(path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('yan:newSession', async () => {
    if (!agent?.running) {
      const r = await startAgent()
      return r.ok ? { ok: true } : r
    }
    return agent.newSession()
  })

  handle('yan:switchSession', async (path: string) => agent?.switchSession(path) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:compact', async () => agent?.compact() ?? { ok: false, error: 'pi 未运行' })

  /* ---- 模型 / 思考 ---- */
  handle('yan:listModels', async () => agent?.listModels() ?? [])
  handle(
    'yan:setModel',
    async (provider: string, modelId: string) => agent?.setModel(provider, modelId) ?? { ok: false, error: 'pi 未运行' }
  )
  handle('yan:setThinking', async (level: string) => agent?.setThinking(level) ?? { ok: false, error: 'pi 未运行' })
  handle('yan:listThinkingLevels', async () => agent?.listThinkingLevels() ?? [])
  handle('yan:listCommands', async () => agent?.listCommands() ?? [])

  /* ---- 开关 ---- */
  handle(
    'yan:setAutoCompaction',
    async (enabled: boolean) => agent?.setAutoCompaction(enabled) ?? { ok: false, error: 'pi 未运行' }
  )
  handle(
    'yan:setAutoRetry',
    async (enabled: boolean) => agent?.setAutoRetry(enabled) ?? { ok: false, error: 'pi 未运行' }
  )

  /* ---- 状态 ---- */
  handle('yan:getState', async () => agent?.getState() ?? null)
  handle('yan:agentStatus', async () =>
    agent?.getConn() ?? { state: 'starting' as const, detail: '' }
  )
  handle('yan:getMessages', async () => agent?.getMessages() ?? [])
  handle('yan:getStats', async () => agent?.refreshStats() ?? null)
  handle('yan:cachedTitles', async () => cachedTitles())
  handle('yan:getCustomEntries', async () => agent?.getCustomEntries() ?? [])
  handle('yan:refreshTodos', async () => agent?.refreshTodos() ?? [])
  handle('yan:listSessions', async () => listSessions())

  /* ---- 记忆 ---- */
  handle('yan:memoryList', async () => {
    await memory.load()
    memory.ensureWatch()
    return memory.list()
  })
  handle('yan:memoryAdd', async (text: string, kind: 'fact' | 'guess', topic?: string) =>
    memory.add({ text, kind, topic })
  )
  handle('yan:memoryUpdate', async (id: string, patch: Record<string, unknown>) =>
    memory.update(id, patch as never)
  )
  handle('yan:memoryRemove', async (id: string) => memory.remove(id))
  handle('yan:memoryConfirm', async (id: string, ok: boolean) => memory.confirm(id, ok))
  handle('yan:readSoul', async () => readSoul())

  /* ---- 设置 ---- */
  handle('yan:getSettings', async () => {
    const s = await getSettings()
    return { ...s, lang: s.lang, theme: s.theme }
  })
  handle('yan:patchSettings', async (patch: Record<string, unknown>) => patchSettings(patch as never))

  /* ---- 扩展 UI 应答（不需要返回值） ---- */
  ipcMain.on('yan:respondUi', (_e, res) => agent?.respondUi(res))

  /* ---- 渲染端握手：重发当前全部状态 ----
     单向 push 不可靠 —— 主进程可能在 webContents 还没能力接收时
     就把 `proc: ready` 发出去（那条消息就丢了，界面永远停在「正在启动 pi」）。
     所以渲染端一订阅就发这个，我们把当前状态补一遍。 */
  ipcMain.on('yan:renderer-ready', () => {
    const c = agent?.getConn()
    if (c) push({ ch: 'proc', payload: { state: c.state, detail: c.detail } })
    const st = agent?.getState()
    if (st) push({ ch: 'state', payload: st })
    void agent?.refreshStats()
    void agent?.refreshTodos()
  })

  /* ---- 诊断 ---- */
  handle('yan:probePi', async () => {
    const settings = await getSettings()
    const probe = resolvePi({ override: settings.piBin })
    return probe
  })

  handle('yan:openPath', async (p: string) => {
    if (p && existsSync(dirname(p))) await shell.openPath(dirname(p))
  })

  /** 在系统文件管理器里选中某个文件（比 openPath 精确） */
  handle('yan:revealPath', async (p: string) => {
    if (p && existsSync(p)) shell.showItemInFolder(p)
  })

  /* ---- 附件：选图 → 读成 base64 ---- */
  handle('yan:pickImages', async (): Promise<Attachment[]> => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (r.canceled) return []

    const out: Attachment[] = []
    for (const file of r.filePaths) {
      try {
        const buf = await readFile(file)
        // 12MB 上限：pi 会把 base64 塞进 JSONL，太大既慢又没必要
        if (buf.byteLength > 12 * 1024 * 1024) continue
        const ext = extname(file).slice(1).toLowerCase()
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`
        const data = buf.toString('base64')
        out.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: basename(file),
          mimeType,
          size: buf.byteLength,
          data,
          preview: data
        })
      } catch (e) {
        console.error('[yan] 读图失败：', file, e)
      }
    }
    return out
  })

  /* ---- 选目录（换工作目录） ---- */
  handle('yan:pickCwd', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择工作目录'
    })
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })

  handle('yan:setCwd', async (cwd: string) => {
    await patchSettings({ cwd })
    // 换目录必须重启 pi（cwd 是子进程级的）
    await agent?.stop()
    agent = null
    return startAgent()
  })

  /* ---- 窗口 ---- */
  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:maximize', () => {
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
    // 同时推窗口的两种状态：① 最大化与否（切图标）② 扩展设的标题
    push({ ch: 'win-state', payload: { maximized: win.isMaximized() } })
  })
  ipcMain.on('win:close', () => win?.close())
}

/* ------------------------------------------------------------------
   窗口
   ------------------------------------------------------------------ */
function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname_, '../preload/index.mjs'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染端崩了要有记录，否则只看到黑屏
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname_, '../renderer/index.html'))
  }

  // 调试用：YAN_PROBE=<js文件> 时，在渲染端执行它并把结果打到 stdout。
  // 为什么不另开一个裸 BrowserWindow：那测不到 preload/IPC/pi 子进程这条真链路，
  // 断言会“通过”但应用其实是坏的。
  const probeFile = process.env.YAN_PROBE
  if (probeFile) {
    const delay = Number(process.env.YAN_PROBE_DELAY ?? 9000)
    win.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const { readFile } = await import('node:fs/promises')
            const src = await readFile(probeFile, 'utf8')
            // 可选：先发一次**真实**鼠标移动（合成事件不产生 :hover，
            // 所以涉及 CSS hover 的断言必须用 sendInputEvent）
            const mouse = process.env.YAN_PROBE_MOUSE
            if (mouse) {
              const [mx, my] = mouse.split(',').map(Number)
              win!.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my })
              await new Promise((r) => setTimeout(r, 700))
            }

            const result = await win!.webContents.executeJavaScript(src, true)
            console.log('---PROBE-START---')
            console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
            console.log('---PROBE-END---')
          } catch (e) {
            console.error('[probe] 失败', e)
          }
          await shutdown()
          app.exit(0)
        })()
      }, delay)
    })
  }

  // 调试用：YAN_SHOT=<png> 时，等一会儿截图并退出。
  // 为什么要走真实主进程：只有这样才能覆盖 preload / IPC / pi 子进程的完整链路，
  // 在裸 BrowserWindow 里截出来的图只是「长得像」。
  const shot = process.env.YAN_SHOT
  if (shot) {
    const delay = Number(process.env.YAN_SHOT_DELAY ?? 6000)
    const shotW = Number(process.env.YAN_SHOT_W ?? 0)
    const shotH = Number(process.env.YAN_SHOT_H ?? 0)
    if (shotW && shotH) win.setContentSize(shotW, shotH)
    win.once('ready-to-show', () => {
      setTimeout(() => {
        void (async () => {
          try {
            // 截图前的前置准备：YAN_SHOT_SETUP=<js 文件>
            // 需要在截图前把界面摆到某个状态（切会话、展开分区…）时用这个。
            // 不写的话截的就是“刚启动”的状态。
            const setup = process.env.YAN_SHOT_SETUP
            if (setup) {
              const { readFile } = await import('node:fs/promises')
              const src = await readFile(setup, 'utf8')
              await win!.webContents.executeJavaScript(src, true)
              await new Promise((r) => setTimeout(r, 2500))
            }

            const img = await win!.webContents.capturePage()
            const { writeFile, mkdir } = await import('node:fs/promises')
            const { dirname, resolve } = await import('node:path')
            const out = resolve(shot)
            await mkdir(dirname(out), { recursive: true })
            await writeFile(out, img.toPNG())
            console.log(`[shot] ${out}`)
          } catch (e) {
            console.error('[shot] 失败', e)
          }
          await shutdown()
          app.exit(0)
        })()
      }, delay)
    })
  }
}

/* ------------------------------------------------------------------
   启动
   ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  registerIpc()
  createWindow()

  // 记忆目录可能一开始不存在 —— 加载后挂上 watcher
  await memory.load()
  memory.watch((items) => push({ ch: 'memory-changed', payload: items }))
  memory.ensureWatch()

  // 窗口就绪后自动连 pi，用户不用先点「连接」
  const started = await startAgent()

  // 调试/演示用：YAN_PROMPT=<文本> 时，连上后自动发一条。
  // 配合 YAN_SHOT 就能截到“真实对话”而不是空状态。
  // 只发一次：之前用 did-finish-load + 定时兼底两个入口，结果重复发了好几条。
  const prompt = process.env.YAN_PROMPT
  if (prompt && started.ok) {
    let fired = false
    const fire = (): void => {
      if (fired) return
      fired = true
      void agent?.send(prompt).then((r) => {
        if (!r.ok) console.error('[yan] 自动发送失败：', r.error)
      })
    }
    win?.webContents.once('did-finish-load', () => setTimeout(fire, 600))
    setTimeout(fire, 3000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (!agent?.running) void startAgent()
  })
})

app.on('window-all-closed', () => {
  void shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

// 退出前收好子进程与未写盘的记忆，别留孤儿 pi、也别丢刚确认的记忆
app.on('before-quit', (e) => {
  if (shuttingDown) return
  e.preventDefault()
  void shutdown().then(() => app.quit())
})
