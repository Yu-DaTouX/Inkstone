/**
 * 视觉验收矩阵：窗口尺寸 × 缩放 × 主题。
 *
 * 为什么要单独一个脚本（而不是 `npm run test:live` 加场景）：
 *   · 这里要的是**可归档的截图**（N02/N04/N07/N13/N14/N15/N17/N20 的视觉项），
 *     而 `test:live` 的探针只回文本断言，截图是它拉不到的；
 *   · 组合是「几尺寸 × 几缩放 × 两主题」，逐组合起真正的 Electron 窗口，
 *     每个状态截一张，比把它塞进探针的等待窗口更直接。
 *
 * 数据一律来自 `scripts/shot-fixture.js`（合成数据）：
 * 截图会进仓库，**绝不能**把用户真实会话内容截进去。
 *
 * 尺寸/缩放的对应关系（照 `docs/dev/HANDOFF.md` 的验收口径）：
 *   1440x900 → 正常；940x620 → 窄；900x520 → 矮
 *   缩放用应用自己的 `settings.uiScale`（和 Ctrl+= 走同一条路），
 *   不是 Electron 的 `setZoomFactor` —— 后者只影响网页，验不到布局。
 *
 * ⚠️ 两个来自 `scripts/shots.mjs` 的坑（别改回去）：
 *   ① 不能在顶层 `await app.whenReady()`：Electron 的 ESM 加载器要等整个
 *      模块图求值完才发 ready，而 ready 又要等这个 await，直接死锁。
 *   ② 窗口必须 `show: true`：隐藏窗口只合成一次，之后的切主题/开设置
 *      都不再出帧，`capturePage()` 会一直拿到旧画面。
 */
import { missingHandlerSummary, muteMissingHandlerNoise } from './lib/stdio-guard.mjs'  /* 先装护栏：日志管道断了也不能弹框/挂死（见该文件头注释） */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.env.YAN_SHOT_DIR
  ? resolve(process.env.YAN_SHOT_DIR)
  : join(root, 'docs/design/preview')
const STAMP = '2026-09-17'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * 自己去一个临时 userData 目录，并且**每次运行都是新的**。
 *
 * 为什么：用默认 userData 时，上一次运行留下的 GPUCache / 锁会让下一次运行
 * 的 GPU 与 network service 起来就崩（终端里是 `GPU process exited unexpectedly`
 * 和 `Network service crashed`），而脚本表现为“停在第一张图前不动”。
 * 截图不需要持久化任何东西，沙箱目录同时也让截图可重现。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'yan-visual-matrix-'))
app.setPath('userData', join(sandbox, 'userData'))
app.setPath('sessionData', join(sandbox, 'sessionData'))
/* 截图不需要 GPU 加速；关掉后 GPU 进程不会成为失败点 */
app.disableHardwareAcceleration()

/**
 * 只影响「截图好看程度」的两个 IPC 桩（与 `scripts/shots.mjs` 同源）。
 *
 * 截图不跑主进程：文件区/连接状态拿不到数据会显示「读取目录失败」，
 * 在真实应用里是对的，但截图看起来像 bug。这里只补这两块，
 * 其余（会话/模型/提示词）由 `shot-fixture.js` 写进 store。
 */
function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
  /* 额度区：没有它界面上会写“查询失败（Error invoking remote method 'yan:pro…'）”，
     截进验收图会被当成真 bug。数据与 shots.mjs 一致。 */
  ipcMain.handle('yan:providerQuota', (_e, provider) => ({
    provider: provider || 'openai-codex',
    supported: true,
    remaining: 8.42,
    currency: 'USD',
    label: '余额',
    windows: [
      { id: '5h', label: '5 小时', used: 1.58, total: 10 },
      { id: 'week', label: '本周', used: 6.2, total: 30 }
    ],
    checkedAt: Date.now()
  }))
  /* 其余启动期拉取：给空值，让界面停在“没有更多数据”而不是报 IPC 错 */
  ipcMain.handle('yan:listSessions', () => [])
  ipcMain.handle('yan:listCommands', () => [])
  ipcMain.handle('yan:listThinkingLevels', () => [])
  ipcMain.handle('yan:compactionInfo', () => ({
    /*
     * 与真实场景一致的一组值：全局设置了 reserveTokens，项目里的
     * `.pi/settings.json` 因为未信任而**不会被 pi 读** —— 这就是
     * `compaction` 截图里要看到的那句警告（D21）。
     */
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    contextWindow: 400000,
    threshold: 383616,
    custom: false,
    scope: 'global',
    projectIgnored: true
  }))
  /*
   * 回收站通知（N08/N13/N14/N15/N17 的视觉缺口）：截图要拍到「已删除 · 撤销」那条
   * 非模态通知，所以删除必须成功 —— 给一个桩，撤销也给一个（截图不点它，
   * 但按钮的存在依赖 token 非空）。
   */
  /*
   * 文件引用登记（N19 截图要真的走一遍「加入上下文」）：真实主进程会 realpath 校验
   * 并登记路径；截图环境里没有那些文件，所以按请求原样回一个成功的描述 ——
   * 形状与 `grantFiles()` 完全一致（ok / input / path / name / size / mimeType / kind）。
   */
  ipcMain.handle('yan:describeFiles', (_e, paths) =>
    (Array.isArray(paths) ? paths : []).map((p) => {
      const input = String(p)
      const name = input.split(/[\\/]/).pop() ?? input
      return {
        ok: true,
        input,
        path: input,
        name,
        size: 91230,
        mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/typescript',
        kind: 'text'
      }
    })
  )
  ipcMain.handle('yan:deleteSession', () => ({ ok: true, undoToken: 'shot-token' }))
  ipcMain.handle('yan:restoreSession', () => ({ ok: true }))
  ipcMain.handle('yan:authProviders', () => [])
  /*
   * ⚠️ 拉取型 IPC **故意不注册**（getSettings / getState / getStats / listModels …）。
   *
   * 曾经给它们返回空值想“让日志干净一点”，结果是 bootstrap 把空值写回 store，
   * 盖掉 `shot-fixture.js` 刚注入的数据（`settings` 变成 null 时 React 直接
   * 卸载整棵树），表现为后面几张图“缺 .settings / 缺 rail-toggle”。
   * 让它们报 IPC 错反而是对的：store 保留注入值，日志噪音在跑脚本时过滤即可。
   */
  ipcMain.handle('yan:getZoom', () => ({ factor: 1, uiScale: 1 }))
  ipcMain.handle('yan:runnerStatuses', () => [])
  ipcMain.handle('yan:listDir', (_e, rel) => {
    const path = rel || ''
    /*
     * 无权限目录（L02）：截图里要看到「没有读取权限」这一行，
     * 而不是一个空目录 —— 这两种状态在界面上必须是可区分的。
     */
    if (path === 'noperm') {
      return {
        path,
        abs: 'C:/work/pi-desktop/noperm',
        entries: [],
        skipped: [],
        truncated: false,
        status: 'permission',
        error: 'permission'
      }
    }
    /*
     * 目录内容按路径区分：以前每一层都返回同一批名字（src 下面还是 src），
     * 拍"深层文件"的截图时看起来像树坏了。这里给两层真实感的内容。
     */
    const tree = {
      src: [
        { name: 'main', dir: true },
        { name: 'renderer', dir: true },
        { name: 'shared', dir: true },
        { name: 'agent.ts', dir: false, size: 18240 },
        { name: 'index.ts', dir: false, size: 2210 }
      ],
      'src/main': [
        { name: 'agent.ts', dir: false, size: 91230 },
        { name: 'title.ts', dir: false, size: 11040 },
        { name: 'files.ts', dir: false, size: 8120 }
      ]
    }
    return {
      path,
      abs: 'C:/work/pi-desktop' + (path ? '/' + path : ''),
      entries: tree[path] ?? [
        { name: 'src', dir: true },
        { name: 'docs', dir: true },
        { name: 'scripts', dir: true },
        { name: 'noperm', dir: true },
        /*
         * 超长名（窄右栏的省略 + `title` 全文）：长度要明显超过 `PANEL_MIN=220`
         * 下名字的可用宽度，否则截图里看不出省略行为。
         */
        {
          name: '一个非常长的文件名用来验证窄栏下的省略显示-0123456789-abcdefghij-中文结尾.md',
          dir: false,
          size: 4096
        },
        { name: 'README.md', dir: false, size: 23073 },
        { name: 'package.json', dir: false, size: 2966 }
      ],
      skipped: ['node_modules', '.git'],
      truncated: false,
      rootName: 'pi-desktop'
    }
  })
}

/**
 * 组合表。`states` 里每一项都要在下面 STATES 里能找到脚本。
 * 深浅两套不必每个状态都截：深色多截几个（细节对比更明显），
 * 浅色只截最容易被主题漏掉的那几个（主界面/推理/设置/迷你栏）。
 */
const GROUPS = [
  {
    w: 1440,
    h: 900,
    scale: 1,
    theme: 'dark',
    states: ['main', 'modelmenu', 'reasoning', 'settings', 'ctxsettings', 'railmini', 'compaction', 'contextbudget', 'ctxnarrow', 'fsnarrow', 'fileincontext', 'trashtoast', 'wschanges', 'wsunknown', 'browserboundary', 'browserblocked', 'usageelapsed', 'usageturn', 'railreorder']
  },
  { w: 1440, h: 900, scale: 1, theme: 'light', states: ['main', 'reasoning', 'settings', 'ctxsettings', 'railmini', 'compaction', 'contextbudget', 'trashtoast', 'browserboundary', 'browserblocked', 'usageelapsed', 'usageturn', 'railreorder'] },
  { w: 940, h: 620, scale: 1, theme: 'dark', states: ['main', 'modelmenu', 'railmini'] },
  { w: 940, h: 620, scale: 1, theme: 'light', states: ['main', 'settings'] },
  { w: 900, h: 520, scale: 1, theme: 'dark', states: ['main', 'settings'] },
  { w: 1440, h: 900, scale: 1.25, theme: 'dark', states: ['main', 'settings'] },
  { w: 1440, h: 900, scale: 1.5, theme: 'dark', states: ['main', 'reasoning'] }
]

/** 引导态单独跑（要先把 onboarded 标记拿掉） */
const ONBOARDING_GROUPS = [
  { w: 1440, h: 900, scale: 1, theme: 'dark' },
  { w: 940, h: 620, scale: 1, theme: 'dark' },
  { w: 900, h: 520, scale: 1, theme: 'light' }
]

/*
 * 状态脚本：都在渲染端求值。
 *
 * 约定：每个脚本先把界面复位到「主界面」，再摆出自己那个状态 ——
 * 否则上一个状态留下的菜单/面板会串进下一张图（截出来的是两态叠加）。
 */
const STATES = {
  /* 主界面：右栏打开、左栏展开、没有浮层 */
  main: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({ rightPanelOpen: true });
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      return 'ok';
    })()
  `,
  /* 模型菜单（N02/N08）：真实点开 picker，让菜单自己算位置。
     picker 在“忙”的时候是 disabled（`busy = session.isStreaming || isCompacting`），
     而 fixture 故意把会话摆成“正在流式”——不先把它放空，点击就完全没反应。 */
  modelmenu: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      const btn = document.querySelector('[data-testid="model-picker"]');
      if (!btn) return 'no-picker';
      if (btn.disabled) return 'picker-disabled';
      btn.click();
      return 'ok(items=' + document.querySelectorAll('.mt-item').length + ')';
    })()
  `,
  /* 推理块（N04）：展开最后一段，并把对话滚到它 */
  reasoning: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      const toggles = [...document.querySelectorAll('[data-testid="reasoning-toggle"]')];
      const last = toggles[toggles.length - 1];
      if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
      const box = document.querySelector('.stream');
      if (box) box.scrollTop = box.scrollHeight;
      return toggles.length ? 'ok' : 'no-reasoning';
    })()
  `,
  /* 设置面板（N07） */
  settings: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      st.openSettings('appearance');
      return 'ok';
    })()
  `,
  /*
   * 上下文设置（N21-7）：工作集阀值可配 + 生效来源。
   * 单独一个状态而不是只拍 appearance —— 新 tab 的排版（数值输入、
   * 预设分段控件、来源行）只能在真图里看是否折行 / 溢出。
   */
  ctxsettings: `
    (() => {
      const st = window.__yanStore.getState();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 注入一份“用户级覆盖”的真实形状：来源 + 覆盖字段 + 预算都是主进程
       * 会推的那几个字段（不是只为截图摆的假数据）。
       */
      window.__yanStore.setState({
        settings: { ...st.settings, contextPolicy: { workingSetCap: 300000, windowRatio: 0.75 } },
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'compaction'],
            source: 'user',
            overridden: ['workingSetCap', 'windowRatio'],
            budget: {
              contextWindow: 400000,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 300000,
              triggers: { sweep: 210000, fold: 255000, compact: 300000 },
              emergency: 360000
            }
          }
        }
      });
      st.openSettings('context');
      return 'ok';
    })()
  `,
  /* 迷你项目栏（N14） */
  railmini: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      st.setRailPinned(false);
      return 'ok';
    })()
  `,
  /*
   * 窄右栏文件树（L02）：收到 `PANEL_MIN=220`，一张图里看三件事 ——
   *   · 超长文件名省略显示（`title` 里能给全文）
   *   · 深层的浅缩进在窄栏下收敛，不再把图标顶出右边界
   *   · 无权限目录给的是「没有读取权限」，而不是「空目录」
   */
  /*
   * 浏览器边界（L04）：一张图看三件事 ——
   *   · 被拦下的请求在「⋯」里**可追溯**（目标主机 + 原因 + 是谁想访问）
   *   · 下载条写明「未自动打开」并带**来源**
   *   · 权限记录（默认拒绝）与拦截记录并列
   * 原生网页视图在这个脚本里不存在（它只在真窗口里存在），所以这一张
   * 拍的是工具栏 + 状态行 —— 也就是**渲染层能负责的那部分**。
   */
  browserboundary: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({
        rightPanelOpen: true,
        filePreview: null,
        browserState: {
          open: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mode: 'embedded',
          lastDownload: {
            path: 'C:\\Users\\yan\\Downloads\\yan-probe-download.txt',
            filename: 'yan-probe-download.txt',
            size: 48,
            source: 'http://127.0.0.1:39873/download'
          },
          permissions: [
            { permission: 'geolocation', origin: 'http://127.0.0.1:39873', status: 'blocked', at: Date.now() - 42000 }
          ],
          blockedRequests: [
            { host: '127.0.0.1', reason: 'private-host', from: 'example.com', at: Date.now() - 9000, count: 2 },
            { host: '127-0-0-1.sslip.io', reason: 'dns-rebind', from: 'example.com', at: Date.now() - 8000, count: 1 }
          ]
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const more = document.querySelector('[data-testid="browser-more"]');
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      await new Promise((r) => setTimeout(r, 350));
      const list = document.querySelector('[data-testid="browser-blocked"]');
      if (list) list.scrollIntoView({ block: 'nearest' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 同一组数据的**另一面**：⋯ 收起时，状态行上是「已拦截 N 个请求」+ 带来源的
   * 下载条 —— 这两个恰好是用户不打开菜单也能看到的（也是“页面打不开”的解释）。
   * 为什么要两张：菜单与状态行在 JSX 里是互斥分支，一张图拍不全。
   */
  browserblocked: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.setState({
        rightPanelOpen: true,
        filePreview: null,
        browserState: {
          open: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mode: 'embedded',
          lastDownload: {
            path: 'C:\\Users\\yan\\Downloads\\yan-probe-download.txt',
            filename: 'yan-probe-download.txt',
            size: 48,
            source: 'http://127.0.0.1:39873/download'
          },
          blockedRequests: [
            { host: '127.0.0.1', reason: 'private-host', from: 'example.com', at: Date.now() - 9000, count: 2 },
            { host: '127-0-0-1.sslip.io', reason: 'dns-rebind', from: 'example.com', at: Date.now() - 8000, count: 1 }
          ]
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const more = document.querySelector('[data-testid="browser-more"]');
      if (more && more.getAttribute('aria-expanded') === 'true') more.click();
      await new Promise((r) => setTimeout(r, 350));
      const status = document.querySelector('[data-testid="browser-status"]');
      if (status) status.scrollIntoView({ block: 'nearest' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  fsnarrow: `
    (() => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 不走 store 的 setPanelWidth：那是 async 且要等 patchSettings IPC，
       * 而截图脚本没跑主进程（没有该 handler）—— 实测会卡在这一步。
       * 直接改本地 settings：布局的列宽就从这里读。
       */
      window.__yanStore.setState({
        settings: { ...(st.settings || {}), panelWidth: 220, rightPanelOpen: true }
      });
      /* 展开无权限目录：要拍到的是「没有读取权限」这一行，而不是空白 */
      const np = document.querySelector('[data-testid="fs-row-noperm"]');
      if (np) np.click();
      return 'ok(noperm=' + (np ? 'clicked' : 'missing') + ')';
    })()
  `,
  /*
   * shell 的目录级改动（L05）：展开那条带 `workspaceChanges` 的命令行。
   * 展开后卡片才渲染，所以先 click 再等一帧，最后把卡片滚到视口中间 ——
   * 否则截到的是对话底部，卡片在画面之外。
   */
  wschanges: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /*
       * 已结束的工具被收进「运行了命令 N」组（ToolGroup），组不展开就没有 ToolRow。
       * 先把所有组打开，再找那条带 workspaceChanges 的命令。
       */
      /* aria-expanded 在**按钮**上，不在容器 div 上 ——
         读错了就会「已经开着又点一次」，把组重新关掉（实测踩过）。 */
      document.querySelectorAll('[data-testid="tool-group"]').forEach((g) => {
        const head = g.querySelector('[data-testid="tool-group-toggle"]');
        if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const rows = [...document.querySelectorAll('[data-testid="tool-row"]')];
      const row = rows.find((r) => /migrate-tokens/.test(r.textContent || ''));
      if (!row) return 'no-row(rows=' + rows.length + ', ' + rows.map((r) => (r.textContent || '').slice(0, 18)).join(' | ') + ')';
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
      await new Promise((r) => setTimeout(r, 400));
      const cards = [...document.querySelectorAll('[data-testid="workspace-changes"]')];
      const card = cards[cards.length - 1];
      if (card) card.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return cards.length ? 'ok' : 'no-card';
    })()
  `,
  /*
   * 压缩可观测（N21-2）：一张图里看四件事 ——
   *   · 进行中那一行带**原因**（「压缩中 · 已达阈值」）
   *   · 「最近一次」在压缩进行中仍显示上一轮的结果（两条互不覆盖）
   *   · 失败时把 pi 的原文摆出来（不静默）+ 压缩前后 token
   *   · 项目级设置被 pi 忽略时说出来（D21）
   * 截的是详情展开态：这些行都在「详情」里。
   */
  compaction: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({
        session: {
          ...st.session,
          isStreaming: false,
          isCompacting: true,
          compaction: { status: 'running', reason: 'threshold', startedAt: Date.now() - 2400 },
          lastCompaction: {
            status: 'failed',
            reason: 'manual',
            startedAt: Date.now() - 660000,
            endedAt: Date.now() - 659000,
            beforeTokens: 36230,
            afterTokens: 18400,
            error: 'Compaction failed: Already compacted'
          }
        }
      });
      await new Promise((r) => setTimeout(r, 250));
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      const row = document.querySelector('[data-testid="ctx-last-compaction"]');
      if (row) row.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 工作集视角（N21-3）：一张图里看四件事 ——
   *   · 主值是**工作集**（240k）而不是物理窗口（400k），带 data-mode
   *   · 三条阶段刻度：压缩实线（真的会触发）、清理/折叠虚线（阶段 4 才接管）
   *   · 「下一步：压缩上下文（约 240k 时）」
   *   · 详情里的 工作集 / 预留 / 安全余量 / 物理兜底
   * 预算值直接注入 store（与主进程推来的同构），这里不重算公式。
   */
  /*
   * 本轮用时（用户要求）：回合结束后，底部用量条上要能看到「用时 Ns」。
   * fixture 默认把会话摆成「流式中」（那时显示的是「生成中 Ns」），
   * 所以这里显式置为已结束，并确认真的渲染出了耗时项。
   */
  usageelapsed: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({ session: { ...st.session, isStreaming: false, isAgentRunning: false } });
      await new Promise((r) => setTimeout(r, 400));
      const box = document.querySelector('.stream');
      if (box) box.scrollTop = box.scrollHeight;
      await new Promise((r) => setTimeout(r, 250));
      return document.querySelector('[data-testid="ub-elapsed"]') ? 'ok' : 'no-elapsed';
    })()
  `,
  /*
   * 新一轮刚开始（R03）：会话里上一轮有非零 usage 与 speed，现在追加一条
   * 用户消息并回到流式 —— 用量条必须显示「生成中 Ns」，**不能**把上一轮的
   * 46 tok/s 标成实时速度，输入/输出/缓存也要是「—」而不是旧值。
   * 零费用：完全在渲染端注入状态，不调模型。
   */
  usageturn: `
    (async () => {
      try {
        const st = window.__yanStore.getState();
        st.closeSettings();
        st.setRailPinned(true);
        document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
        const next = [...st.messages, { id: 'u3', role: 'user', text: '还要把右键菜单也整理一下。', timestamp: Date.now() }];
        window.__yanStore.setState({
          messages: next,
          session: { ...st.session, isStreaming: true, isAgentRunning: true }
        });
        await new Promise((r) => setTimeout(r, 500));
        const bar = document.querySelector('[data-testid="usagebar"]');
        if (!bar) return 'no-usagebar';
        const text = bar.textContent || '';
        if (!/生成中|generating/i.test(text)) return 'no-generating';
        if (!bar.querySelector('.ub-live')) return 'no-live-dot';
        if (text.includes('tok/s')) return 'stale-speed';
        if (bar.querySelector('[data-testid="ub-elapsed"]')) return 'stale-elapsed';
        const box = document.querySelector('.stream');
        if (box) box.scrollTop = box.scrollHeight;
        await new Promise((r) => setTimeout(r, 250));
        return 'ok';
      } catch (e) {
        return 'err:' + (e && e.message ? e.message : String(e));
      }
    })()
  `,
  contextbudget: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      window.__yanStore.setState({
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'compaction'],
            budget: {
              /*
               * 窗口必须与截图 fixture 的模型一致（400k，见 shot-fixture.js），
               * 否则会出现“面板里的窗口 400k、兜底线却是 262k 窗口算出来的”这种
               * 自相矛盾的截图（正是 D21/D22 那类误解）。
               * 兜底线在 400k 上不被预留卡住（360k < 368k），所以这里看不出 D31 的
               * 差别 —— 那一条由单测扫描 + 探针在**真实窗口**上断言（probe/context-budget.js 第 2 节）。
               */
              contextWindow: 400000,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 240000,
              triggers: { sweep: 168000, fold: 204000, compact: 240000 },
              emergency: 360000
            }
          }
        }
      });
      await new Promise((r) => setTimeout(r, 250));
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      return 'ok';
    })()
  `,
  /*
   * 最窄右栏（PANEL_MIN = 220px）+ 工作集视角：用户截图里的组合。
   * 要拍的就是「自动压缩」那一行 —— 压缩按钮必须**一行高**、与标题同一条中线，
   * 文字不能被折成「压缩上/下文」；阶段刻度和「下一步」在窄栏下也要能读。
   */
  ctxnarrow: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /* 不走 store 的 setPanelWidth（async + 需要主进程 handler），直接改本地 settings */
      window.__yanStore.setState({
        settings: { ...(st.settings || {}), panelWidth: 220, rightPanelOpen: true },
        session: {
          ...st.session,
          isStreaming: false,
          isAgentRunning: false,
          contextPolicy: {
            enabled: true,
            kinds: ['tool-sweep', 'recall', 'compaction'],
            budget: {
              /*
               * 用真实模型的窗口（262144，与用户机器一致）而不是整数 400k：
               * 这个窗口上兜底线正好被输出预留卡住（224k 而不是 230.4k），
               * 截图里「物理兜底」那一行就是 §12.1 / D31 的证据。
               */
              contextWindow: 262144,
              responseReserve: 32000,
              safetyMargin: 8000,
              workingSet: 183501,
              triggers: { sweep: 128451, fold: 155976, compact: 183501 },
              emergency: 229376
            }
          }
        }
      });
      await new Promise((r) => setTimeout(r, 400));
      const row = document.querySelector('[data-testid="rp-context-actions"]');
      if (row) row.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return 'ok';
    })()
  `,
  /*
   * 删除后的**非模态**通知条（回收站）。几何与文案由 `trash` 探针断言，
   * 这里补的是静态截图（浅色/深色各一张）—— 它是左栏唯一一条"操作已完成、
   * 还能撤销"的横条，颜色与按钮宽度最容易在改主题时坏掉。
   *
   * 注意：删除成功后 store 会 `refreshSessions()`，而截图环境故意不注册
   * 拉取型 IPC（返回空会盖掉 fixture 注入的数据）—— 这里先把会话列表存一份，
   * 等通知出现后再放回去，否则截图里左栏会空掉（那不是这个状态要拍的东西）。
   */
  trashtoast: `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      /*
       * 复位右栏：上几张图（fsnarrow / fileincontext）会留下展开的文件树、文件预览
       * 与输入区里的附件标签 —— 不清掉的话这张"回收站通知"的图里会挂着别人的状态。
       */
      st.closePreview?.();
      st.clearAttachments?.();
      document
        .querySelector('[data-testid="rp-files"] .rp-sec-head')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);
      const saved = window.__yanStore.getState().sessions;
      /*
       * 截图需要一条**可删的**会话：当前会话禁止删除，而 fixture 里只有一条
       * 显示的会话（其它几条在同名项目分组里没渲染出来）。所以临时补一条
       * 合成会话 —— 它只活在这张截图里，删完立刻把原列表放回去。
       */
      const extra = {
        ...saved[0],
        id: 'shot-trash',
        path: 'C:/Users/x/.pi/agent/sessions/proj/shot-trash.jsonl',
        title: '布局微调 · 待删除的会话',
        updatedAt: Date.now() - 60000
      };
      window.__yanStore.setState({ sessions: [...saved.filter((x) => x.id !== 'shot-trash'), extra] });
      await sleep(400);
      const row = document.querySelector('[data-session-path="' + extra.path + '"]');
      if (!row) return 'no-row(rows=' + document.querySelectorAll('.srow').length + ')';
      const setValue = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      row.querySelector('.srow-acts button')?.click();
      await sleep(300);
      const danger =
        row.querySelector('.srow-menu-btn.danger:not([disabled])') ??
        [...document.querySelectorAll('.srow-menu-btn.danger:not([disabled])')].pop();
      if (!danger) return 'no-danger-item';
      danger.click();
      await sleep(500);
      const dlg = document.querySelector('.rail-delete-dialog');
      const input = dlg?.querySelector('.modal-input');
      if (!input) return 'no-dialog';
      setValue(input, input.placeholder);
      await sleep(250);
      const confirm = dlg.querySelector('.modal-foot .btn.danger');
      if (!confirm || confirm.disabled) return 'confirm-disabled';
      confirm.click();
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('[data-testid="trash-notice"]')) break;
        await sleep(150);
      }
      /* 删除后 store 会 refreshSessions（截图环境没有该 IPC）→ 把原列表放回去 */
      window.__yanStore.setState({ sessions: saved });
      await sleep(400);
      const notice = document.querySelector('[data-testid="trash-notice"]');
      if (!notice) return 'no-notice';
      const r = notice.getBoundingClientRect();
      const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const chain = [];
      for (let el = notice.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        chain.push((el.className || el.tagName) + ':' + cs.overflow + '/' + cs.overflowY + ':' + el.scrollTop + '/' + el.clientHeight + '/' + el.scrollHeight);
        if (chain.length > 6) break;
      }
      return 'ok(mid=' + (mid?.className || mid?.tagName) + '|' + chain.join(' > ') + ')';
    })()
  `,
  fileincontext: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      window.__yanStore.getState().clearAttachments?.();
      const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      click(document.querySelector('[data-testid="fs-row-src"]'));
      await new Promise((r) => setTimeout(r, 700));
      click(document.querySelector('[data-testid="fs-row-src/main"]'));
      await new Promise((r) => setTimeout(r, 700));
      const file = document.querySelector('[data-testid="fs-row-src/main/agent.ts"]');
      if (!file) return 'no-file-row';
      /* 单击 = 只读预览（与"加入上下文"是两件事，这里两样都要拍到） */
      click(file);
      await new Promise((r) => setTimeout(r, 500));
      const add = document.querySelector('[data-testid="fs-add-src/main/agent.ts"]');
      if (!add) return 'no-add-button';
      click(add);
      await new Promise((r) => setTimeout(r, 600));
      const tagged = window.__yanStore.getState().attachments?.some((a) => a.kind === 'file');
      const dot = document.querySelector('[data-testid="fs-inctx-src/main/agent.ts"]');
      return 'ok(tagged=' + (tagged ? 1 : 0) + ',dot=' + (dot ? 1 : 0) + ')';
    })()
  `,
  /* 同一个组件的第二个变体：归属存疑（并发）时的写法 */
  wsunknown: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      /* aria-expanded 在**按钮**上，不在容器 div 上 ——
         读错了就会「已经开着又点一次」，把组重新关掉（实测踩过）。 */
      document.querySelectorAll('[data-testid="tool-group"]').forEach((g) => {
        const head = g.querySelector('[data-testid="tool-group-toggle"]');
        if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const rows = [...document.querySelectorAll('[data-testid="tool-row"]')];
      const row = rows.find((r) => /npm run build/.test(r.textContent || ''));
      if (!row) return 'no-row(rows=' + rows.length + ')';
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
      await new Promise((r) => setTimeout(r, 400));
      const warn = document.querySelector('[data-testid="ws-unknown"]');
      if (warn) warn.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 250));
      return warn ? 'ok' : 'no-unknown';
    })()
  `,
  /*
   * 项目 / 分组拖拽排序（N01）：停在**拖拽进行中**。
   *
   * 为什么不截拖完的结果：拖完的列表与普通列表在视觉上完全一样，
   * 而这次交互唯一的视觉语言就是「被拖的行半透明 + 目标位置一条 2px 插入线」，
   * 它必须在真图里能被人眼检查（尤其是浅色主题下的对比度）。
   */
  railreorder: `
    (async () => {
      const st = window.__yanStore.getState();
      st.closeSettings();
      st.setRailPinned(true);
      document.querySelectorAll('[data-testid="model-picker"][aria-expanded="true"]').forEach((b) => b.click());
      const base = String(st.settings.cwd || '').replace(/[\\/][^\\/]*$/, '');
      const stamp = Date.now();
      const projects = [
        { id: 'vis-p1', cwd: base + '/vis-one', name: '一号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 6 },
        { id: 'vis-p2', cwd: base + '/vis-two', name: '二号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 5 },
        { id: 'vis-p3', cwd: base + '/vis-three', name: '三号项目', groupId: 'vis-ga', archived: false, createdAt: stamp, updatedAt: stamp + 4 },
        { id: 'vis-p4', cwd: base + '/vis-four', name: '四号项目', groupId: 'vis-gb', archived: false, createdAt: stamp, updatedAt: stamp + 3 },
        { id: 'vis-p5', cwd: base + '/vis-five', name: '五号项目', groupId: 'vis-gb', archived: false, createdAt: stamp, updatedAt: stamp + 2 },
        { id: 'vis-p6', cwd: base + '/vis-six', name: '六号项目', groupId: undefined, archived: false, createdAt: stamp, updatedAt: stamp + 1 }
      ];
      /*
       * 直接 setState 而不走 patchSettings：截图脚本**故意不注册**写设置类 IPC
       * （见 registerStubHandlers 的说明），调它只会拿到
       * “No handler registered for 'yan:patchSettings'”。
       */
      window.__yanStore.setState({
        settings: {
          ...st.settings,
          projectGroups: [
            { id: 'vis-ga', name: '产品线', createdAt: stamp },
            { id: 'vis-gb', name: '实验线', createdAt: stamp }
          ],
          projects,
          projectOrder: projects.map((p) => p.id),
          recentCwds: projects.map((p) => p.cwd)
        }
      });
      await new Promise((r) => setTimeout(r, 450));
      const rows = [...document.querySelectorAll('[data-testid="rail-project-row"]')];
      if (rows.length < 4) return 'rows=' + rows.length;
      /*
       * 拖动源与落点必须**同组**：跨组不接受落点（归属变更走右键菜单），
       * 选错就是一张没有插入线的图（实测踩过）。
       * 分组聚合后的顺序是：产品线 p1,p2,p3 → 实验线 p4,p5 → 未分组 p6。
       */
      const from = rows[2];
      const to = rows[0];
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1, isPrimary: true, pointerType: 'mouse'
      }));
      pe(from, 'pointerdown', a.left + 30, a.top + a.height / 2);
      await new Promise((r) => setTimeout(r, 40));
      /* 先越过 4px 阀值才进拖拽态 —— 与用户手拖走的是同一条路径 */
      pe(window, 'pointermove', a.left + 30, a.top + a.height / 2 + 10);
      await new Promise((r) => setTimeout(r, 40));
      pe(window, 'pointermove', b.left + 30, b.top + b.height * 0.2);
      await new Promise((r) => setTimeout(r, 260));
      return 'ok';
    })()
  `
}

/** 每个状态要顺带核对的元素（截图的图不能是空的） */
const MUST_HAVE = {
  /* 主界面（注意：fixture 里会话是「流式中」，所以这里不会出现「用时」——
     用时的视觉证据在 usageelapsed 状态里） */
  main: ['.rail', '.stream', '.composer, [data-testid="composer"]'],
  modelmenu: ['[data-testid="model-picker"]', '[data-testid="model-menu"]'],
  reasoning: ['[data-testid="reasoning-toggle"]'],
  settings: ['.settings'],
  ctxsettings: ['.settings', '[data-testid="ctx-source"]', '[data-testid="ctx-cap"]', '[data-testid="ctx-preset"]'],
  railmini: ['[data-testid="rail-toggle"]'],
  compaction: [
    '[data-testid="rp-context"]',
    '[data-testid="ctx-compacting-reason"]',
    '[data-testid="ctx-last-compaction"]',
    '[data-testid="ctx-last-compaction-error"]',
    '[data-testid="ctx-project-ignored"]'
  ],
  browserboundary: [
    '[data-testid="browser-surface"]',
    '[data-testid="browser-blocked"]',
    '[data-testid="browser-permissions"]'
  ],
  browserblocked: [
    '[data-testid="browser-surface"]',
    '[data-testid="browser-blocked-hint"]',
    '[data-testid="browser-download"]'
  ],
  fsnarrow: ['[data-testid="rightpanel"]', '[data-testid="rp-files"]'],
  wschanges: ['[data-testid="workspace-changes"]', '[data-testid="ws-title"]'],
  wsunknown: ['[data-testid="workspace-changes"]', '[data-testid="ws-unknown"]'],
  ctxnarrow: ['[data-testid="rp-context-actions"]', '[data-testid="rp-compact-now"]', '[data-testid="ctx-stages"]'],
  trashtoast: ['[data-testid="trash-notice"]', '[data-testid="trash-undo"]', '.rail-trash-name', '.srow'],
  fileincontext: ['[data-testid="fs-tree"]', '[data-testid="file-preview"]', '[data-testid="fs-inctx-src/main/agent.ts"]', '[data-testid="composer"]'],
  usageelapsed: [
    '[data-testid="usagebar"]',
    '[data-testid="ub-elapsed"]',
    '.usagebar .ub-item',
    '[data-testid="composer"]'
  ],
  usageturn: [
    '[data-testid="usagebar"]',
    '.usagebar .ub-live',
    '.usagebar .ub-item',
    '[data-testid="composer"]'
  ],
  contextbudget: [
    '[data-testid="ctx-stages"]',
    '[data-testid="ctx-stage-mark"]',
    '[data-testid="ctx-next-stage"]',
    '[data-testid="ctx-working-set"]'
  ],
  /* 拖拽中的视觉：被拖行 + 目标行上的插入线必须都在，否则这张图没意义 */
  railreorder: [
    '.rail',
    '[data-testid="rail-project-row"]',
    '.is-dragging',
    '.drop-before, .drop-after'
  ]
}

/** 截完图要做的复位（目前只有：把为拍模型菜单而放空的“忙”状态改回去） */
const AFTER_STATE = {
  modelmenu: `
    (() => {
      const st = window.__yanStore.getState();
      window.__yanStore.setState({ session: { ...st.session, isStreaming: true } });
      document.querySelectorAll('[data-testid="model-picker"]').forEach((b) => b.click());
      return 'ok';
    })()
  `,
  /*
   * 压缩态把 isCompacting 置 true，而「忙」时模型 picker 是 disabled ——
   * 不复位的话，同一组里**排在后面**的状态会点不开菜单（实测踩过同类问题）。
   */
  compaction: `
    (() => {
      const st = window.__yanStore.getState();
      window.__yanStore.setState({
        session: { ...st.session, isCompacting: false, compaction: undefined, lastCompaction: undefined }
      });
      const toggle = document.querySelector('[data-testid="ctx-details-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      return 'ok';
    })()
  `,
  /*
   * 拖拽截完必须**取消**而不是松手：松手会把这次拖拽真的提交，
   * 后续状态的左栏顺序就跟着变（截图之间互相干扰）。
   * Esc 是产品里真有的取消出口，顺便把它也走一遍。
   * 造出来的分组/项目不清 —— railreorder 在组内排最后，不会串到别的图。
   */
  railreorder: `
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'ok';
    })()
  `
}

/**
 * 采集几何：横向溢出是最常见的窄/矮窗口缺陷，直接当断言。
 * 同时统计关键元素是否真的在视口里（截图一片空白时能立刻看出来）。
 */
const probeGeometry = (selectors) => `
  (() => {
    const d = document.documentElement;
    const list = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
    };
    const sels = ${JSON.stringify(selectors)};
    return {
      sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight,
      uiScale: window.__yanStore.getState().settings?.uiScale ?? null,
      theme: document.documentElement.dataset.theme || '',
      boxes: Object.fromEntries(sels.map((sel) => [sel, list(sel)])),
      must: Object.fromEntries(sels.map((sel) => [sel, !!document.querySelector(sel)]))
    };
  })()
`

/** 只跑某些状态（调脚本时用）：`YAN_MATRIX_ONLY=modelmenu` */
const ONLY = (process.env.YAN_MATRIX_ONLY ?? '').split(',').filter(Boolean)

/*
 * 只跑某几组（下标，逗号分隔）：`YAN_MATRIX_GROUP=0,2`。
 *
 * 为什么要能拆：这台机器上跑满 7 组时，后半程会出现
 * `Network service crashed` / `GPU process exited unexpectedly`，
 * 脚本停住不动。拆成一组一个进程既不会长时间持有合成器，
 * 也方便失败后只重跑那一组。
 */
const GROUP_ONLY = (process.env.YAN_MATRIX_GROUP ?? '')
  .split(',')
  .filter(Boolean)
/* 引导组也算一组（用名字）：`YAN_MATRIX_GROUP=onboarding` */
const WANT_ONBOARDING = GROUP_ONLY.length === 0 || GROUP_ONLY.includes('onboarding')

async function main() {
  /*
   * 截图/测量脚本**故意**不注册拉取型 IPC（返回空值会覆盖 fixture 注入的 store）：
   * Electron 会把每次失败调用刷成一整段堆栈，既是这次 EPIPE 事故里被淹没的
   * “原始错误”，也会把真错误顶出屏幕。这里显式静音并计数（结尾汇总），
   * 其余 console.error 原样透传。
   */
  muteMissingHandlerNoise()
  registerStubHandlers()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    frame: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      /* 产物是 .cjs：sandboxed preload 不支持 ESM（见 electron.vite.config.ts） */
      preload: join(root, 'out/preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      /*
       * 关掉后台节流。
       *
       * 默认情况下窗口被遮住/不在前台时，渲染进程不再出帧 ——
       * `capturePage()` 于是会一直等一张永远不来的画面，
       * 表现成“脚本停在那里、什么也不打印”（实测踩过）。
       */
      backgroundThrottling: false
    }
  })

  await win.loadFile(join(root, 'out/renderer/index.html'))
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('yan.theme', 'dark');
      localStorage.setItem('yan.lang', 'zh-CN');
      localStorage.setItem('yan.onboarded', '1');
      localStorage.setItem('yan.termSize', JSON.stringify({ h: 260, w: 0 }));
    } catch {}
  `)
  await win.webContents.reload()

  /* 等字体栅格就绪（Maple），否则汉字会回退成别的字体：截图证据就不可比了。
     带超时兜底：`document.fonts.ready` 在字体加载失败时可能永不 resolve，
     而这里卡住的表现是“什么也不打印”，极难当场看出原因（实测踩过一次）。 */
  let cnWidth = await win.webContents.executeJavaScript(`
    Promise.race([
      document.fonts.ready.then(() => {
        const el = document.createElement('span');
        el.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"';
        el.textContent = '国';
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      }),
      new Promise((r) => setTimeout(() => r(-1), 5000))
    ])
  `)

  const fixture = await readFile(join(root, 'scripts/shot-fixture.js'), 'utf8')
  const injected = await win.webContents.executeJavaScript(fixture)
  if (injected !== 'ok') throw new Error('fixture 注入失败: ' + injected)
  await wait(700)

  const failures = []
  const shot = async (name, geometry) => {
    /* 再等两帧 + 一点时间：确保这次变更已经画出来（否则截到上一态） */
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    )
    /*
     * 再显式要一次重绘。为什么需要：trashtoast 那张图实测**DOM 里有通知条、
     * elementFromPoint 也命中它，但截图里没有** —— 窗口不在前台时合成器可能停在
     * 上一帧（等 rAF 只保证脚本侧排过队，不保证真的出帧）。
     * invalidate() 只影响画面、不改布局，对所有状态都安全。
     */
    win.webContents.invalidate()
    await wait(220)
    const outPath = join(outDir, name)
    await mkdir(dirname(outPath), { recursive: true })
    /* capturePage 也可能挂住（窗口被遮、合成器不给帧）—— 给个上限，别卡死整个矩阵 */
    const img = await Promise.race([
      win.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 8000))
    ])
    if (!img) {
      failures.push(`${name}（截图超时）`)
      console.log(`  ✗ ${name}  截图超时（窗口可能被遮住）`)
      return geometry
    }
    await writeFile(outPath, img.toPNG())
    const over = geometry.sw - geometry.cw
    const missing = Object.entries(geometry.must)
      .filter(([, okFlag]) => !okFlag)
      .map(([sel]) => sel)
    const good = over <= 1 && missing.length === 0
    if (!good) failures.push(`${name}（溢出 ${over}px${missing.length ? '，缺 ' + missing.join(',') : ''}）`)
    console.log(
      `  ${good ? '✓' : '✗'} ${name}  溢出=${over}px  缩放=${geometry.uiScale}  主题=${geometry.theme}` +
        (missing.length ? `  缺=${missing.join(',')}` : '')
    )
    return geometry
  }

  const applyScale = async (scale) => {
    await win.webContents.executeJavaScript(`
      (() => {
        const st = window.__yanStore.getState();
        const projects = Array.isArray(st.settings?.projects) ? st.settings.projects : [];
        window.__yanStore.setState({ settings: { ...st.settings, uiScale: ${scale}, projects } });
        return 'ok';
      })()
    `)
    await wait(220)
  }

  for (const [gi, g] of GROUPS.entries()) {
    if (GROUP_ONLY.length && !GROUP_ONLY.includes(String(gi))) continue
    const size = `${g.w}x${g.h}`
    const pct = Math.round(g.scale * 100)
    console.log(`\n▶ ${size} @ ${pct}% ${g.theme}`)
    win.setSize(g.w, g.h)
    await wait(260)
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${g.theme}'`)
    await applyScale(g.scale)

    for (const state of g.states) {
      if (ONLY.length && !ONLY.includes(state)) continue
      console.log(`  · ${state}`)
      /*
       * 模型菜单需要先把“忙”放开（picker 在忙时 disabled）。
       * 必须**分两次** executeJavaScript：setState 到 DOM 反映要等 React 重渲染，
       * 在同一次调用里紧接着读 `btn.disabled` 拿到的还是旧值（实测踩过）。
       */
      if (state === 'modelmenu') {
        await win.webContents.executeJavaScript(`
          (() => {
            const st = window.__yanStore.getState();
            window.__yanStore.setState({ session: { ...st.session, isStreaming: false, isCompacting: false } });
            return 'ok';
          })()
        `)
        await wait(350)
      }
      const res = await win.webContents.executeJavaScript(STATES[state])
      if (!String(res).startsWith('ok')) failures.push(`${size}@${pct} ${state}: 状态脚本返回 ${res}`)
      if (String(res) !== 'ok') console.log(`    （${state} 状态脚本：${res}）`)
      await wait(420)
      const geometry = await win.webContents.executeJavaScript(probeGeometry(MUST_HAVE[state] ?? []))
      await shot(`matrix-${state}-${size}-${pct}-${g.theme}-${STAMP}.png`, geometry)
      if (AFTER_STATE[state]) await win.webContents.executeJavaScript(AFTER_STATE[state])
    }
  }

  /* ---- 首次引导（N20）：单独一轮（拆组调试时只有显式要它才跑） ---- */
  if (!WANT_ONBOARDING) {
    console.log('\n（指定了 YAN_MATRIX_GROUP，且不含 onboarding：跳过引导组）')
  } else {
  /*
   * 自动弹的入口在 App 里：`if (window.yan.isProbe) return`（探针模式不弹）。
   * 这里不是探针模式，但隔离环境里 bootstrap 拿不到设置，弹不弹取决于时序；
   * 为了截图稳定，走「关于页 → 查看首次引导」这条**真实存在**的入口，
   * 渲染出来的引导层与首次启动时是同一个组件。
   */
  await win.webContents.executeJavaScript(`try { localStorage.removeItem('yan.onboarded') } catch {}`)
  await win.webContents.reload()
  await wait(600)
  await win.webContents.executeJavaScript(fixture)
  await wait(700)
  const onboardingHow = await win.webContents.executeJavaScript(`
    (() => {
      const st = window.__yanStore.getState();
      st.openSettings('about');
      return 'opened-about';
    })()
  `)
  await wait(600)
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('[data-testid="ob-reopen"]');
      if (btn) btn.click();
      return btn ? 'clicked' : 'no-reopen-button';
    })()
  `)
  await wait(700)
  const onboardingShown = await win.webContents.executeJavaScript(
    `!!document.querySelector('[data-testid="onboarding"]')`
  )
  console.log(`\n引导层：${onboardingHow}，显示=${onboardingShown}`)

  for (const g of ONBOARDING_GROUPS) {
    const size = `${g.w}x${g.h}`
    console.log(`\n▶ onboarding ${size} ${g.theme}`)
    win.setSize(g.w, g.h)
    await wait(260)
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${g.theme}'`)
    await wait(500)
    const geometry = await win.webContents.executeJavaScript(`
      (() => {
        const d = document.documentElement;
        const primary = document.querySelector('[data-testid="onboarding-primary"], .ob-primary, button');
        return {
          sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight,
          uiScale: window.__yanStore.getState().settings?.uiScale ?? null,
          theme: document.documentElement.dataset.theme || '',
          must: { '引导层': !!document.querySelector('[data-testid="onboarding"]'), '主按钮': !!document.querySelector('[data-testid="ob-done"], .ob-btn') }
        };
      })()
    `)
    await shot(`matrix-onboarding-${size}-100-${g.theme}-${STAMP}.png`, geometry)
  }
  }

  cnWidth = Number(cnWidth)
  console.log(`\n${'='.repeat(64)}`)
  console.log(
    cnWidth < 0
      ? '汉字格宽 = 测量超时（字体可能未加载）'
      : `汉字格宽 = ${cnWidth.toFixed(2)}px ${Math.abs(cnWidth - 15) < 0.01 ? '(Maple 已生效)' : '⚠️ 字体未生效'}`
  )
  if (failures.length) {
    console.log(`✗ ${failures.length} 项不通过：`)
    for (const f of failures) console.log('  · ' + f)
  } else {
    console.log('✓ 视觉矩阵通过（溢出与关键元素都正常）')
  }
  console.log(`截图目录：${outDir}`)
  /*
   * 结尾把静音掉的那类日志汇总一行。
   * 为什么不干脆丢掉：那些 handler 缺失是**故意**的（见 muteMissingHandlerNoise 注释），
   * 但它也能解释“某块界面没数据”—— 得留个可查的痕迹。
   */
  const noise = missingHandlerSummary()
  if (noise) {
    console.log(
      `预期内：截图脚本未注册 ${noise.names.length} 个数据型 IPC，Electron 报了 ${noise.total} 条「No handler registered」，已静音`
    )
  }
  app.exit(failures.length === 0 && Math.abs(cnWidth - 15) < 0.01 ? 0 : 1)
}

/*
 * 看门狗：这个脚本会真的开窗口，如果卡在某个 executeJavaScript 上，
 * 外层只能看到“什么也不输出”——加一个自己的超时，把阶段信息带回终端。
 */
const watchdog = setTimeout(() => {
  console.error('✗ 视觉矩阵超时（10 分钟）——最后完成的阶段见上面的输出')
  app.exit(2)
}, 10 * 60_000)

main()
  .then(() => clearTimeout(watchdog))
  .catch((err) => {
    clearTimeout(watchdog)
    console.error('✗ 视觉矩阵失败：', err)
    app.exit(2)
  })
