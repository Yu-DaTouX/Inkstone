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
const STAMP = '2026-09-16'

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
  ipcMain.handle('yan:compactionInfo', () => null)
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
    return {
      path,
      abs: 'C:/work/pi-desktop' + (path ? '/' + path : ''),
      entries: [
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
    states: ['main', 'modelmenu', 'reasoning', 'settings', 'railmini', 'fsnarrow', 'wschanges', 'wsunknown']
  },
  { w: 1440, h: 900, scale: 1, theme: 'light', states: ['main', 'reasoning', 'settings', 'railmini'] },
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
  `
}

/** 每个状态要顺带核对的元素（截图的图不能是空的） */
const MUST_HAVE = {
  main: ['.rail', '.stream', '.composer, [data-testid="composer"]'],
  modelmenu: ['[data-testid="model-picker"]', '[data-testid="model-menu"]'],
  reasoning: ['[data-testid="reasoning-toggle"]'],
  settings: ['.settings'],
  railmini: ['[data-testid="rail-toggle"]'],
  fsnarrow: ['[data-testid="rightpanel"]', '[data-testid="rp-files"]'],
  wschanges: ['[data-testid="workspace-changes"]', '[data-testid="ws-title"]'],
  wsunknown: ['[data-testid="workspace-changes"]', '[data-testid="ws-unknown"]']
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
